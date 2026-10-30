"""POST /v1/ask: a spoken question, the current frame and the app's scene memory in; Muse Spark's
short answer out, with SAM 3.1's box for the thing the answer is about (ARCHITECTURE 7.2).

One Spark attempt bounded by ASK_TIMEOUT_SECONDS, then at most one SAM check on the same frame.
A failed SAM check leaves the target unchecked instead of failing the answer.
"""

from __future__ import annotations

import logging
import time
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.budget import UsageMeter
from app.deps import (
    TokenFirstRoute,
    get_app_settings,
    get_meta_client,
    get_usage_meter,
    require_app_token,
)
from app.errors import ApiError
from app.images import (
    JPEG_DATA_URL_PREFIX,
    ImageTooLargeError,
    InvalidImageError,
    decode_base64_jpeg,
)
from app.meta.ask import QUESTION_PATTERN, AskParseError, build_ask_request, parse_ask_output
from app.meta.client import MetaAPIError, MetaClient
from app.meta.sam import extract_output_text
from app.meta.scene import Band, ContextItem, Position, SceneContext
from app.meta.spark import extract_usage
from app.pricing import estimate_cost
from app.routes.detect import Detection, to_detection
from app.routes.scene import (
    GROUNDED_CONFIDENCE,
    ID_PATTERN,
    MAX_BOXES_PER_ITEM,
    MIN_BOX_CONFIDENCE,
    SceneContextIn,
    locate,
)
from app.routes.upstream import budget_exhausted_error, call_once, to_api_error
from app.settings import Settings

log = logging.getLogger("heynavi.ask")

WHAT = "the answer model"
MAX_OUTPUT_TOKENS = 1500

router = APIRouter(prefix="/v1", route_class=TokenFirstRoute)


class AskRequest(BaseModel):
    image_b64: str = Field(description="Raw base64 JPEG bytes, without a data: prefix")
    session_id: str = Field(pattern=ID_PATTERN)
    question: str = Field(pattern=QUESTION_PATTERN.pattern, max_length=200)
    context: SceneContextIn = Field(default_factory=SceneContextIn)
    # How the phone was held for this frame: the answer uses the same kind of directions.
    hold: Literal["forward", "camera"] = "camera"


class AskTargetOut(BaseModel):
    label: str
    ground: str | None
    visible: bool
    position: Position
    band: Band
    # None: SAM did not check it. True: SAM found it (confidence >= 0.5). False: not found.
    grounded: bool | None = None
    detections: list[Detection] = Field(default_factory=list)


class AskTimings(BaseModel):
    spark: float
    sam: float | None = None
    total: float


class AskUsage(BaseModel):
    input_tokens: int | None
    output_tokens: int | None
    reasoning_tokens: int | None
    sam_images: int = 0
    cost_usd: float


class AskResponse(BaseModel):
    session_id: str
    # None when the model's answer broke the wording rules.
    answer: str | None
    about: AskTargetOut | None
    search: bool
    filtered: list[str]
    timings_ms: AskTimings
    usage: AskUsage


@router.post("/ask", response_model=AskResponse)
async def ask(
    body: AskRequest,
    _: Annotated[None, Depends(require_app_token)],
    settings: Annotated[Settings, Depends(get_app_settings)],
    client: Annotated[MetaClient | None, Depends(get_meta_client)],
    usage: Annotated[UsageMeter, Depends(get_usage_meter)],
) -> AskResponse:
    started = time.perf_counter()
    if client is None:
        raise ApiError(503, "key_not_configured", "MODEL_API_KEY is not set on the server")
    if usage.exhausted():
        raise budget_exhausted_error()
    try:
        decode_base64_jpeg(body.image_b64)
    except ImageTooLargeError as exc:
        raise ApiError(413, "image_too_large", str(exc)) from None
    except InvalidImageError as exc:
        raise ApiError(422, "invalid_request", str(exc)) from None

    context = SceneContext(
        summary=body.context.summary,
        items=tuple(ContextItem(i.label, i.kind, i.position, i.age_s, i.spoken) for i in body.context.items),
    )
    image_url = JPEG_DATA_URL_PREFIX + body.image_b64
    payload = build_ask_request(
        image_url,
        body.question,
        context,
        body.hold,
        model=settings.spark_model,
        reasoning_effort=settings.spark_reasoning_effort,
        max_output_tokens=MAX_OUTPUT_TOKENS,
    )
    spark_started = time.perf_counter()
    try:
        response = await call_once(client, payload, settings.ask_timeout_seconds)
        tokens = extract_usage(response)
        usage.add(input_tokens=tokens["input_tokens"] or 0, output_tokens=tokens["output_tokens"] or 0)
        client.ensure_completed(response)
    except MetaAPIError as exc:
        error = to_api_error(exc, settings.ask_timeout_seconds, WHAT)
        log.warning("ask session=%s failed: meta status=%s code=%s -> %d %s",
                    body.session_id, exc.status, exc.code, error.status_code, error.code)
        raise error from None
    spark_ms = (time.perf_counter() - spark_started) * 1000
    try:
        parsed = parse_ask_output(extract_output_text(response))
    except AskParseError as exc:
        log.warning("ask session=%s unusable output: %s", body.session_id, exc)
        raise ApiError(502, "upstream_error", f"{WHAT} returned an unusable answer") from None

    about: AskTargetOut | None = None
    sam_ms: float | None = None
    sam_images = 0
    if parsed.about is not None:
        about = AskTargetOut(**vars(parsed.about))
        if parsed.about.visible and parsed.about.ground and not usage.exhausted():
            sam_started = time.perf_counter()
            boxes = await locate(client, settings, usage, image_url, parsed.about.ground)
            sam_ms = (time.perf_counter() - sam_started) * 1000
            sam_images = 1
            if boxes is not None:
                shown = [b for b in boxes if b.confidence is not None and b.confidence >= MIN_BOX_CONFIDENCE]
                about.detections = [to_detection(b) for b in shown[:MAX_BOXES_PER_ITEM]]
                about.grounded = bool(shown) and (shown[0].confidence or 0) >= GROUNDED_CONFIDENCE

    total_ms = (time.perf_counter() - started) * 1000
    cost = estimate_cost(sam_images, tokens["input_tokens"] or 0, tokens["output_tokens"] or 0)
    # Timings and counts only: the question and the answer describe the user's surroundings.
    log.info(
        "ask session=%s spark=%.0f ms sam=%s answered=%s about=%s grounded=%s search=%s total=%.0f ms",
        body.session_id, spark_ms, "-" if sam_ms is None else f"{sam_ms:.0f} ms", parsed.answer is not None,
        about is not None, None if about is None else about.grounded, parsed.search, total_ms,
    )
    return AskResponse(
        session_id=body.session_id,
        answer=parsed.answer,
        about=about,
        search=parsed.search,
        filtered=parsed.filtered,
        timings_ms=AskTimings(
            spark=round(spark_ms, 1), sam=None if sam_ms is None else round(sam_ms, 1), total=round(total_ms, 1)
        ),
        usage=AskUsage(
            input_tokens=tokens["input_tokens"],
            output_tokens=tokens["output_tokens"],
            reasoning_tokens=tokens["reasoning_tokens"],
            sam_images=sam_images,
            cost_usd=round(cost, 6),
        ),
    )

"""POST /v1/scene: one camera frame plus the app's short-term scene memory in, Muse Spark's
validated scene reading out (ARCHITECTURE 4), with SAM 3.1 boxes for the objects Spark picked
(ARCHITECTURE 5.2).

The app's scene loop calls this every 4–8 s with one request in flight, so each call makes
exactly one Spark attempt bounded by SCENE_TIMEOUT_SECONDS, then at most `ground` SAM attempts
on the same frame, in parallel, each bounded by SAM_TIMEOUT_SECONDS. A failed SAM check leaves
that item unchecked instead of failing the reply. Nothing here is spoken directly: the app's
attention policy decides what the user hears.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Annotated, Any

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
from app.meta.client import MetaAPIError, MetaClient
from app.meta.sam import SamDetection, build_sam_request, extract_output_text, parse_sam_output
from app.meta.scene import (
    Band,
    Change,
    ContextItem,
    Importance,
    Kind,
    Position,
    SceneContext,
    SceneParseError,
    Status,
    build_scene_request,
    grounding_order,
    parse_scene_output,
)
from app.meta.spark import extract_usage
from app.pricing import estimate_cost
from app.routes.detect import Detection, best_first, to_detection
from app.routes.upstream import budget_exhausted_error, call_once, to_api_error
from app.settings import Settings

log = logging.getLogger("heynavi.scene")

ID_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"
CONTEXT_LABEL_PATTERN = r"^[a-z][a-z -]{0,63}$"
WHAT = "the scene model"
# A SAM box below this confidence is not shown; an item counts as confirmed at GROUNDED_CONFIDENCE.
MIN_BOX_CONFIDENCE = 0.40
GROUNDED_CONFIDENCE = 0.50
MAX_BOXES_PER_ITEM = 3
MAX_GROUND = 4

router = APIRouter(prefix="/v1", route_class=TokenFirstRoute)


class ContextItemIn(BaseModel):
    label: str = Field(pattern=CONTEXT_LABEL_PATTERN)
    kind: Kind
    position: Position
    age_s: int = Field(ge=0, le=3600, strict=True)
    spoken: bool


class SceneContextIn(BaseModel):
    summary: str | None = Field(default=None, max_length=300)
    items: list[ContextItemIn] = Field(default_factory=list, max_length=8)


class SceneRequest(BaseModel):
    image_b64: str = Field(description="Raw base64 JPEG bytes, without a data: prefix")
    session_id: str = Field(pattern=ID_PATTERN)
    frame_id: int = Field(ge=0, strict=True)
    context: SceneContextIn = Field(default_factory=SceneContextIn)
    # The user asked "what's around me": a fuller summary and a few more items.
    detailed: bool = False
    # How many of Spark's items SAM should locate and check on the same frame (0 = none).
    ground: int = Field(default=0, ge=0, le=MAX_GROUND, strict=True)


class SceneItemOut(BaseModel):
    label: str
    count: int
    kind: Kind
    position: Position
    band: Band
    status: Status
    importance: Importance
    ground: str | None
    text: str | None
    # None: SAM did not check it. True: SAM found it (confidence >= 0.5). False: not found.
    grounded: bool | None = None
    # SAM's boxes for `ground` on this frame, best first (empty when unchecked or not found).
    detections: list[Detection] = Field(default_factory=list)


class SceneTimings(BaseModel):
    spark: float
    parse: float
    # Slowest of the parallel SAM checks; None when SAM was not called.
    sam: float | None = None
    total: float


class SceneUsage(BaseModel):
    input_tokens: int | None
    output_tokens: int | None
    reasoning_tokens: int | None
    sam_images: int = 0
    cost_usd: float


class SceneResponse(BaseModel):
    session_id: str
    frame_id: int
    summary: str | None
    change: Change
    items: list[SceneItemOut]
    # Why each dropped sentence, label or text was dropped; reasons only, never the text.
    filtered: list[str]
    timings_ms: SceneTimings
    usage: SceneUsage


@router.post("/scene", response_model=SceneResponse)
async def scene(
    body: SceneRequest,
    _: Annotated[None, Depends(require_app_token)],
    settings: Annotated[Settings, Depends(get_app_settings)],
    client: Annotated[MetaClient | None, Depends(get_meta_client)],
    usage: Annotated[UsageMeter, Depends(get_usage_meter)],
) -> SceneResponse:
    started = time.perf_counter()
    if client is None:
        raise ApiError(503, "key_not_configured", "MODEL_API_KEY is not set on the server")
    if usage.exhausted():
        raise budget_exhausted_error()
    try:
        # Decoded only to validate it; the app's base64 text is forwarded unchanged.
        decode_base64_jpeg(body.image_b64)
    except ImageTooLargeError as exc:
        raise ApiError(413, "image_too_large", str(exc)) from None
    except InvalidImageError as exc:
        raise ApiError(422, "invalid_request", str(exc)) from None

    context = SceneContext(
        summary=body.context.summary,
        items=tuple(
            ContextItem(i.label, i.kind, i.position, i.age_s, i.spoken) for i in body.context.items
        ),
    )
    payload = build_scene_request(
        JPEG_DATA_URL_PREFIX + body.image_b64,
        context,
        model=settings.spark_model,
        reasoning_effort=settings.spark_reasoning_effort,
        max_output_tokens=settings.scene_max_output_tokens,
        detailed=body.detailed,
    )
    spark_started = time.perf_counter()
    try:
        response = await call_once(client, payload, settings.scene_timeout_seconds)
        tokens = extract_usage(response)
        # Billed even when the reply turns out unusable.
        usage.add(input_tokens=tokens["input_tokens"] or 0, output_tokens=tokens["output_tokens"] or 0)
        client.ensure_completed(response)  # "incomplete" means the token cap cut the JSON off
    except MetaAPIError as exc:
        error = to_api_error(exc, settings.scene_timeout_seconds, WHAT)
        log.warning(
            "scene session=%s frame=%d failed after %.0f ms: meta status=%s code=%s -> %d %s",
            body.session_id, body.frame_id, _ms_since(spark_started),
            exc.status, exc.code, error.status_code, error.code,
        )
        raise error from None
    spark_ms = _ms_since(spark_started)

    parse_started = time.perf_counter()
    try:
        parsed = parse_scene_output(extract_output_text(response), detailed=body.detailed)
    except SceneParseError as exc:
        log.warning("scene session=%s frame=%d unusable output: %s", body.session_id, body.frame_id, exc)
        raise ApiError(502, "upstream_error", f"{WHAT} returned an unusable answer") from None
    parse_ms = _ms_since(parse_started)

    items = [SceneItemOut(**vars(item)) for item in parsed.items]
    sam_ms: float | None = None
    sam_images = 0
    order = grounding_order(parsed.items, body.ground)
    if order and not usage.exhausted():
        image_url = JPEG_DATA_URL_PREFIX + body.image_b64
        concepts = list(dict.fromkeys(parsed.items[i].ground for i in order if parsed.items[i].ground))
        sam_started = time.perf_counter()
        results = await _gather_until(
            [_locate(client, settings, usage, image_url, concept) for concept in concepts],
            settings.scene_ground_timeout_seconds,
        )
        sam_ms = _ms_since(sam_started)
        sam_images = len(concepts)
        found = dict(zip(concepts, results, strict=True))
        for i in order:
            boxes = found.get(parsed.items[i].ground or "")
            if boxes is None:
                continue  # the SAM call failed: left unchecked
            shown = [b for b in boxes if b.confidence is not None and b.confidence >= MIN_BOX_CONFIDENCE]
            items[i].detections = [to_detection(b) for b in shown[:MAX_BOXES_PER_ITEM]]
            items[i].grounded = bool(shown) and (shown[0].confidence or 0) >= GROUNDED_CONFIDENCE

    total_ms = _ms_since(started)
    cost = estimate_cost(sam_images, tokens["input_tokens"] or 0, tokens["output_tokens"] or 0)
    # Counts and timings only: the summary and labels describe the user's surroundings.
    log.info(
        "scene session=%s frame=%d spark=%.0f ms change=%s items=%d filtered=%d "
        "tokens in=%s out=%s reasoning=%s sam=%s grounded=%d/%d total=%.0f ms",
        body.session_id, body.frame_id, spark_ms, parsed.change, len(parsed.items),
        len(parsed.filtered), tokens["input_tokens"], tokens["output_tokens"],
        tokens["reasoning_tokens"], "-" if sam_ms is None else f"{sam_ms:.0f} ms",
        sum(1 for item in items if item.grounded), len(order), total_ms,
    )
    return SceneResponse(
        session_id=body.session_id,
        frame_id=body.frame_id,
        summary=parsed.summary,
        change=parsed.change,
        items=items,
        filtered=parsed.filtered,
        timings_ms=SceneTimings(
            spark=round(spark_ms, 1),
            parse=round(parse_ms, 1),
            sam=None if sam_ms is None else round(sam_ms, 1),
            total=round(total_ms, 1),
        ),
        usage=SceneUsage(
            input_tokens=tokens["input_tokens"],
            output_tokens=tokens["output_tokens"],
            reasoning_tokens=tokens["reasoning_tokens"],
            sam_images=sam_images,
            cost_usd=round(cost, 6),
        ),
    )


async def _gather_until(calls: list[Any], timeout: float) -> list[Any]:
    """Results of `calls` that finish within `timeout`; None for the rest (they are cancelled)."""
    tasks = [asyncio.ensure_future(call) for call in calls]
    done, pending = await asyncio.wait(tasks, timeout=timeout)
    for task in pending:
        task.cancel()
    if pending:
        log.info("scene grounding: %d of %d SAM checks past %.1f s, left unchecked", len(pending), len(tasks), timeout)
    return [task.result() if task in done and not task.cancelled() else None for task in tasks]


async def locate(
    client: MetaClient, settings: Settings, usage: UsageMeter, image_url: str, concept: str
) -> list[SamDetection] | None:
    """SAM boxes for one concept on a frame, best first; None when the call failed."""
    return await _locate(client, settings, usage, image_url, concept)


async def _locate(
    client: MetaClient, settings: Settings, usage: UsageMeter, image_url: str, concept: str
) -> list[SamDetection] | None:
    """SAM boxes for one concept on the scene frame, best first; None when the call failed."""
    payload = build_sam_request(concept, image_url, model=settings.sam_model)
    try:
        response = await call_once(client, payload, settings.sam_timeout_seconds)
        client.ensure_completed(response)
    except MetaAPIError as exc:
        if exc.status is not None or exc.code == "timeout":
            usage.add(sam_images=1)  # it may still be billed
        log.warning("scene grounding failed: meta status=%s code=%s", exc.status, exc.code)
        return None
    usage.add(sam_images=1)
    return sorted(parse_sam_output(extract_output_text(response)), key=best_first)


def _ms_since(started: float) -> float:
    return (time.perf_counter() - started) * 1000

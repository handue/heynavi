"""POST /v1/scene: one camera frame plus the app's short-term scene memory in, Muse Spark's
validated scene reading out (ARCHITECTURE 4).

The app's scene loop calls this every 4–8 s with one request in flight, so each call makes
exactly one Meta attempt bounded by SCENE_TIMEOUT_SECONDS. Nothing here is spoken directly:
the app's attention policy decides what the user hears.
"""

from __future__ import annotations

import logging
import time
from typing import Annotated

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
from app.meta.sam import extract_output_text
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
    parse_scene_output,
)
from app.meta.spark import extract_usage
from app.pricing import estimate_cost
from app.routes.upstream import budget_exhausted_error, call_once, to_api_error
from app.settings import Settings

log = logging.getLogger("heynavi.scene")

ID_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"
CONTEXT_LABEL_PATTERN = r"^[a-z][a-z -]{0,63}$"
WHAT = "the scene model"

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


class SceneTimings(BaseModel):
    spark: float
    parse: float
    total: float


class SceneUsage(BaseModel):
    input_tokens: int | None
    output_tokens: int | None
    reasoning_tokens: int | None
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

    total_ms = _ms_since(started)
    cost = estimate_cost(0, tokens["input_tokens"] or 0, tokens["output_tokens"] or 0)
    # Counts and timings only: the summary and labels describe the user's surroundings.
    log.info(
        "scene session=%s frame=%d spark=%.0f ms change=%s items=%d filtered=%d "
        "tokens in=%s out=%s reasoning=%s total=%.0f ms",
        body.session_id, body.frame_id, spark_ms, parsed.change, len(parsed.items),
        len(parsed.filtered), tokens["input_tokens"], tokens["output_tokens"],
        tokens["reasoning_tokens"], total_ms,
    )
    return SceneResponse(
        session_id=body.session_id,
        frame_id=body.frame_id,
        summary=parsed.summary,
        change=parsed.change,
        items=[SceneItemOut(**vars(item)) for item in parsed.items],
        filtered=parsed.filtered,
        timings_ms=SceneTimings(spark=round(spark_ms, 1), parse=round(parse_ms, 1), total=round(total_ms, 1)),
        usage=SceneUsage(
            input_tokens=tokens["input_tokens"],
            output_tokens=tokens["output_tokens"],
            reasoning_tokens=tokens["reasoning_tokens"],
            cost_usd=round(cost, 6),
        ),
    )


def _ms_since(started: float) -> float:
    return (time.perf_counter() - started) * 1000

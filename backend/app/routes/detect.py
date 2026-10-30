"""POST /v1/detect: one camera frame and one concept in, sam-3.1 boxes out.

The app's search loop calls this about once per second with one request in flight, so
each call makes exactly one Meta attempt bounded by SAM_TIMEOUT_SECONDS. A failed frame
is reported at once and the app sends the next one instead of waiting in a back-off.
"""

from __future__ import annotations

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
from app.meta.sam import (
    HorizontalThird,
    SamDetection,
    build_sam_request,
    extract_output_text,
    parse_sam_output,
)
from app.routes.upstream import budget_exhausted_error, call_once, to_api_error
from app.settings import Settings

log = logging.getLogger("heynavi.detect")

CONCEPT_PATTERN = r"^[A-Za-z][A-Za-z -]{0,63}$"
GOAL_ID_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"
router = APIRouter(prefix="/v1", route_class=TokenFirstRoute)


class DetectRequest(BaseModel):
    image_b64: str = Field(description="Raw base64 JPEG bytes, without a data: prefix")
    concept: str = Field(pattern=CONCEPT_PATTERN, description="English noun phrase")
    goal_id: str = Field(pattern=GOAL_ID_PATTERN)
    frame_id: int = Field(ge=0, strict=True)


class ImageSize(BaseModel):
    width: int
    height: int


class Detection(BaseModel):
    box: tuple[float, float, float, float]  # normalized x1, y1, x2, y2; x2/y2 exclusive
    confidence: float | None
    center_x: float
    area: float  # fraction of the frame
    position: HorizontalThird


class Timings(BaseModel):
    sam: float
    parse: float
    total: float


class DetectResponse(BaseModel):
    goal_id: str
    frame_id: int
    concept: str
    image: ImageSize | None  # SAM's view of the frame size; None when nothing was found
    detections: list[Detection]
    timings_ms: Timings


@router.post("/detect", response_model=DetectResponse)
async def detect(
    body: DetectRequest,
    _: Annotated[None, Depends(require_app_token)],
    settings: Annotated[Settings, Depends(get_app_settings)],
    client: Annotated[MetaClient | None, Depends(get_meta_client)],
    usage: Annotated[UsageMeter, Depends(get_usage_meter)],
) -> DetectResponse:
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

    payload = build_sam_request(
        body.concept, JPEG_DATA_URL_PREFIX + body.image_b64, model=settings.sam_model
    )
    sam_started = time.perf_counter()
    try:
        response = await _call_sam(client, payload, settings.sam_timeout_seconds)
        client.ensure_completed(response)  # a "failed" 200 is not a confirmed miss
    except MetaAPIError as exc:
        if exc.status is not None or exc.code == "timeout":
            usage.add(sam_images=1)  # it may still be billed
        error = to_api_error(exc, settings.sam_timeout_seconds, "the detector")
        log.warning(
            "detect goal=%s frame=%d concept=%r failed after %.0f ms: meta status=%s code=%s -> %d %s",
            body.goal_id, body.frame_id, body.concept, _ms_since(sam_started),
            exc.status, exc.code, error.status_code, error.code,
        )
        raise error from None
    sam_ms = _ms_since(sam_started)
    usage.add(sam_images=1)

    parse_started = time.perf_counter()
    found = sorted(parse_sam_output(extract_output_text(response)), key=best_first)
    detections = [to_detection(det) for det in found]
    image = ImageSize(width=found[0].width, height=found[0].height) if found else None
    parse_ms = _ms_since(parse_started)

    total_ms = _ms_since(started)
    best = found[0].confidence if found else None
    log.info(
        "detect goal=%s frame=%d concept=%r sam=%.0f ms detections=%d best=%s total=%.0f ms",
        body.goal_id, body.frame_id, body.concept, sam_ms, len(detections),
        "none" if best is None else f"{best:.2f}", total_ms,
    )
    return DetectResponse(
        goal_id=body.goal_id,
        frame_id=body.frame_id,
        concept=body.concept,
        image=image,
        detections=detections,
        timings_ms=Timings(sam=round(sam_ms, 1), parse=round(parse_ms, 1), total=round(total_ms, 1)),
    )


async def _call_sam(client: MetaClient, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
    return await call_once(client, payload, timeout)


def best_first(det: SamDetection) -> tuple[bool, float]:
    """Highest confidence first; detections without a confidence go last."""
    return (det.confidence is None, -(det.confidence or 0.0))


def to_detection(det: SamDetection) -> Detection:
    return Detection(
        box=det.box_norm,
        confidence=det.confidence,
        center_x=det.center_x,
        area=det.area_fraction,
        position=det.horizontal_third,
    )


def _ms_since(started: float) -> float:
    return (time.perf_counter() - started) * 1000

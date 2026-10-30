"""POST /v1/metrics: the app's metric log lines, for runs where Metro's log is out of reach
(release builds, outdoors). Lines are timings, counts and decisions; the app never puts
coordinates, frames or transcripts in them, and this endpoint does not accept anything else.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Annotated

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field

from app.deps import TokenFirstRoute, get_app_settings, require_app_token
from app.settings import Settings

log = logging.getLogger("heynavi.metrics")

# Only the app's own metric tags; anything else is refused rather than stored.
LINE_PATTERN = r"^\[heynavi-(?:metrics|voice|scene)\] [\x20-\x7e]{1,2000}$"

router = APIRouter(prefix="/v1", route_class=TokenFirstRoute)


class MetricsRequest(BaseModel):
    session_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    lines: list[Annotated[str, Field(pattern=LINE_PATTERN)]] = Field(min_length=1, max_length=100)


@router.post("/metrics", status_code=204, response_class=Response)
async def metrics(
    body: MetricsRequest,
    _: Annotated[None, Depends(require_app_token)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> Response:
    received = time.time()
    for line in body.lines:
        log.info("app %s %s", body.session_id, line)
    if settings.metrics_file is not None:
        try:
            settings.metrics_file.parent.mkdir(parents=True, exist_ok=True)
            with settings.metrics_file.open("a", encoding="utf-8") as out:
                for line in body.lines:
                    out.write(json.dumps({"t": round(received, 3), "session": body.session_id, "line": line}) + "\n")
        except OSError:
            log.warning("could not append to %s", settings.metrics_file)
    return Response(status_code=204)

"""HeyNavi FastAPI app. M0 exposes only GET /health; /v1/* routes arrive in M1."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI, Header
from pydantic import BaseModel

from app import __version__
from app.deps import get_app_settings, get_meta_client, require_app_token
from app.meta.client import MetaAPIError, MetaClient
from app.settings import Settings, load_settings_or_exit

log = logging.getLogger("heynavi")

SERVICE_NAME = "heynavi-backend"

router = APIRouter()


class HealthResponse(BaseModel):
    ok: bool
    service: str
    version: str
    key_configured: bool
    # Present only with ?deep=true. Booleans and an error code only, never key material.
    models_reachable: bool | None = None
    sam_available: bool | None = None
    spark_available: bool | None = None
    error: str | None = None


@router.get("/health", response_model=HealthResponse, response_model_exclude_none=True)
async def health(
    settings: Annotated[Settings, Depends(get_app_settings)],
    client: Annotated[MetaClient | None, Depends(get_meta_client)],
    deep: bool = False,
    x_heynavi_token: Annotated[str | None, Header()] = None,
) -> HealthResponse:
    """Plain /health is public. ?deep=true calls Meta and reveals whether the key and
    models work, so it needs the X-HeyNavi-Token app token (401 otherwise)."""
    result = HealthResponse(
        ok=True, service=SERVICE_NAME, version=__version__, key_configured=settings.key_configured
    )
    if not deep:
        return result
    await require_app_token(settings, x_heynavi_token)
    result.models_reachable = result.sam_available = result.spark_available = False
    if client is None:
        result.error = "key_not_configured"
        return result
    try:
        models = await client.list_models()
    except MetaAPIError as exc:
        log.warning("deep health check failed: status=%s code=%s", exc.status, exc.code)
        result.error = exc.code
        return result
    result.models_reachable = True
    result.sam_available = settings.sam_model in models
    result.spark_available = settings.spark_model in models
    return result


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the app. Settings are resolved at startup, so importing this module never
    reads backend/.env; tests pass their own Settings."""

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # An invalid value in backend/.env stops startup with exit code 2 and a message
        # that names the file and the setting, never the value.
        resolved = settings or load_settings_or_exit()
        logging.basicConfig(level=resolved.log_level)
        log.setLevel(resolved.log_level)
        client = MetaClient.from_settings(resolved) if resolved.key_configured else None
        if client is None:
            log.warning("MODEL_API_KEY is not set; Meta calls are disabled (see backend/README.md)")
        app.state.settings = resolved
        app.state.meta_client = client
        try:
            yield
        finally:
            if client is not None:
                await client.aclose()

    app = FastAPI(title="HeyNavi backend", version=__version__, lifespan=lifespan)
    app.include_router(router)
    return app


app = create_app()

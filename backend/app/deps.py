"""Shared FastAPI dependencies. Kept out of main.py so future route modules can import
them without importing the app itself."""

from __future__ import annotations

import secrets
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request, status

from app.meta.client import MetaClient
from app.settings import Settings


def get_app_settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def get_meta_client(request: Request) -> MetaClient | None:
    """None when MODEL_API_KEY is not configured."""
    client: MetaClient | None = request.app.state.meta_client
    return client


async def require_app_token(
    settings: Annotated[Settings, Depends(get_app_settings)],
    x_heynavi_token: Annotated[str | None, Header()] = None,
) -> None:
    """Reject the request unless X-HeyNavi-Token matches HEYNAVI_APP_TOKEN.

    Fails closed: if no token is configured on the server, every request is rejected.
    """
    expected = settings.heynavi_app_token
    if (
        expected is None
        or not settings.app_token_configured
        or x_heynavi_token is None
        or not secrets.compare_digest(
            x_heynavi_token.encode("utf-8"), expected.get_secret_value().encode("utf-8")
        )
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid or missing app token"
        )

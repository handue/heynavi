"""Shared FastAPI dependencies. Kept out of main.py so future route modules can import
them without importing the app itself."""

from __future__ import annotations

import secrets
from collections.abc import Callable, Coroutine
from typing import Annotated, Any

from fastapi import Depends, Header, Request, Response
from fastapi.routing import APIRoute

from app.budget import UsageMeter
from app.errors import ApiError
from app.meta.client import MetaClient
from app.settings import Settings

APP_TOKEN_HEADER = "x-heynavi-token"


def get_app_settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def get_meta_client(request: Request) -> MetaClient | None:
    """None when MODEL_API_KEY is not configured."""
    client: MetaClient | None = request.app.state.meta_client
    return client


def get_usage_meter(request: Request) -> UsageMeter:
    meter: UsageMeter = request.app.state.usage_meter
    return meter


def check_app_token(settings: Settings, token: str | None) -> None:
    """Raise 401 unless token matches HEYNAVI_APP_TOKEN.

    Fails closed: if no token is configured on the server, every request is rejected.
    """
    expected = settings.heynavi_app_token
    if (
        expected is None
        or not settings.app_token_configured
        or token is None
        or not secrets.compare_digest(
            token.encode("utf-8"), expected.get_secret_value().encode("utf-8")
        )
    ):
        raise ApiError(401, "unauthorized", "invalid or missing app token")


async def require_app_token(
    settings: Annotated[Settings, Depends(get_app_settings)],
    x_heynavi_token: Annotated[str | None, Header()] = None,
) -> None:
    """Reject the request unless X-HeyNavi-Token matches HEYNAVI_APP_TOKEN."""
    check_app_token(settings, x_heynavi_token)


class TokenFirstRoute(APIRoute):
    """Checks X-HeyNavi-Token before FastAPI reads and parses the request body, which it
    otherwise does before running any dependency. An unauthenticated client then gets
    401 without the server buffering its upload, and malformed JSON without a token is
    401 too. Routes still declare require_app_token, which documents the header."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def token_first(request: Request) -> Response:
            check_app_token(get_app_settings(request), request.headers.get(APP_TOKEN_HEADER))
            return await handler(request)

        return token_first

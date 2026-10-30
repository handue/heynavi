"""Shared handling of one interactive Meta call: a single attempt under a total deadline, and
the mapping of its failure onto our contract errors. Used by /v1/detect and /v1/scene, whose
app loops send the next frame instead of waiting in a back-off."""

from __future__ import annotations

import asyncio
import math
import re
from typing import Any

from app.errors import ApiError
from app.meta.client import MetaAPIError, MetaClient

# Upper bound for a Retry-After passed on from Meta to the app.
MAX_RETRY_AFTER_SECONDS = 3600
_SAFE_CODE = re.compile(r"[A-Za-z0-9_.-]{1,80}")
# Our own contract codes; a Meta code spelled the same must not pass for one of them.
CONTRACT_CODES = frozenset(
    {"unauthorized", "invalid_request", "image_too_large", "key_not_configured",
     "timeout", "rate_limited", "upstream_error", "budget_exhausted"}
)


async def call_once(client: MetaClient, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
    """One attempt, no retry. httpx timeouts apply per phase (connect, write, read), so
    asyncio.timeout also caps the whole call at the same budget."""
    try:
        async with asyncio.timeout(timeout):
            return await client.create_response(payload, timeout=timeout, retry=False)
    except TimeoutError:
        pass
    # Raised outside the except block so the cancelled httpx call is not chained onto it.
    raise MetaAPIError(None, "timeout", "deadline exceeded")


def to_api_error(exc: MetaAPIError, timeout: float, what: str) -> ApiError:
    """Contract errors with our own messages: never Meta's message or body. `what` names the
    model in the message ("the detector")."""
    if exc.code == "timeout":
        return ApiError(504, "timeout", f"{what} did not answer within {timeout:g} s")
    if exc.status == 429:
        headers = None
        if exc.retry_after is not None and math.isfinite(exc.retry_after):
            seconds = math.ceil(min(exc.retry_after, MAX_RETRY_AFTER_SECONDS))
            headers = {"Retry-After": str(seconds)}
        return ApiError(429, "rate_limited", f"{what} is rate limited; try again shortly", headers)
    if exc.code == "network_error":
        return ApiError(502, "upstream_error", f"{what} could not be reached")
    if (
        not exc.code_from_body  # Meta's error.type, or a code MetaClient made up
        or exc.code in CONTRACT_CODES
        or not _SAFE_CODE.fullmatch(exc.code)
    ):
        return ApiError(502, "upstream_error", f"{what} returned an unusable answer")
    return ApiError(502, exc.code, f"{what} could not process this frame")


def budget_exhausted_error() -> ApiError:
    return ApiError(
        503, "budget_exhausted", "today's spending limit for model calls is reached (DAILY_BUDGET_USD)"
    )

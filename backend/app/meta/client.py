"""Async client for the Meta Model API: one shared, keep-alive httpx.AsyncClient.

Privacy rules enforced here: request bodies (which carry camera frames) and the API
key are never logged or put into exception text. httpx/h11 exceptions are never chained
onto MetaAPIError either, because their text can quote the Authorization header.
"""

from __future__ import annotations

import asyncio
import logging
import math
import random
import time
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from types import TracebackType
from typing import Any, Self

import httpx

from app import __version__
from app.settings import Settings

log = logging.getLogger("heynavi.meta")

RETRYABLE_STATUSES = frozenset({429, 503})
MAX_RETRY_WAIT_SECONDS = 5.0
DEFAULT_RETRY_WAIT_SECONDS = 1.0
MAX_JITTER_SECONDS = 0.25
_MAX_MESSAGE_CHARS = 300

Sleep = Callable[[float], Awaitable[None]]


class MetaAPIError(Exception):
    """A failed Meta API call. `status` is None when no HTTP response arrived.

    `code_from_body` is True only when `code` is Meta's own error.code; otherwise it is
    Meta's error.type or a code made up here (http_<status>, timeout, network_error, ...).
    """

    def __init__(
        self,
        status: int | None,
        code: str,
        message: str,
        retry_after: float | None = None,
        *,
        code_from_body: bool = False,
    ) -> None:
        shown_status = status if status is not None else "no-response"
        super().__init__(f"Meta API error ({shown_status}, {code}): {message}")
        self.status = status
        self.code = code
        self.message = message
        self.retry_after = retry_after
        self.code_from_body = code_from_body

    def __repr__(self) -> str:
        return (
            f"MetaAPIError(status={self.status!r}, code={self.code!r}, "
            f"message={self.message!r}, retry_after={self.retry_after!r}, "
            f"code_from_body={self.code_from_body!r})"
        )


class MetaClient:
    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        timeout_seconds: float,
        transport: httpx.AsyncBaseTransport | None = None,
        sleep: Sleep = asyncio.sleep,
    ) -> None:
        if not api_key.strip():
            raise ValueError("api_key is empty")
        self._api_key = api_key  # kept only to scrub it from error text
        self._sleep = sleep
        # HTTP attempts made by the most recent call (2 means it was retried after a
        # back-off). Only meaningful for sequential callers such as the benchmark.
        self.last_attempts = 0
        self._http = httpx.AsyncClient(
            base_url=base_url,
            headers={
                "Authorization": f"Bearer {api_key}",
                "User-Agent": f"heynavi-backend/{__version__}",
            },
            timeout=httpx.Timeout(timeout_seconds, connect=min(timeout_seconds, 5.0)),
            limits=httpx.Limits(
                max_connections=20, max_keepalive_connections=10, keepalive_expiry=60.0
            ),
            transport=transport,
        )

    @classmethod
    def from_settings(cls, settings: Settings, **kwargs: Any) -> Self:
        if settings.model_api_key is None or not settings.key_configured:
            raise ValueError("MODEL_API_KEY is not configured")
        return cls(
            api_key=settings.model_api_key.get_secret_value().strip(),
            base_url=settings.meta_api_base_url,
            timeout_seconds=settings.meta_timeout_seconds,
            **kwargs,
        )

    async def list_models(self) -> list[str]:
        return parse_model_ids(await self.models_response())

    async def models_response(self) -> Any:
        """The raw JSON body of GET /models (a model list, no secrets)."""
        return await self._request("GET", "/models")

    async def create_response(
        self, payload: dict[str, Any], *, timeout: float | None = None, retry: bool = True
    ) -> dict[str, Any]:
        """retry=False makes exactly one attempt, for interactive callers that must not
        sit in a back-off (the per-frame /v1/detect loop just sends the next frame)."""
        return _require_object(
            await self._request("POST", "/responses", payload, timeout, retry=retry)
        )

    async def chat_completion(
        self, payload: dict[str, Any], *, timeout: float | None = None
    ) -> dict[str, Any]:
        return _require_object(
            await self._request("POST", "/chat/completions", payload, timeout)
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        await self.aclose()

    async def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        timeout: float | None = None,
        *,
        retry: bool = True,
    ) -> Any:
        request_timeout = httpx.USE_CLIENT_DEFAULT if timeout is None else timeout
        max_attempts = 2 if retry else 1
        for attempt in range(1, max_attempts + 1):
            self.last_attempts = attempt
            started = time.perf_counter()
            failure: MetaAPIError | None = None
            try:
                response = await self._http.request(
                    method, path, json=payload, timeout=request_timeout
                )
            except httpx.TimeoutException as exc:
                failure = MetaAPIError(None, "timeout", type(exc).__name__)
            except httpx.DecodingError as exc:
                failure = MetaAPIError(None, "invalid_response", type(exc).__name__)
            except httpx.RequestError as exc:  # every other transport/protocol/redirect error
                failure = MetaAPIError(None, "network_error", type(exc).__name__)
            if failure is not None:
                # Raised outside the except block and "from None": the httpx/h11 exception
                # (whose text can contain the Authorization header) is neither __cause__
                # nor __context__, so it never shows up in a traceback.
                raise failure from None

            elapsed_ms = (time.perf_counter() - started) * 1000
            log.info(
                "meta %s %s -> %d in %.0f ms (attempt %d)",
                method, path, response.status_code, elapsed_ms, attempt,
            )
            if response.is_success:
                try:
                    return response.json()
                except ValueError:
                    pass
                raise MetaAPIError(
                    response.status_code, "invalid_response", "response body is not JSON"
                ) from None

            error = self._to_error(response)
            # Retry exactly once, only for documented transient statuses. 504 and other
            # 4xx are never retried: an unchanged retry would fail the same way.
            if attempt < max_attempts and response.status_code in RETRYABLE_STATUSES:
                base = error.retry_after if error.retry_after is not None else DEFAULT_RETRY_WAIT_SECONDS
                wait = min(base, MAX_RETRY_WAIT_SECONDS) + random.uniform(0, MAX_JITTER_SECONDS)
                log.warning("meta %s %s got %d, retrying once in %.2f s", method, path, response.status_code, wait)
                await self._sleep(wait)
                continue
            raise error
        raise AssertionError("unreachable")

    def ensure_completed(self, body: dict[str, Any]) -> None:
        """A 200 Responses object can still report a failure in its own "status" and
        "error" fields; raise MetaAPIError for those instead of treating them as output."""
        status = body.get("status")
        error = body.get("error")
        if status in (None, "completed") and not error:
            return
        shown = str(status)[:40]
        raise self._error_from(200, error, f"response_{shown}", f"response status {shown}")

    def _to_error(self, response: httpx.Response) -> MetaAPIError:
        status = response.status_code
        try:
            body: Any = response.json()
        except ValueError:
            body = None
        err = body.get("error", body) if isinstance(body, dict) else None
        return self._error_from(
            status,
            err,
            f"http_{status}",
            response.reason_phrase or "request failed",
            parse_retry_after(response.headers.get("retry-after")),
        )

    def _error_from(
        self,
        status: int,
        err: Any,
        fallback_code: str,
        fallback_message: str,
        retry_after: float | None = None,
    ) -> MetaAPIError:
        code, message, code_from_body = fallback_code, fallback_message, False
        if isinstance(err, dict):
            if err.get("code"):
                code, code_from_body = str(err["code"]), True
            elif err.get("type"):
                code = str(err["type"])  # diagnostics only; never passed on as Meta's code
            message = str(err.get("message") or message)
        elif isinstance(err, str):
            message = err
        return MetaAPIError(
            status,
            self._scrub(code)[:80],
            self._scrub(message)[:_MAX_MESSAGE_CHARS],
            retry_after,
            code_from_body=code_from_body,
        )

    def _scrub(self, text: str) -> str:
        return text.replace(self._api_key, "[redacted]")


def parse_retry_after(value: str | None) -> float | None:
    """Retry-After is either delta-seconds or an HTTP date. Non-finite numbers ("inf",
    "1e400", "nan") count as absent."""
    if value is None or not value.strip():
        return None
    try:
        seconds = float(value)
    except ValueError:
        pass
    else:
        return max(0.0, seconds) if math.isfinite(seconds) else None
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return max(0.0, (when - datetime.now(timezone.utc)).total_seconds())


def parse_model_ids(body: Any) -> list[str]:
    """Accepts OpenAI-style {"data": [{"id": ...}]} plus a few defensive variants."""
    items = body
    if isinstance(body, dict):
        items = body.get("data", body.get("models"))
    if not isinstance(items, list):
        return []
    ids: list[str] = []
    for item in items:
        if isinstance(item, str):
            ids.append(item)
        elif isinstance(item, dict) and isinstance(item.get("id"), str):
            ids.append(item["id"])
    return ids


def _require_object(body: Any) -> dict[str, Any]:
    if not isinstance(body, dict):
        raise MetaAPIError(None, "invalid_response", "expected a JSON object")
    return body

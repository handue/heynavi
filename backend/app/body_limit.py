"""Request body size cap, enforced while the body arrives, before FastAPI buffers and
parses it.

Starlette's RequestBodyLimitMiddleware answers a declared oversized Content-Length with
a plain-text 413; this one raises ApiError, so the client gets the contract JSON body.
"""

from __future__ import annotations

from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.errors import ApiError


class BodySizeLimitMiddleware:
    def __init__(self, app: ASGIApp, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        declared = _content_length(scope)
        received = 0

        async def limited_receive() -> Message:
            # Raised from inside the route's body read, which FastAPI re-raises as an
            # HTTPException, so the ApiError handler renders it.
            nonlocal received
            if declared is not None and declared > self.max_bytes:
                raise self._too_large()
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    raise self._too_large()
            return message

        await self.app(scope, limited_receive, send)

    def _too_large(self) -> ApiError:
        return ApiError(413, "image_too_large", f"request body is larger than {self.max_bytes:,} bytes")


def _content_length(scope: Scope) -> int | None:
    try:
        return int(Headers(scope=scope)["content-length"])
    except (KeyError, ValueError):
        return None

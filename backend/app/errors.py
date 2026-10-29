"""Contract error bodies: {"error": {"code": str, "message": str}}.

Messages are written here, never copied from request input (camera frames, tokens) or
from upstream response bodies.
"""

from __future__ import annotations

from http import HTTPStatus
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

_MAX_LISTED_ERRORS = 3
_FRAMEWORK_CODES = {404: "not_found", 405: "method_not_allowed"}


class ApiError(HTTPException):
    """An HTTPException with a stable machine-readable code.

    Subclassing HTTPException keeps the status code right even in an app without
    install_error_handlers (FastAPI then renders it as {"detail": message}).
    """

    def __init__(
        self, status_code: int, code: str, message: str, headers: dict[str, str] | None = None
    ) -> None:
        super().__init__(status_code=status_code, detail=message, headers=headers)
        self.code = code
        self.message = message


def error_body(code: str, message: str) -> dict[str, Any]:
    return {"error": {"code": code, "message": message}}


def validation_message(exc: RequestValidationError) -> str:
    """Field locations and pydantic's messages only. FastAPI's default 422 body also
    echoes each rejected value ("input"), which for /v1/detect is the whole camera frame."""
    errors = exc.errors()
    parts: list[str] = []
    for error in errors[:_MAX_LISTED_ERRORS]:
        if error.get("type") == "json_invalid":  # its loc is a character offset
            parts.append("body: not valid JSON")
            continue
        loc = ".".join(str(part) for part in error.get("loc", ()) if part != "body")
        parts.append(f"{loc or 'body'}: {error.get('msg', 'invalid value')}")
    if len(errors) > _MAX_LISTED_ERRORS:
        parts.append(f"{len(errors) - _MAX_LISTED_ERRORS} more")
    return "; ".join(parts) or "invalid request"


async def _api_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, ApiError)
    return JSONResponse(
        error_body(exc.code, exc.message), status_code=exc.status_code, headers=exc.headers
    )


async def _validation_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, RequestValidationError)
    return JSONResponse(error_body("invalid_request", validation_message(exc)), status_code=422)


async def _framework_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    """HTTPExceptions raised by FastAPI/Starlette themselves (not ApiError), in the
    contract shape. Their detail text is not used, only the status."""
    assert isinstance(exc, StarletteHTTPException)
    if exc.status_code == 400:
        # FastAPI's "error parsing the body": a body json.loads rejects with something
        # other than JSONDecodeError (invalid UTF-8, a 5000-digit integer, deep nesting).
        return JSONResponse(error_body("invalid_request", "body: could not be parsed"), status_code=422)
    try:
        message = HTTPStatus(exc.status_code).phrase
    except ValueError:
        message = "request failed"
    code = _FRAMEWORK_CODES.get(exc.status_code, "http_error")
    return JSONResponse(error_body(code, message), status_code=exc.status_code, headers=exc.headers)


def install_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(ApiError, _api_error_handler)
    app.add_exception_handler(RequestValidationError, _validation_error_handler)
    # Replaces FastAPI's default {"detail": ...} rendering; ApiError keeps its own handler.
    app.add_exception_handler(StarletteHTTPException, _framework_error_handler)

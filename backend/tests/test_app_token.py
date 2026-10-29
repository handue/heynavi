from __future__ import annotations

from typing import Annotated

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.deps import require_app_token
from tests.conftest import make_settings

TOKEN = "s3cr3t-app-token"


def protected_app(app_token: str | None) -> TestClient:
    """A test-only app with one route behind require_app_token."""
    app = FastAPI()
    app.state.settings = make_settings(heynavi_app_token=app_token)

    @app.get("/protected")
    async def protected(_: Annotated[None, Depends(require_app_token)]) -> dict[str, bool]:
        return {"ok": True}

    return TestClient(app)


def test_correct_token_is_accepted() -> None:
    response = protected_app(TOKEN).get("/protected", headers={"X-HeyNavi-Token": TOKEN})
    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_header_name_is_case_insensitive() -> None:
    response = protected_app(TOKEN).get("/protected", headers={"x-heynavi-token": TOKEN})
    assert response.status_code == 200


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"X-HeyNavi-Token": ""},
        {"X-HeyNavi-Token": "wrong"},
        {"X-HeyNavi-Token": TOKEN + "x"},
        {"X-HeyNavi-Token": TOKEN[:-1]},
        {"X-HeyNavi-Token": "café".encode()},  # non-ASCII must not crash compare_digest
    ],
)
def test_wrong_or_missing_token_is_rejected(headers: dict[str, str | bytes]) -> None:
    response = protected_app(TOKEN).get("/protected", headers=headers)
    assert response.status_code == 401
    assert TOKEN not in response.text


@pytest.mark.parametrize("configured", [None, "", "   "])
def test_unset_server_token_rejects_everything(configured: str | None) -> None:
    client = protected_app(configured)
    assert client.get("/protected").status_code == 401
    assert client.get("/protected", headers={"X-HeyNavi-Token": configured or ""}).status_code == 401

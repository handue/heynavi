from __future__ import annotations

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from app.main import create_app
from tests.conftest import BASE_URL, TEST_KEY, make_settings

APP_TOKEN = "health-app-token-123"
AUTH = {"X-HeyNavi-Token": APP_TOKEN}


def test_health_without_key() -> None:
    with TestClient(create_app(make_settings())) as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "service": "heynavi-backend",
        "version": "0.1.0",
        "key_configured": False,
    }


def test_plain_health_is_public_and_booleans_only() -> None:
    settings = make_settings(model_api_key=TEST_KEY, heynavi_app_token=APP_TOKEN)
    with respx.mock(assert_all_called=False) as router, TestClient(create_app(settings)) as client:
        response = client.get("/health")  # no token
        assert not router.calls
    assert response.status_code == 200
    assert response.json() == {"ok": True, "service": "heynavi-backend", "version": "0.1.0", "key_configured": True}


@pytest.mark.parametrize(
    ("server_token", "headers"),
    [
        (APP_TOKEN, {}),
        (APP_TOKEN, {"X-HeyNavi-Token": "wrong"}),
        (None, {}),  # fails closed when the server has no token
        (None, {"X-HeyNavi-Token": ""}),
    ],
)
def test_deep_health_requires_app_token(server_token: str | None, headers: dict[str, str]) -> None:
    settings = make_settings(model_api_key=TEST_KEY, heynavi_app_token=server_token)
    with respx.mock(base_url=BASE_URL, assert_all_called=False) as router, TestClient(create_app(settings)) as client:
        route = router.get("/models").respond(200, json={"data": [{"id": "sam-3.1"}]})
        response = client.get("/health?deep=true", headers=headers)
        assert not route.called  # Meta is never called without a valid token
    assert response.status_code == 401
    assert "sam_available" not in response.text
    assert TEST_KEY not in response.text and APP_TOKEN not in response.text


def test_deep_health_without_key_reports_false_without_calling_meta() -> None:
    settings = make_settings(heynavi_app_token=APP_TOKEN)
    with respx.mock(assert_all_called=False) as router, TestClient(create_app(settings)) as client:
        body = client.get("/health", params={"deep": "true"}, headers=AUTH).json()
        assert not router.calls
    assert body["key_configured"] is False
    assert body["models_reachable"] is False
    assert body["sam_available"] is False
    assert body["spark_available"] is False
    assert body["error"] == "key_not_configured"


def test_deep_health_with_key_checks_models() -> None:
    settings = make_settings(model_api_key=TEST_KEY, heynavi_app_token=APP_TOKEN)
    with respx.mock(base_url=BASE_URL) as router, TestClient(create_app(settings)) as client:
        route = router.get("/models").respond(200, json={"data": [{"id": "sam-3.1"}, {"id": "muse-spark-1.3"}]})
        shallow = client.get("/health")
        assert not route.called  # plain /health never calls Meta
        response = client.get("/health?deep=true", headers=AUTH)
    body = response.json()
    assert body == {
        "ok": True,
        "service": "heynavi-backend",
        "version": "0.1.0",
        "key_configured": True,
        "models_reachable": True,
        "sam_available": True,
        "spark_available": True,
    }
    assert shallow.json()["key_configured"] is True
    assert TEST_KEY not in response.text


def test_deep_health_reports_missing_model() -> None:
    settings = make_settings(model_api_key=TEST_KEY, heynavi_app_token=APP_TOKEN)
    with respx.mock(base_url=BASE_URL) as router, TestClient(create_app(settings)) as client:
        router.get("/models").respond(200, json={"data": [{"id": "sam-3.1"}]})
        body = client.get("/health?deep=true", headers=AUTH).json()
    assert (body["models_reachable"], body["sam_available"], body["spark_available"]) == (True, True, False)


def test_deep_health_on_meta_error_reports_code_only() -> None:
    settings = make_settings(model_api_key=TEST_KEY, heynavi_app_token=APP_TOKEN)
    with respx.mock(base_url=BASE_URL) as router, TestClient(create_app(settings)) as client:
        router.get("/models").respond(
            401, json={"error": {"code": "invalid_api_key", "message": f"bad key {TEST_KEY}"}}
        )
        response = client.get("/health?deep=true", headers=AUTH)
    body = response.json()
    assert response.status_code == 200
    assert body["models_reachable"] is False
    assert body["sam_available"] is False and body["spark_available"] is False
    assert body["error"] == "invalid_api_key"
    assert TEST_KEY not in response.text


def test_deep_health_on_network_error() -> None:
    settings = make_settings(model_api_key=TEST_KEY, heynavi_app_token=APP_TOKEN)
    with respx.mock(base_url=BASE_URL) as router, TestClient(create_app(settings)) as client:
        router.get("/models").mock(side_effect=httpx.ConnectError("down"))
        body = client.get("/health?deep=true", headers=AUTH).json()
    assert (body["models_reachable"], body["error"]) == (False, "network_error")


def test_registered_routes() -> None:
    paths = create_app(make_settings()).openapi()["paths"]
    assert set(paths) == {"/health", "/v1/detect", "/v1/scene", "/v1/metrics"}
    for path in ("/v1/detect", "/v1/scene", "/v1/metrics"):
        assert set(paths[path]) == {"post"}


def test_deep_health_401_uses_contract_error_shape() -> None:
    settings = make_settings(model_api_key=TEST_KEY, heynavi_app_token=APP_TOKEN)
    with respx.mock(assert_all_called=False), TestClient(create_app(settings)) as client:
        response = client.get("/health?deep=true", headers={"X-HeyNavi-Token": "wrong"})
    assert response.status_code == 401
    assert response.json() == {"error": {"code": "unauthorized", "message": "invalid or missing app token"}}

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from app.images import JPEG_DATA_URL_PREFIX, make_synthetic_jpeg
from app.main import create_app
from app.meta.ask import ASK_SCHEMA, AskParseError, build_ask_request, parse_ask_output
from app.meta.scene import SceneContext
from tests.conftest import BASE_URL, TEST_KEY, make_settings

APP_TOKEN = "ask-app-token-321"
AUTH = {"X-HeyNavi-Token": APP_TOKEN}
JPEG_B64 = make_synthetic_jpeg(96).data_url[len(JPEG_DATA_URL_PREFIX) :]
W, H = 640, 360


def answer_json(**overrides: Any) -> str:
    about = {"label": "entrance", "ground": "door", "visible": True, "position": "right", "band": "middle"}
    body = {"answer": "There is an entrance ahead on your right.", "about": about, "search": False}
    body.update(overrides)
    return json.dumps(body)


def response_body(text: str, usage: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "id": "resp_x",
        "object": "response",
        "status": "completed",
        "store": False,
        "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text, "annotations": []}]}],
        "usage": usage or {"input_tokens": 1500, "output_tokens": 300, "output_tokens_details": {"reasoning_tokens": 200}},
    }


def sam_box(x1: int, y1: int, x2: int, y2: int, c: float) -> str:
    return f"<0f>0<|box;x1={x1};y1={y1};x2={x2};y2={y2};w={W};h={H};c={c}|>"


def ask_body(**overrides: Any) -> dict[str, Any]:
    return {"image_b64": JPEG_B64, "session_id": "s1", "question": "where is the entrance", "hold": "forward", **overrides}


@pytest.fixture
def meta() -> Iterator[respx.MockRouter]:
    with respx.mock(base_url=BASE_URL, assert_all_called=False) as router:
        yield router


def app_client(**settings: Any) -> TestClient:
    defaults: dict[str, Any] = {"model_api_key": TEST_KEY, "heynavi_app_token": APP_TOKEN}
    return TestClient(create_app(make_settings(**{**defaults, **settings})))


def mock(meta: respx.MockRouter, spark_text: str, sam_text: str | None = None) -> list[dict[str, Any]]:
    sent: list[dict[str, Any]] = []

    def respond(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        sent.append(payload)
        if payload["model"] == "sam-3.1":
            if sam_text is None:
                return httpx.Response(503, json={"error": {"message": "busy", "type": "server_error"}})
            return httpx.Response(200, json=response_body(sam_text, {"images_processed": 1}))
        return httpx.Response(200, json=response_body(spark_text))

    meta.post("/responses").mock(side_effect=respond)
    return sent


def test_request_frames_positions_by_how_the_phone_is_held() -> None:
    forward = build_ask_request("data:x", "where is the door", SceneContext(), "forward", model="m", reasoning_effort="minimal", max_output_tokens=9)
    camera = build_ask_request("data:x", "where is the door", SceneContext(), "camera", model="m", reasoning_effort="minimal", max_output_tokens=9)
    assert "ahead on your left" in forward["input"][0]["content"][0]["text"]
    assert "of the camera view" in camera["input"][0]["content"][0]["text"]
    assert forward["store"] is False and forward["text"]["format"]["schema"] is ASK_SCHEMA
    assert forward["input"][1]["content"][0]["text"].endswith("The user asks: where is the door")


def test_parser_filters_unsafe_answers_and_requires_a_target_to_search() -> None:
    assert parse_ask_output(answer_json(answer="The path is clear, you can walk ahead.")).answer is None
    assert parse_ask_output(answer_json(answer="It is about 3 meters away.")).filtered == ["answer_distance"]
    not_visible = parse_ask_output(answer_json(about={"label": "entrance", "ground": "door", "visible": False, "position": "center", "band": "middle"}, search=True))
    assert not_visible.search is True
    general = parse_ask_output(answer_json(about={"label": "", "ground": "", "visible": False, "position": "center", "band": "middle"}, search=True))
    assert general.about is None and general.search is False
    with pytest.raises(AskParseError):
        parse_ask_output("I see a door")


def test_route_answers_and_checks_the_target_with_sam(meta: respx.MockRouter) -> None:
    sent = mock(meta, answer_json(), sam_box(450, 100, 620, 340, 0.92))
    with app_client() as c:
        response = c.post("/v1/ask", json=ask_body(), headers=AUTH)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["answer"] == "There is an entrance ahead on your right."
    assert body["about"]["grounded"] is True and body["about"]["detections"][0]["position"] == "right"
    assert body["search"] is False
    assert body["usage"]["sam_images"] == 1
    assert [p["model"] for p in sent] == ["muse-spark-1.3", "sam-3.1"]
    assert sent[1]["input"][0]["content"][0]["text"] == "door"
    assert APP_TOKEN not in response.text and JPEG_B64 not in response.text


def test_route_hands_off_a_search_when_the_thing_is_not_visible(meta: respx.MockRouter) -> None:
    about = {"label": "entrance", "ground": "door", "visible": False, "position": "center", "band": "middle"}
    sent = mock(meta, answer_json(answer="I don't see an entrance right now.", about=about, search=True))
    with app_client() as c:
        body = c.post("/v1/ask", json=ask_body(), headers=AUTH).json()
    assert body["search"] is True and body["about"]["ground"] == "door"
    assert [p["model"] for p in sent] == ["muse-spark-1.3"], "no SAM call for something not visible"


def test_a_failed_sam_check_leaves_the_answer(meta: respx.MockRouter) -> None:
    mock(meta, answer_json(), sam_text=None)
    with app_client() as c:
        body = c.post("/v1/ask", json=ask_body(), headers=AUTH).json()
    assert body["answer"] and body["about"]["grounded"] is None


@pytest.mark.parametrize("overrides", [{"question": "x" * 201}, {"question": "<script>"}, {"hold": "sideways"}, {"session_id": "a b"}])
def test_route_rejects_bad_requests(meta: respx.MockRouter, overrides: dict[str, Any]) -> None:
    with app_client() as c:
        assert c.post("/v1/ask", json=ask_body(**overrides), headers=AUTH).status_code == 422


def test_route_requires_the_token(meta: respx.MockRouter) -> None:
    with app_client() as c:
        assert c.post("/v1/ask", json=ask_body()).status_code == 401

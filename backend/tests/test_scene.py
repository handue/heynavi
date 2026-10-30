from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from app.images import JPEG_DATA_URL_PREFIX, make_synthetic_jpeg
from app.main import create_app
from app.meta.scene import (
    SCENE_SCHEMA,
    ContextItem,
    SceneContext,
    SceneParseError,
    build_scene_request,
    context_notes,
    parse_scene_output,
)
from tests.conftest import BASE_URL, TEST_KEY, make_settings

APP_TOKEN = "scene-app-token-789"
AUTH = {"X-HeyNavi-Token": APP_TOKEN}
JPEG_B64 = make_synthetic_jpeg(96).data_url[len(JPEG_DATA_URL_PREFIX) :]


def item(**overrides: Any) -> dict[str, Any]:
    return {
        "label": "office chair",
        "count": 1,
        "kind": "possible_obstacle",
        "position": "center",
        "band": "lower",
        "status": "new",
        "importance": "high",
        "ground": "chair",
        "text": "",
        **overrides,
    }


def scene_json(**overrides: Any) -> str:
    return json.dumps({"summary": "A hallway with a door on the right.", "change": "major", "items": [item()], **overrides})


def spark_body(text: str, *, status: str = "completed", usage: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "id": "resp_scene",
        "object": "response",
        "status": status,
        "store": False,
        "output": [
            {"type": "reasoning", "summary": []},
            {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": text, "annotations": []}],
            },
        ],
        "usage": usage
        if usage is not None
        else {"input_tokens": 1600, "output_tokens": 500, "output_tokens_details": {"reasoning_tokens": 400}},
    }


def scene_body(**overrides: Any) -> dict[str, Any]:
    return {"image_b64": JPEG_B64, "session_id": "sess-1", "frame_id": 3, **overrides}


@pytest.fixture
def meta() -> Iterator[respx.MockRouter]:
    with respx.mock(base_url=BASE_URL, assert_all_called=False) as router:
        yield router


def app_client(**settings: Any) -> TestClient:
    defaults: dict[str, Any] = {"model_api_key": TEST_KEY, "heynavi_app_token": APP_TOKEN}
    return TestClient(create_app(make_settings(**{**defaults, **settings})))


@pytest.fixture
def client(meta: respx.MockRouter) -> Iterator[TestClient]:
    with app_client() as c:
        yield c


def assert_error(response: httpx.Response, status: int, code: str) -> None:
    assert response.status_code == status
    assert response.json()["error"]["code"] == code
    for secret in (TEST_KEY, APP_TOKEN, JPEG_B64):
        assert secret not in response.text


# ---------- request builder ----------


def test_request_uses_responses_with_store_false_and_a_strict_schema() -> None:
    payload = build_scene_request(
        "data:image/jpeg;base64,AAAA",
        SceneContext(),
        model="muse-spark-1.3",
        reasoning_effort="minimal",
        max_output_tokens=1200,
    )
    assert payload["store"] is False
    assert payload["model"] == "muse-spark-1.3"
    assert payload["reasoning"] == {"effort": "minimal"}
    assert payload["max_output_tokens"] == 1200
    fmt = payload["text"]["format"]
    assert fmt["type"] == "json_schema" and fmt["strict"] is True and fmt["schema"] is SCENE_SCHEMA
    developer, user = payload["input"]
    assert developer["role"] == "developer"
    assert "Never give distances" in developer["content"][0]["text"]
    assert "at most 15 words" in developer["content"][0]["text"]
    assert user["role"] == "user"
    assert user["content"][1] == {"type": "input_image", "image_url": "data:image/jpeg;base64,AAAA"}
    assert "first look" in user["content"][0]["text"]


def test_detailed_requests_ask_for_more() -> None:
    payload = build_scene_request(
        "data:image/jpeg;base64,AAAA", SceneContext(), model="m", reasoning_effort="minimal",
        max_output_tokens=900, detailed=True,
    )
    assert "at most 35 words" in payload["input"][0]["content"][0]["text"]
    assert "asked what is around them" in payload["input"][1]["content"][0]["text"]


def test_schema_is_strict_everywhere() -> None:
    def walk(node: dict[str, Any]) -> None:
        if node.get("type") == "object":
            assert node["additionalProperties"] is False
            assert sorted(node["required"]) == sorted(node["properties"])
            for child in node["properties"].values():
                walk(child)
        if node.get("type") == "array":
            walk(node["items"])

    walk(SCENE_SCHEMA)


def test_context_notes_list_memory_compactly() -> None:
    notes = context_notes(
        SceneContext(
            summary="A hallway.",
            items=(ContextItem("open door", "landmark", "right", 4, True), ContextItem("box", "possible_obstacle", "center", 9, False)),
        )
    )
    assert notes.splitlines() == [
        "Notes from the last few seconds:",
        "- last summary: A hallway.",
        "- open door (landmark, right, seen 4 s ago, already told the user)",
        "- box (possible obstacle, center, seen 9 s ago, not told yet)",
    ]


# ---------- parser ----------


def test_parses_a_valid_reply() -> None:
    parsed = parse_scene_output(scene_json())
    assert parsed.summary == "A hallway with a door on the right."
    assert parsed.change == "major"
    assert [i.label for i in parsed.items] == ["office chair"]
    assert parsed.items[0].ground == "chair" and parsed.items[0].text is None
    assert parsed.filtered == []


def test_drops_bad_items_and_sentences_but_keeps_the_rest() -> None:
    parsed = parse_scene_output(
        json.dumps(
            {
                "summary": "The path is clear for about 3 meters.",
                "change": "minor",
                "items": [
                    item(label="Chair!!"),
                    item(label="clear path"),
                    item(label="door", kind="landmark", position="sideways"),
                    item(label="Open  Door", kind="landmark", ground="door"),
                    item(label="open door", kind="landmark"),  # duplicate label
                    item(label="sign", kind="text", text="EXIT", ground=""),
                    item(label="poster", kind="text", text="Safe zone"),
                    item(label="box", count=0, ground="Box!!"),
                    "not an item",
                ],
            }
        )
    )
    assert parsed.summary is None
    assert [i.label for i in parsed.items] == ["open door", "sign", "poster", "box"]
    assert parsed.filtered == [
        "summary_distance",
        "invalid_label",
        "label_safety",
        "invalid_enum",
        "text_filtered",
        "invalid_ground",
    ]  # the fourth valid item fills the list, so "not an item" is never looked at


def test_text_items_keep_verbatim_text_unless_it_breaks_the_rules() -> None:
    parsed = parse_scene_output(
        scene_json(
            items=[
                item(label="sign", kind="text", text="  EXIT  ", ground=""),
                item(label="poster", kind="text", text="Safe zone", ground=""),
                item(label="crate", count=0, ground="Box!!"),
            ]
        )
    )
    by_label = {i.label: i for i in parsed.items}
    assert by_label["sign"].text == "EXIT" and by_label["sign"].ground is None
    assert by_label["poster"].text is None
    assert by_label["crate"].count == 1 and by_label["crate"].ground is None
    assert "text_filtered" in parsed.filtered and "invalid_ground" in parsed.filtered


def test_caps_items_and_counts() -> None:
    many = [item(label=f"thing {chr(97 + i)}", count=99) for i in range(9)]
    assert len(parse_scene_output(scene_json(items=many)).items) == 4
    detailed = parse_scene_output(scene_json(items=many), detailed=True)
    assert len(detailed.items) == 6
    assert detailed.items[0].count == 20


def test_overlong_summary_is_dropped() -> None:
    parsed = parse_scene_output(scene_json(summary=" ".join(["word"] * 25)))
    assert parsed.summary is None and parsed.filtered == ["summary_too_long"]


@pytest.mark.parametrize("text", ["not json", "[]", json.dumps({"summary": "x", "items": []}), json.dumps({"summary": "x", "change": "huge", "items": []})])
def test_unusable_output_raises(text: str) -> None:
    with pytest.raises(SceneParseError):
        parse_scene_output(text)


# ---------- route ----------


def test_route_returns_the_validated_scene(client: TestClient, meta: respx.MockRouter) -> None:
    route = meta.post("/responses").mock(return_value=httpx.Response(200, json=spark_body(scene_json())))
    context = {
        "summary": "A hallway.",
        "items": [{"label": "open door", "kind": "landmark", "position": "right", "age_s": 4, "spoken": True}],
    }
    response = client.post("/v1/scene", json=scene_body(context=context), headers=AUTH)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["session_id"] == "sess-1" and body["frame_id"] == 3
    assert body["summary"] == "A hallway with a door on the right."
    assert body["items"] == [
        {
            "label": "office chair",
            "count": 1,
            "kind": "possible_obstacle",
            "position": "center",
            "band": "lower",
            "status": "new",
            "importance": "high",
            "ground": "chair",
            "text": None,
        }
    ]
    assert body["usage"]["input_tokens"] == 1600 and body["usage"]["reasoning_tokens"] == 400
    assert body["usage"]["cost_usd"] == pytest.approx(1600 * 1.25e-6 + 500 * 4.25e-6, abs=1e-6)
    assert set(body["timings_ms"]) == {"spark", "parse", "total"}

    sent = json.loads(route.calls.last.request.content)
    assert sent["store"] is False
    assert sent["input"][1]["content"][1]["image_url"] == JPEG_DATA_URL_PREFIX + JPEG_B64
    assert "open door (landmark, right, seen 4 s ago, already told the user)" in sent["input"][1]["content"][0]["text"]


def test_route_requires_the_app_token(client: TestClient, meta: respx.MockRouter) -> None:
    route = meta.post("/responses")
    assert_error(client.post("/v1/scene", json=scene_body()), 401, "unauthorized")
    assert not route.called


@pytest.mark.parametrize(
    "overrides",
    [
        {"session_id": "has space"},
        {"frame_id": -1},
        {"context": {"items": [{"label": "Door!", "kind": "landmark", "position": "right", "age_s": 1, "spoken": False}]}},
        {"context": {"summary": "x" * 301}},
        {"image_b64": "not base64 at all!"},
    ],
)
def test_route_rejects_bad_requests(client: TestClient, meta: respx.MockRouter, overrides: dict[str, Any]) -> None:
    route = meta.post("/responses")
    assert_error(client.post("/v1/scene", json=scene_body(**overrides), headers=AUTH), 422, "invalid_request")
    assert not route.called


def test_route_maps_an_incomplete_reply_to_upstream_error(client: TestClient, meta: respx.MockRouter) -> None:
    meta.post("/responses").mock(return_value=httpx.Response(200, json=spark_body('{"summary": "A hall', status="incomplete")))
    assert_error(client.post("/v1/scene", json=scene_body(), headers=AUTH), 502, "upstream_error")


def test_route_maps_unparseable_output_to_upstream_error(client: TestClient, meta: respx.MockRouter) -> None:
    meta.post("/responses").mock(return_value=httpx.Response(200, json=spark_body("I see a hallway.")))
    assert_error(client.post("/v1/scene", json=scene_body(), headers=AUTH), 502, "upstream_error")


def test_route_passes_on_rate_limits(client: TestClient, meta: respx.MockRouter) -> None:
    meta.post("/responses").mock(
        return_value=httpx.Response(429, json={"error": {"message": "slow down", "code": "rate_limit"}}, headers={"Retry-After": "7"})
    )
    response = client.post("/v1/scene", json=scene_body(), headers=AUTH)
    assert_error(response, 429, "rate_limited")
    assert response.headers["Retry-After"] == "7"


def test_route_without_a_key_is_503(meta: respx.MockRouter) -> None:
    with app_client(model_api_key=None) as c:
        assert_error(c.post("/v1/scene", json=scene_body(), headers=AUTH), 503, "key_not_configured")


def test_spending_guard_stops_scene_and_detect_calls(meta: respx.MockRouter, tmp_path: Path) -> None:
    route = meta.post("/responses").mock(
        return_value=httpx.Response(200, json=spark_body(scene_json(), usage={"input_tokens": 4000, "output_tokens": 2000}))
    )
    # One call costs 0.005 + 0.0085 = 0.0135 USD.
    with app_client(daily_budget_usd=0.01, usage_file=tmp_path / "usage.json") as c:
        assert c.post("/v1/scene", json=scene_body(), headers=AUTH).status_code == 200
        assert_error(c.post("/v1/scene", json=scene_body(frame_id=4), headers=AUTH), 503, "budget_exhausted")
        detect = {"image_b64": JPEG_B64, "concept": "chair", "goal_id": "g", "frame_id": 1}
        assert_error(c.post("/v1/detect", json=detect, headers=AUTH), 503, "budget_exhausted")
    assert route.call_count == 1
    assert json.loads((tmp_path / "usage.json").read_text())["spark_output_tokens"] == 2000

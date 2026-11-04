from __future__ import annotations

import asyncio
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
    ROUTE_NEXTS,
    SCENE_SCHEMA,
    RouteHint,
    route_note,
    clean_label,
    SceneItem,
    grounding_order,
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


def test_a_route_note_says_what_matters_more_and_no_place() -> None:
    def user_text(route: RouteHint | None) -> str:
        payload = build_scene_request(
            "data:x", SceneContext(), model="m", reasoning_effort="minimal", max_output_tokens=9, route=route
        )
        return payload["input"][1]["content"][0]["text"]

    assert "walking directions" not in user_text(None)
    left = user_text(RouteHint("left", True))
    assert "The next turn is to the left, coming up soon." in left
    assert "crosswalks, curbs and intersections matter more" in left
    assert "never give directions" in left
    assert "coming up soon" not in user_text(RouteHint("straight", True))
    assert "Entrances, doors, steps" in user_text(RouteHint("arrive", False))
    for nxt in ROUTE_NEXTS:
        assert route_note(RouteHint(nxt, True)) in user_text(RouteHint(nxt, True))
    # The fixed instructions do not change with the route, so the prompt cache keeps working.
    with_route = build_scene_request("data:x", SceneContext(), model="m", reasoning_effort="minimal",
                                     max_output_tokens=9, route=RouteHint("right", False))
    without = build_scene_request("data:x", SceneContext(), model="m", reasoning_effort="minimal", max_output_tokens=9)
    assert with_route["input"][0] == without["input"][0]


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
    assert [i.label for i in parsed.items] == ["open door", "sign", "poster"]
    assert parsed.filtered == [
        "summary_distance",
        "invalid_label",
        "label_safety",
        "invalid_enum",
        "text_filtered",
    ]  # the third valid item fills the list, so the rest is never looked at


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
    assert len(parse_scene_output(scene_json(items=many)).items) == 3
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
            "grounded": None,
            "detections": [],
        }
    ]
    assert body["timings_ms"]["sam"] is None and body["usage"]["sam_images"] == 0
    assert body["usage"]["input_tokens"] == 1600 and body["usage"]["reasoning_tokens"] == 400
    assert body["usage"]["cost_usd"] == pytest.approx(1600 * 1.25e-6 + 500 * 4.25e-6, abs=1e-6)
    assert set(body["timings_ms"]) == {"spark", "parse", "sam", "total"}

    sent = json.loads(route.calls.last.request.content)
    assert sent["store"] is False
    assert sent["input"][1]["content"][1]["image_url"] == JPEG_DATA_URL_PREFIX + JPEG_B64
    assert "open door (landmark, right, seen 4 s ago, already told the user)" in sent["input"][1]["content"][0]["text"]


def test_route_passes_the_route_hint_to_spark(client: TestClient, meta: respx.MockRouter) -> None:
    route = meta.post("/responses").mock(return_value=httpx.Response(200, json=spark_body(scene_json())))
    response = client.post("/v1/scene", json=scene_body(route={"next": "right", "soon": True}), headers=AUTH)
    assert response.status_code == 200, response.text
    sent = json.loads(route.calls.last.request.content)
    assert "The next turn is to the right, coming up soon." in sent["input"][1]["content"][0]["text"]


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
        {"route": {"next": "Sejong-daero", "soon": True}},
        {"route": {"next": "left"}},
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


# ---------- grounding (SAM checks Spark's items) ----------

W, H = 768, 432


def sam_body(text: str) -> dict[str, Any]:
    return {
        "id": "resp_sam",
        "object": "response",
        "status": "completed",
        "store": False,
        "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text, "annotations": []}]}],
        "usage": {"images_processed": 1},
    }


def sam_box(x1: int, y1: int, x2: int, y2: int, c: float) -> str:
    return f"<0f>0<|box;x1={x1};y1={y1};x2={x2};y2={y2};w={W};h={H};c={c}|>"


def test_grounding_order_prefers_important_physical_items() -> None:
    def si(label: str, **kw: Any) -> SceneItem:
        base = dict(label=label, count=1, kind="object", position="center", band="middle", status="new",
                    importance="medium", ground=label, text=None)
        return SceneItem(**{**base, **kw})

    items = [
        si("lamp", importance="low"),
        si("sign", kind="text", ground=None, importance="high"),
        si("table"),
        si("box", kind="possible_obstacle", importance="high"),
        si("door", kind="landmark", importance="high"),
        si("bag", status="gone", importance="high"),
        si("haze", ground=None),
    ]
    # Walking-relevant kinds only: the table and the lamp are plain objects, the sign is text.
    assert grounding_order(items, 3) == [3, 4]
    assert grounding_order(items, 0) == []
    steps = si("steps", kind="level_change", importance="medium")
    sign_post = si("sign post", kind="overhead", importance="high")
    side_person = si("person", kind="person", importance="low")
    assert grounding_order([steps, sign_post, side_person], 4) == [1, 0]


def test_route_checks_the_top_items_with_sam_on_the_same_frame(meta: respx.MockRouter) -> None:
    spark = scene_json(
        items=[
            item(label="office chair", ground="chair", kind="possible_obstacle", importance="high"),
            item(label="desk", ground="desk", kind="possible_obstacle", importance="medium", band="middle"),
            item(label="unicorn", ground="unicorn", kind="possible_obstacle", importance="medium"),
            item(label="lamp", ground="lamp", kind="object", importance="low"),
        ]
    )
    sam_texts = {
        "chair": sam_box(500, 250, 700, 430, 0.91) + "," + sam_box(10, 200, 100, 300, 0.45),
        "desk": sam_box(0, 100, 200, 300, 0.42),
        "unicorn": "",
    }
    seen: list[str] = []

    def respond(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        if payload["model"] == "sam-3.1":
            assert payload["store"] is False
            concept = payload["input"][0]["content"][0]["text"]
            seen.append(concept)
            assert payload["input"][0]["content"][1]["image_url"] == JPEG_DATA_URL_PREFIX + JPEG_B64
            return httpx.Response(200, json=sam_body(sam_texts[concept]))
        return httpx.Response(200, json=spark_body(spark))

    meta.post("/responses").mock(side_effect=respond)
    with app_client() as c:
        body = c.post("/v1/scene", json=scene_body(ground=3), headers=AUTH).json()
    assert sorted(seen) == ["chair", "desk", "unicorn"]
    by_label = {i["label"]: i for i in body["items"]}
    chair = by_label["office chair"]
    assert chair["grounded"] is True
    assert [d["position"] for d in chair["detections"]] == ["right", "left"]
    assert chair["detections"][0]["confidence"] == 0.91
    assert by_label["desk"]["grounded"] is False  # seen, but below 0.5
    assert len(by_label["desk"]["detections"]) == 1
    assert by_label["unicorn"]["grounded"] is False and by_label["unicorn"]["detections"] == []
    assert "lamp" not in by_label  # a fourth item is beyond the 3-item cap
    assert body["usage"]["sam_images"] == 3
    assert body["usage"]["cost_usd"] == pytest.approx(1600 * 1.25e-6 + 500 * 4.25e-6 + 3 * 0.0025, abs=1e-6)
    assert body["timings_ms"]["sam"] is not None


def test_a_failed_sam_check_leaves_the_item_unchecked(meta: respx.MockRouter) -> None:
    spark = scene_json(items=[item(label="chair", ground="chair"), item(label="box", ground="box", importance="medium")])

    def respond(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        if payload["model"] == "sam-3.1":
            if payload["input"][0]["content"][0]["text"] == "chair":
                return httpx.Response(503, json={"error": {"message": "busy", "type": "server_error"}})
            return httpx.Response(200, json=sam_body(sam_box(300, 300, 400, 420, 0.8)))
        return httpx.Response(200, json=spark_body(spark))

    meta.post("/responses").mock(side_effect=respond)
    with app_client() as c:
        response = c.post("/v1/scene", json=scene_body(ground=2), headers=AUTH)
    assert response.status_code == 200
    by_label = {i["label"]: i for i in response.json()["items"]}
    assert by_label["chair"]["grounded"] is None
    assert by_label["box"]["grounded"] is True


def test_items_sharing_a_concept_share_one_sam_call(meta: respx.MockRouter) -> None:
    spark = scene_json(items=[item(label="office chair", ground="chair"), item(label="side chair", ground="chair", importance="medium")])
    calls: list[str] = []

    def respond(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        if payload["model"] == "sam-3.1":
            calls.append(payload["input"][0]["content"][0]["text"])
            return httpx.Response(200, json=sam_body(sam_box(10, 10, 200, 200, 0.9)))
        return httpx.Response(200, json=spark_body(spark))

    meta.post("/responses").mock(side_effect=respond)
    with app_client() as c:
        body = c.post("/v1/scene", json=scene_body(ground=4), headers=AUTH).json()
    assert calls == ["chair"]
    assert all(i["grounded"] for i in body["items"])
    assert body["usage"]["sam_images"] == 1


def test_ground_is_bounded(client: TestClient, meta: respx.MockRouter) -> None:
    assert_error(client.post("/v1/scene", json=scene_body(ground=5), headers=AUTH), 422, "invalid_request")


# ---------- walking relevance (M3, after round 3) ----------


def test_prompt_asks_for_walking_relevance_not_interesting_objects() -> None:
    text = build_scene_request("data:x", SceneContext(), model="m", reasoning_effort="minimal", max_output_tokens=9)[
        "input"
    ][0]["content"][0]["text"]
    for phrase in ("could get in the way", "changes in floor level", "low-hanging", "pictures and wall decorations",
                   "things standing on desks", "not from a fixed", "never screens, pictures or decorations"):
        assert phrase in text, phrase
    assert set(SCENE_SCHEMA["properties"]["items"]["items"]["properties"]["kind"]["enum"]) >= {"level_change", "overhead"}


def test_labels_lose_their_place() -> None:
    assert clean_label("Clothing on floor") == "clothing"
    assert clean_label("bag  next to door") == "bag"
    assert clean_label("on ramp") == "on ramp"  # a leading word is kept
    parsed = parse_scene_output(scene_json(items=[item(label="clothing on floor", count=3)]))
    assert parsed.items[0].label == "clothing"


def test_new_walking_kinds_parse() -> None:
    parsed = parse_scene_output(
        scene_json(items=[item(label="steps", kind="level_change"), item(label="branch", kind="overhead", band="upper")])
    )
    assert [i.kind for i in parsed.items] == ["level_change", "overhead"]


def test_slow_sam_checks_are_left_unchecked(meta: respx.MockRouter) -> None:
    spark = scene_json(items=[item(label="chair", ground="chair"), item(label="box", ground="box", importance="medium")])

    async def respond(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        if payload["model"] == "sam-3.1":
            if payload["input"][0]["content"][0]["text"] == "chair":
                await asyncio.sleep(1.0)
            return httpx.Response(200, json=sam_body(sam_box(300, 300, 400, 420, 0.8)))
        return httpx.Response(200, json=spark_body(spark))

    meta.post("/responses").mock(side_effect=respond)
    with app_client(scene_ground_timeout_seconds=0.3) as c:
        body = c.post("/v1/scene", json=scene_body(ground=2), headers=AUTH).json()
    by_label = {i["label"]: i for i in body["items"]}
    assert by_label["chair"]["grounded"] is None
    assert by_label["box"]["grounded"] is True
    assert body["timings_ms"]["sam"] < 900

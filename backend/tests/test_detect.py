from __future__ import annotations

import asyncio
import base64
import json
import logging
import random
import time
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from app.images import JPEG_DATA_URL_PREFIX, MAX_UPLOAD_JPEG_BYTES, make_synthetic_jpeg
from app.main import MAX_REQUEST_BODY_BYTES, create_app
from app.meta.client import MetaAPIError, MetaClient
from app.routes.detect import _call_sam
from tests.conftest import BASE_URL, TEST_KEY, make_settings

APP_TOKEN = "detect-app-token-456"
AUTH = {"X-HeyNavi-Token": APP_TOKEN}
# A real JPEG, so the image string is long and distinctive enough to search for in output.
JPEG_B64 = make_synthetic_jpeg(96).data_url[len(JPEG_DATA_URL_PREFIX) :]
W, H = 540, 960
MASK = "<|mask;x=0;y=0;c=0.9;data=!a,b<c|>"


def box(x1: int, y1: int, x2: int, y2: int, c: float | None) -> str:
    conf = f";c={c}" if c is not None else ""
    return f"<|box;x1={x1};y1={y1};x2={x2};y2={y2};w={W};h={H}{conf}|>"


def sam_body(text: str) -> dict[str, Any]:
    return {
        "id": "resp_1",
        "object": "response",
        "status": "completed",
        "store": False,
        "output": [
            {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": text, "annotations": []}],
            }
        ],
        "usage": {"images_processed": 1},
    }


def detect_body(**overrides: Any) -> dict[str, Any]:
    return {"image_b64": JPEG_B64, "concept": "chair", "goal_id": "goal-1", "frame_id": 7, **overrides}


def meta_error(code: str, message: str = "upstream says no") -> dict[str, Any]:
    return {"error": {"message": message, "type": "invalid_request_error", "code": code}}


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
    body = response.json()
    assert set(body) == {"error"} and set(body["error"]) == {"code", "message"}
    assert body["error"]["code"] == code
    assert isinstance(body["error"]["message"], str) and body["error"]["message"]
    for secret in (TEST_KEY, APP_TOKEN, JPEG_B64):
        assert secret not in response.text


def test_success_sorts_normalizes_and_positions(client: TestClient, meta: respx.MockRouter) -> None:
    text = (
        f"<0f>0{box(400, 100, 519, 299, 0.45)}{MASK}"  # right
        f",1{box(10, 500, 129, 899, 0.91)}{MASK}"  # left
        f",2{box(220, 0, 319, 959, None)}{MASK}"  # center, no confidence
        f",3{box(200, 300, 339, 599, 0.62)}{MASK}"  # center
    )
    route = meta.post("/responses").respond(200, json=sam_body(text))
    response = client.post("/v1/detect", json=detect_body(), headers=AUTH)

    assert response.status_code == 200
    body = response.json()
    assert (body["goal_id"], body["frame_id"], body["concept"]) == ("goal-1", 7, "chair")
    assert body["image"] == {"width": W, "height": H}
    dets = body["detections"]
    assert [d["confidence"] for d in dets] == [0.91, 0.62, 0.45, None]
    assert [d["position"] for d in dets] == ["left", "center", "right", "center"]
    best = dets[0]
    assert best["box"] == pytest.approx([10 / W, 500 / H, 130 / W, 900 / H])
    assert best["center_x"] == pytest.approx((10 + 130) / 2 / W)
    assert best["area"] == pytest.approx((120 / W) * (400 / H))
    assert set(best) == {"box", "confidence", "center_x", "area", "position"}
    assert dets[3]["box"] == pytest.approx([220 / W, 0.0, 320 / W, 1.0])
    for det in dets:
        assert all(0.0 <= v <= 1.0 for v in det["box"])
    timings = body["timings_ms"]
    assert set(timings) == {"sam", "parse", "total"}
    assert all(isinstance(v, (int, float)) and v >= 0 for v in timings.values())
    assert timings["total"] >= timings["sam"]
    assert route.call_count == 1


def test_request_sent_to_meta(client: TestClient, meta: respx.MockRouter) -> None:
    route = meta.post("/responses").respond(200, json=sam_body(""))
    client.post("/v1/detect", json=detect_body(concept="water bottle"), headers=AUTH)
    request = route.calls.last.request
    assert request.headers["Authorization"] == f"Bearer {TEST_KEY}"
    sent = json.loads(request.content)
    assert sent["store"] is False
    assert sent["model"] == "sam-3.1"
    assert sent["metadata"]["include_confidence"] == "true"
    text_part, image_part = sent["input"][0]["content"]
    assert text_part == {"type": "input_text", "text": "water bottle"}
    assert image_part == {"type": "input_image", "image_url": JPEG_DATA_URL_PREFIX + JPEG_B64}


def test_sam_model_setting_is_used(meta: respx.MockRouter) -> None:
    route = meta.post("/responses").respond(200, json=sam_body(""))
    with app_client(sam_model="sam-test") as client:
        assert client.post("/v1/detect", json=detect_body(), headers=AUTH).status_code == 200
    assert json.loads(route.calls.last.request.content)["model"] == "sam-test"


@pytest.mark.parametrize("output", [sam_body(""), sam_body("<0f>"), {"id": "r", "output": []}])
def test_no_match_means_empty_detections_and_null_image(
    client: TestClient, meta: respx.MockRouter, output: dict[str, Any]
) -> None:
    meta.post("/responses").respond(200, json=output)
    response = client.post("/v1/detect", json=detect_body(frame_id=0), headers=AUTH)
    assert response.status_code == 200
    body = response.json()
    assert body["detections"] == []
    assert body["image"] is None
    assert body["frame_id"] == 0


@pytest.mark.parametrize("headers", [{}, {"X-HeyNavi-Token": ""}, {"X-HeyNavi-Token": "wrong"}])
def test_missing_or_wrong_token_is_401(
    client: TestClient, meta: respx.MockRouter, headers: dict[str, str]
) -> None:
    route = meta.post("/responses").respond(200, json=sam_body(""))
    response = client.post("/v1/detect", json=detect_body(), headers=headers)
    assert_error(response, 401, "unauthorized")
    assert not route.called


def test_token_is_checked_before_body_validation(client: TestClient, meta: respx.MockRouter) -> None:
    response = client.post("/v1/detect", json=detect_body(concept="42"), headers={"X-HeyNavi-Token": "wrong"})
    assert_error(response, 401, "unauthorized")
    assert not meta.calls


def test_server_without_token_rejects(meta: respx.MockRouter) -> None:
    with app_client(heynavi_app_token=None) as client:
        response = client.post("/v1/detect", json=detect_body(), headers=AUTH)
    assert_error(response, 401, "unauthorized")
    assert not meta.calls


PNG_B64 = base64.b64encode(b"\x89PNG\r\n\x1a\n" + bytes(64)).decode()


@pytest.mark.parametrize(
    "overrides",
    [
        {"image_b64": JPEG_B64[:-1]},  # broken padding
        {"image_b64": JPEG_B64[:40] + "\n" + JPEG_B64[40:]},  # whitespace inside
        {"image_b64": JPEG_B64.replace("/", "_").replace("+", "-")},  # URL-safe alphabet
        {"image_b64": JPEG_DATA_URL_PREFIX + JPEG_B64},  # data: prefix
        {"image_b64": PNG_B64},  # valid base64, not a JPEG
        {"image_b64": ""},
        {"image_b64": 123},
        {"concept": ""},
        {"concept": " chair"},
        {"concept": "chair2"},
        {"concept": "chair\n"},
        {"concept": "의자"},
        {"concept": "c" * 65},
        {"goal_id": ""},
        {"goal_id": "goal 1"},
        {"goal_id": "../etc"},
        {"goal_id": "g" * 65},
        {"frame_id": -1},
        {"frame_id": "3"},
        {"frame_id": 1.5},
        {"frame_id": True},
        {"frame_id": None},
    ],
)
def test_invalid_request_is_422_without_echoing_the_image(
    client: TestClient, meta: respx.MockRouter, overrides: dict[str, Any]
) -> None:
    response = client.post("/v1/detect", json=detect_body(**overrides), headers=AUTH)
    assert_error(response, 422, "invalid_request")
    submitted = overrides.get("image_b64", JPEG_B64)
    if isinstance(submitted, str) and submitted:
        assert submitted not in response.text
    assert JPEG_B64[:64] not in response.text
    assert not meta.calls


@pytest.mark.parametrize("missing", ["image_b64", "concept", "goal_id", "frame_id"])
def test_missing_field_is_422_and_names_it(client: TestClient, missing: str) -> None:
    body = detect_body()
    del body[missing]
    response = client.post("/v1/detect", json=body, headers=AUTH)
    assert_error(response, 422, "invalid_request")
    assert missing in response.json()["error"]["message"]


def test_concept_boundaries_are_accepted(client: TestClient, meta: respx.MockRouter) -> None:
    meta.post("/responses").respond(200, json=sam_body(""))
    for concept in ("a", "Water-Bottle", "c" * 64, "dining table"):
        response = client.post("/v1/detect", json=detect_body(concept=concept, goal_id="A_b-9" * 12), headers=AUTH)
        assert response.status_code == 200, concept


def test_malformed_json_is_422_without_echo(client: TestClient, meta: respx.MockRouter) -> None:
    raw = '{"image_b64": "' + JPEG_B64 + '", "concept": oops}'
    response = client.post(
        "/v1/detect", content=raw, headers={**AUTH, "Content-Type": "application/json"}
    )
    assert_error(response, 422, "invalid_request")
    assert response.json()["error"]["message"] == "body: not valid JSON"
    assert not meta.calls


def test_malformed_json_without_token_is_401(client: TestClient, meta: respx.MockRouter) -> None:
    response = client.post("/v1/detect", content=b"{not json", headers={"Content-Type": "application/json"})
    assert_error(response, 401, "unauthorized")
    assert not meta.calls


def test_unauthenticated_body_is_never_read(client: TestClient, meta: respx.MockRouter) -> None:
    read = False

    def chunks() -> Iterator[bytes]:
        nonlocal read
        read = True
        yield b"x" * (MAX_REQUEST_BODY_BYTES + 1)

    response = client.post(
        "/v1/detect", content=chunks(), headers={"Content-Type": "application/json", "X-HeyNavi-Token": "wrong"}
    )
    assert_error(response, 401, "unauthorized")
    assert not read
    assert not meta.calls


@pytest.mark.parametrize("chunked", [False, True])
def test_oversized_body_is_413_before_it_is_parsed(
    client: TestClient, meta: respx.MockRouter, chunked: bool
) -> None:
    # Not JSON at all: a 422 here would mean the body was buffered and parsed.
    raw = b"x" * (MAX_REQUEST_BODY_BYTES + 1)
    content: bytes | Iterator[bytes] = iter([raw]) if chunked else raw
    response = client.post("/v1/detect", content=content, headers={**AUTH, "Content-Type": "application/json"})
    assert_error(response, 413, "image_too_large")
    assert not meta.calls


def test_body_limit_leaves_room_for_the_largest_image_with_escaped_slashes(
    client: TestClient, meta: respx.MockRouter
) -> None:
    meta.post("/responses").respond(200, json=sam_body(""))
    # Entropy-coded JPEG data is close to random, so about 1 in 64 base64 characters is "/".
    jpeg = b"\xff\xd8\xff" + random.Random(0).randbytes(MAX_UPLOAD_JPEG_BYTES - 3)
    image = base64.b64encode(jpeg).decode()
    raw = json.dumps(detect_body(image_b64=image, concept="c" * 64, goal_id="g" * 64)).replace("/", "\\/")
    assert MAX_REQUEST_BODY_BYTES - 32 * 1024 < len(raw) <= MAX_REQUEST_BODY_BYTES
    response = client.post(
        "/v1/detect", content=raw.encode(), headers={**AUTH, "Content-Type": "application/json"}
    )
    assert response.status_code == 200


@pytest.mark.parametrize(
    "raw",
    [
        b'{"image_b64": "x", "concept": "\xff\xfe", "goal_id": "g", "frame_id": 1}',  # invalid UTF-8
        b'{"image_b64": "x", "concept": "chair", "goal_id": "g", "frame_id": ' + b"9" * 5000 + b"}",
        b"[" * 200_000,  # deeper than json.loads can recurse
    ],
)
def test_unparseable_body_is_422_invalid_request(client: TestClient, meta: respx.MockRouter, raw: bytes) -> None:
    response = client.post("/v1/detect", content=raw, headers={**AUTH, "Content-Type": "application/json"})
    assert_error(response, 422, "invalid_request")
    assert not meta.calls


def test_framework_errors_use_the_contract_shape(client: TestClient) -> None:
    assert_error(client.get("/v1/nope", headers=AUTH), 404, "not_found")
    response = client.get("/v1/detect", headers=AUTH)
    assert_error(response, 405, "method_not_allowed")
    assert response.headers["Allow"] == "POST"


def jpeg_b64_of_size(size: int) -> str:
    return base64.b64encode(b"\xff\xd8\xff" + bytes(size - 3)).decode()


@pytest.mark.parametrize(
    "image_b64",
    [
        jpeg_b64_of_size(MAX_UPLOAD_JPEG_BYTES + 1),  # decodes to one byte over
        "A" * (4 * MAX_UPLOAD_JPEG_BYTES // 3 + 8),  # rejected by length, never decoded
    ],
)
def test_oversize_image_is_413(client: TestClient, meta: respx.MockRouter, image_b64: str) -> None:
    response = client.post("/v1/detect", json=detect_body(image_b64=image_b64), headers=AUTH)
    assert_error(response, 413, "image_too_large")
    assert len(response.content) < 500
    assert not meta.calls


def test_image_at_the_limit_is_accepted(client: TestClient, meta: respx.MockRouter) -> None:
    meta.post("/responses").respond(200, json=sam_body(""))
    image = jpeg_b64_of_size(MAX_UPLOAD_JPEG_BYTES)
    response = client.post("/v1/detect", json=detect_body(image_b64=image), headers=AUTH)
    assert response.status_code == 200


def test_no_key_is_503(meta: respx.MockRouter) -> None:
    with app_client(model_api_key=None) as client:
        response = client.post("/v1/detect", json=detect_body(), headers=AUTH)
    assert_error(response, 503, "key_not_configured")
    assert not meta.calls


def test_meta_timeout_is_504_without_retry(client: TestClient, meta: respx.MockRouter) -> None:
    route = meta.post("/responses").mock(side_effect=httpx.ReadTimeout("timed out"))
    response = client.post("/v1/detect", json=detect_body(), headers=AUTH)
    assert_error(response, 504, "timeout")
    assert route.call_count == 1


def test_total_deadline_is_enforced(meta: respx.MockRouter) -> None:
    async def slow(_request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(5)
        return httpx.Response(200, json=sam_body(""))

    meta.post("/responses").mock(side_effect=slow)
    with app_client(sam_timeout_seconds=0.1) as client:
        started = time.perf_counter()
        response = client.post("/v1/detect", json=detect_body(), headers=AUTH)
        elapsed = time.perf_counter() - started
    assert_error(response, 504, "timeout")
    assert "0.1 s" in response.json()["error"]["message"]
    assert elapsed < 2.0


def test_per_call_timeout_comes_from_settings(meta: respx.MockRouter) -> None:
    route = meta.post("/responses").respond(200, json=sam_body(""))
    with app_client(sam_timeout_seconds=2.5) as client:
        client.post("/v1/detect", json=detect_body(), headers=AUTH)
    assert route.calls.last.request.extensions["timeout"]["read"] == 2.5


def test_rate_limit_is_429_with_exactly_one_upstream_call(client: TestClient, meta: respx.MockRouter) -> None:
    route = meta.post("/responses").mock(
        side_effect=[
            httpx.Response(429, headers={"Retry-After": "1.2"}, json=meta_error("rate_limit_exceeded")),
            httpx.Response(200, json=sam_body("")),
        ]
    )
    response = client.post("/v1/detect", json=detect_body(), headers=AUTH)
    assert_error(response, 429, "rate_limited")
    assert response.headers["Retry-After"] == "2"
    assert route.call_count == 1


@pytest.mark.parametrize(
    ("retry_after", "forwarded"),
    [("inf", None), ("Infinity", None), ("-inf", None), ("1e400", None), ("nan", None), ("1e300", "3600"), ("0", "0")],
)
def test_rate_limit_with_unusable_retry_after_is_still_429(
    client: TestClient, meta: respx.MockRouter, retry_after: str, forwarded: str | None
) -> None:
    meta.post("/responses").respond(
        429, headers={"Retry-After": retry_after}, json=meta_error("rate_limit_exceeded")
    )
    response = client.post("/v1/detect", json=detect_body(), headers=AUTH)
    assert_error(response, 429, "rate_limited")
    assert response.headers.get("Retry-After") == forwarded


def test_meta_503_is_not_retried(client: TestClient, meta: respx.MockRouter) -> None:
    route = meta.post("/responses").mock(
        side_effect=[
            httpx.Response(503, json=meta_error("service_unavailable")),
            httpx.Response(200, json=sam_body("")),
        ]
    )
    response = client.post("/v1/detect", json=detect_body(), headers=AUTH)
    assert_error(response, 502, "service_unavailable")
    assert route.call_count == 1


def test_content_policy_violation_passes_code_not_message(client: TestClient, meta: respx.MockRouter) -> None:
    meta.post("/responses").respond(
        400, json=meta_error("content_policy_violation", f"blocked; upstream detail {TEST_KEY}")
    )
    response = client.post("/v1/detect", json=detect_body(), headers=AUTH)
    assert_error(response, 502, "content_policy_violation")
    assert "upstream detail" not in response.text


def test_meta_error_type_without_code_is_upstream_error(client: TestClient, meta: respx.MockRouter) -> None:
    meta.post("/responses").respond(400, json={"error": {"type": "invalid_request_error", "message": "x"}})
    response = client.post("/v1/detect", json=detect_body(), headers=AUTH)
    assert_error(response, 502, "upstream_error")
    assert "invalid_request_error" not in response.text


@pytest.mark.parametrize(
    ("output", "code"),
    [
        ({"id": "r", "status": "failed", "error": {"code": "server_error", "message": "x"}, "output": []}, "server_error"),
        ({"id": "r", "status": "failed", "error": {"type": "server_error"}, "output": []}, "upstream_error"),
        ({"id": "r", "status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}}, "upstream_error"),
        ({**sam_body(f"<0f>0{box(10, 10, 100, 100, 0.9)}{MASK}"), "status": "in_progress"}, "upstream_error"),
    ],
)
def test_unfinished_meta_response_is_502_not_a_miss(
    client: TestClient, meta: respx.MockRouter, caplog: pytest.LogCaptureFixture, output: dict[str, Any], code: str
) -> None:
    meta.post("/responses").respond(200, json=output)
    response = client.post("/v1/detect", json=detect_body(), headers=AUTH)
    assert_error(response, 502, code)
    assert "detections" not in response.text
    assert any("meta status=200" in r.getMessage() for r in caplog.records if r.name == "heynavi.detect")


def test_completed_response_with_null_error_is_a_normal_answer(client: TestClient, meta: respx.MockRouter) -> None:
    meta.post("/responses").respond(200, json={**sam_body(""), "error": None})
    response = client.post("/v1/detect", json=detect_body(), headers=AUTH)
    assert response.status_code == 200
    assert response.json()["detections"] == []


@pytest.mark.parametrize(
    "mock",
    [
        {"side_effect": httpx.ConnectError("no route")},
        {"side_effect": httpx.RemoteProtocolError("hung up")},
        {"return_value": httpx.Response(500, text="<html>oops</html>")},
        {"return_value": httpx.Response(200, text="not json")},
        {"return_value": httpx.Response(200, json=["not", "an", "object"])},
        {"return_value": httpx.Response(400, json=meta_error("bad code with spaces <script>"))},
        # Meta codes that look like our own must not reach the app as if they were.
        {"return_value": httpx.Response(401, json=meta_error("unauthorized"))},
        {"return_value": httpx.Response(400, json=meta_error("invalid_request"))},
    ],
)
def test_other_upstream_failures_are_502_upstream_error(
    client: TestClient, meta: respx.MockRouter, mock: dict[str, Any]
) -> None:
    route = meta.post("/responses").mock(**mock)
    response = client.post("/v1/detect", json=detect_body(), headers=AUTH)
    assert_error(response, 502, "upstream_error")
    assert "oops" not in response.text and "<script>" not in response.text
    assert route.call_count == 1


def test_logs_one_info_line_and_no_secrets(
    client: TestClient, meta: respx.MockRouter, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    meta.post("/responses").mock(
        side_effect=[
            httpx.Response(200, json=sam_body(f"<0f>0{box(10, 10, 100, 100, 0.876)}{MASK}")),
            httpx.Response(401, json=meta_error("invalid_api_key", f"bad key {TEST_KEY}")),
        ]
    )
    assert client.post("/v1/detect", json=detect_body(goal_id="g-42", frame_id=3), headers=AUTH).status_code == 200
    assert client.post("/v1/detect", json=detect_body(frame_id=4), headers=AUTH).status_code == 502
    client.post("/v1/detect", json=detect_body(image_b64="@@"), headers=AUTH)

    detect_lines = [r for r in caplog.records if r.name == "heynavi.detect"]
    info = [r.getMessage() for r in detect_lines if r.levelno == logging.INFO]
    assert len(info) == 1
    assert "goal=g-42" in info[0] and "frame=3" in info[0] and "concept='chair'" in info[0]
    assert "detections=1" in info[0] and "best=0.88" in info[0] and "sam=" in info[0]
    warnings = [r.getMessage() for r in detect_lines if r.levelno == logging.WARNING]
    assert len(warnings) == 1 and "code=invalid_api_key" in warnings[0] and "frame=4" in warnings[0]
    for secret in (TEST_KEY, APP_TOKEN, JPEG_B64, JPEG_B64[:32]):
        assert secret not in caplog.text


async def test_deadline_cancels_a_slow_drip_response_on_a_real_socket() -> None:
    # httpx's read timeout restarts on every chunk, so a server that drips bytes never
    # trips it; the total deadline in _call_sam must. Loopback only, never the real API.
    calls = 0
    ok = json.dumps(sam_body("")).encode()

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        nonlocal calls
        while True:
            try:
                head = await reader.readuntil(b"\r\n\r\n")
            except (asyncio.IncompleteReadError, ConnectionError):
                return  # the client closed its keep-alive connection
            length = next(
                int(line.split(b":", 1)[1])
                for line in head.split(b"\r\n")
                if line.lower().startswith(b"content-length:")
            )
            await reader.readexactly(length)
            calls += 1
            if calls == 1:
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n")
                try:
                    for _ in range(100):
                        writer.write(b" ")
                        await writer.drain()
                        await asyncio.sleep(0.05)
                except (ConnectionError, asyncio.CancelledError):
                    pass
                writer.close()
                return
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n%s" % (len(ok), ok))
            await writer.drain()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        async with MetaClient(api_key=TEST_KEY, base_url=f"http://127.0.0.1:{port}", timeout_seconds=5) as client:
            started = time.perf_counter()
            with pytest.raises(MetaAPIError) as info:
                await _call_sam(client, {"model": "sam-3.1"}, 0.3)
            elapsed = time.perf_counter() - started
            assert info.value.code == "timeout"
            assert 0.25 <= elapsed < 1.5
            assert info.value.__context__ is None and info.value.__cause__ is None
            # The shared client stays usable after a cancelled call.
            assert (await _call_sam(client, {"model": "sam-3.1"}, 2.0))["id"] == "resp_1"
    finally:
        server.close()
        await server.wait_closed()
    assert calls == 2

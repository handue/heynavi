from __future__ import annotations

import asyncio
import json
import logging
import traceback
from collections.abc import AsyncIterator, Iterator

import h11
import httpx
import pytest
import respx

from app.meta.client import (
    MAX_JITTER_SECONDS,
    MAX_RETRY_WAIT_SECONDS,
    MetaAPIError,
    MetaClient,
    parse_model_ids,
    parse_retry_after,
)
from tests.conftest import BASE_URL, TEST_KEY, make_settings


class FakeSleep:
    def __init__(self) -> None:
        self.calls: list[float] = []

    async def __call__(self, seconds: float) -> None:
        self.calls.append(seconds)


@pytest.fixture
def sleep() -> FakeSleep:
    return FakeSleep()


@pytest.fixture
async def client(sleep: FakeSleep) -> AsyncIterator[MetaClient]:
    async with MetaClient(api_key=TEST_KEY, base_url=BASE_URL, timeout_seconds=5, sleep=sleep) as c:
        yield c


@pytest.fixture
def meta() -> Iterator[respx.MockRouter]:
    with respx.mock(base_url=BASE_URL, assert_all_called=False) as router:
        yield router


def error_body(code: str, message: str = "boom", type_: str = "invalid_request_error") -> dict[str, object]:
    return {"error": {"message": message, "type": type_, "code": code}}


async def test_bearer_header_and_model_parsing(client: MetaClient, meta: respx.MockRouter) -> None:
    route = meta.get("/models").respond(
        200, json={"object": "list", "data": [{"id": "sam-3.1"}, {"id": "muse-spark-1.3"}, {"no_id": 1}]}
    )
    assert await client.list_models() == ["sam-3.1", "muse-spark-1.3"]
    request = route.calls.last.request
    assert request.headers["Authorization"] == f"Bearer {TEST_KEY}"
    assert str(request.url) == f"{BASE_URL}/models"


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ({"data": [{"id": "a"}, {"id": "b"}]}, ["a", "b"]),
        ({"models": [{"id": "a"}]}, ["a"]),
        ([{"id": "a"}, "b"], ["a", "b"]),
        ({"data": None}, []),
        ({}, []),
        ("nonsense", []),
    ],
)
def test_parse_model_ids_is_defensive(body: object, expected: list[str]) -> None:
    assert parse_model_ids(body) == expected


async def test_create_response_posts_payload(client: MetaClient, meta: respx.MockRouter) -> None:
    route = meta.post("/responses").respond(200, json={"id": "resp_1", "status": "completed", "output": []})
    payload = {"model": "sam-3.1", "store": False}
    assert (await client.create_response(payload))["id"] == "resp_1"
    assert json.loads(route.calls.last.request.content) == payload


async def test_chat_completion_posts_to_chat_completions(client: MetaClient, meta: respx.MockRouter) -> None:
    route = meta.post("/chat/completions").respond(200, json={"choices": []})
    await client.chat_completion({"model": "muse-spark-1.3"})
    assert route.called


async def test_retries_once_on_429_honoring_retry_after(
    client: MetaClient, meta: respx.MockRouter, sleep: FakeSleep
) -> None:
    route = meta.post("/responses").mock(
        side_effect=[
            httpx.Response(429, headers={"Retry-After": "2"}, json=error_body("rate_limit_exceeded")),
            httpx.Response(200, json={"id": "ok"}),
        ]
    )
    assert (await client.create_response({}))["id"] == "ok"
    assert route.call_count == 2
    assert len(sleep.calls) == 1
    assert 2.0 <= sleep.calls[0] <= 2.0 + MAX_JITTER_SECONDS


async def test_retry_wait_is_capped(client: MetaClient, meta: respx.MockRouter, sleep: FakeSleep) -> None:
    meta.post("/responses").mock(
        side_effect=[
            httpx.Response(503, headers={"Retry-After": "60"}),
            httpx.Response(200, json={"id": "ok"}),
        ]
    )
    await client.create_response({})
    assert MAX_RETRY_WAIT_SECONDS <= sleep.calls[0] <= MAX_RETRY_WAIT_SECONDS + MAX_JITTER_SECONDS


async def test_only_one_retry_then_raises(client: MetaClient, meta: respx.MockRouter, sleep: FakeSleep) -> None:
    route = meta.post("/responses").mock(
        side_effect=[
            httpx.Response(429, headers={"Retry-After": "1"}, json=error_body("rate_limit_exceeded")),
            httpx.Response(429, headers={"Retry-After": "3"}, json=error_body("rate_limit_exceeded")),
            httpx.Response(200, json={"id": "never"}),
        ]
    )
    with pytest.raises(MetaAPIError) as info:
        await client.create_response({})
    assert route.call_count == 2
    assert len(sleep.calls) == 1
    assert (info.value.status, info.value.code, info.value.retry_after) == (429, "rate_limit_exceeded", 3.0)


@pytest.mark.parametrize("status", [504, 400, 401, 404, 500])
async def test_no_retry_on_504_or_other_errors(
    client: MetaClient, meta: respx.MockRouter, sleep: FakeSleep, status: int
) -> None:
    route = meta.post("/responses").respond(status, json=error_body(f"code_{status}"))
    with pytest.raises(MetaAPIError) as info:
        await client.create_response({})
    assert route.call_count == 1
    assert sleep.calls == []
    assert info.value.status == status


async def test_content_policy_violation_is_mapped(client: MetaClient, meta: respx.MockRouter) -> None:
    meta.post("/responses").respond(
        400, json=error_body("content_policy_violation", "Request blocked by content policy")
    )
    with pytest.raises(MetaAPIError) as info:
        await client.create_response({})
    assert info.value.code == "content_policy_violation"
    assert info.value.message == "Request blocked by content policy"


async def test_error_code_falls_back_to_type_then_status(client: MetaClient, meta: respx.MockRouter) -> None:
    meta.post("/responses").mock(
        side_effect=[
            httpx.Response(400, json={"error": {"type": "content_policy_violation", "message": "x"}}),
            httpx.Response(504, text="<html>Gateway Timeout</html>"),
        ]
    )
    with pytest.raises(MetaAPIError) as first:
        await client.create_response({})
    assert first.value.code == "content_policy_violation"
    with pytest.raises(MetaAPIError) as second:
        await client.create_response({})
    assert (second.value.status, second.value.code) == (504, "http_504")


async def test_key_never_appears_in_exception_text(
    client: MetaClient, meta: respx.MockRouter, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    meta.get("/models").respond(
        401, json=error_body(f"bad_key_{TEST_KEY}", f"Invalid API key {TEST_KEY} provided")
    )
    with pytest.raises(MetaAPIError) as info:
        await client.list_models()
    exc = info.value
    for text in (str(exc), repr(exc), exc.message, exc.code, caplog.text):
        assert TEST_KEY not in text
    assert "[redacted]" in exc.message


async def test_request_body_is_never_logged(
    client: MetaClient, meta: respx.MockRouter, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    meta.post("/responses").respond(200, json={"id": "ok"})
    await client.create_response({"image": "data:image/jpeg;base64,SECRETFRAME"})
    assert "SECRETFRAME" not in caplog.text
    assert TEST_KEY not in caplog.text


async def test_timeout_maps_to_error_without_retry(
    client: MetaClient, meta: respx.MockRouter, sleep: FakeSleep
) -> None:
    route = meta.post("/chat/completions").mock(side_effect=httpx.ReadTimeout("timed out"))
    with pytest.raises(MetaAPIError) as info:
        await client.chat_completion({})
    assert (info.value.status, info.value.code) == (None, "timeout")
    assert route.call_count == 1 and sleep.calls == []


async def test_network_error_is_mapped(client: MetaClient, meta: respx.MockRouter) -> None:
    meta.get("/models").mock(side_effect=httpx.ConnectError("no route"))
    with pytest.raises(MetaAPIError) as info:
        await client.list_models()
    assert info.value.code == "network_error"


@pytest.mark.parametrize(
    ("exc", "code"),
    [
        (httpx.DecodingError("bad gzip"), "invalid_response"),
        (httpx.TooManyRedirects("loop"), "network_error"),
        (httpx.LocalProtocolError("bad header"), "network_error"),
        (httpx.RemoteProtocolError("server hung up"), "network_error"),
        (httpx.UnsupportedProtocol("ftp"), "network_error"),
        (httpx.ProxyError("proxy"), "network_error"),
        (httpx.ReadError("reset"), "network_error"),
        (httpx.PoolTimeout("pool"), "timeout"),
    ],
)
async def test_every_request_error_is_mapped(
    client: MetaClient, meta: respx.MockRouter, exc: httpx.RequestError, code: str
) -> None:
    meta.post("/responses").mock(side_effect=exc)
    with pytest.raises(MetaAPIError) as info:
        await client.create_response({})
    assert (info.value.status, info.value.code, info.value.message) == (None, code, type(exc).__name__)


def _raise_h11_style_error(request: httpx.Request) -> httpx.Response:
    # What httpx does when h11 refuses a header: h11's message quotes the header value,
    # and httpx re-raises with the same text, chained "from" the h11 error.
    text = f"Illegal header value b'Bearer {TEST_KEY}\\n'"
    try:
        raise h11.LocalProtocolError(text)
    except h11.LocalProtocolError as inner:
        raise httpx.LocalProtocolError(text) from inner


@pytest.mark.parametrize(
    "side_effect",
    [
        _raise_h11_style_error,
        httpx.ConnectError(f"cannot connect with Bearer {TEST_KEY}"),
        httpx.ReadTimeout(f"timed out, Authorization: Bearer {TEST_KEY}"),
        httpx.DecodingError(f"bad body {TEST_KEY}"),
    ],
)
async def test_key_never_appears_in_traceback(
    client: MetaClient, meta: respx.MockRouter, side_effect: object
) -> None:
    meta.get("/models").mock(side_effect=side_effect)
    with pytest.raises(MetaAPIError) as info:
        await client.list_models()
    exc = info.value
    assert exc.__cause__ is None and exc.__context__ is None and exc.__suppress_context__
    rendered = "".join(traceback.format_exception(exc))
    assert TEST_KEY not in rendered
    assert "direct cause" not in rendered and "During handling" not in rendered


async def test_real_h11_header_failure_does_not_leak_key_in_traceback() -> None:
    # A real h11 LocalProtocolError on a loopback socket (never the real Meta API):
    # a key with a pasted line break makes h11 quote the whole Authorization header.
    bad_key = f"{TEST_KEY}\nX"

    async def close_at_once(_reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        writer.close()

    server = await asyncio.start_server(close_at_once, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        async with MetaClient(api_key=bad_key, base_url=f"http://127.0.0.1:{port}", timeout_seconds=5) as c:
            with pytest.raises(MetaAPIError) as info:
                await c.list_models()
    finally:
        server.close()
        await server.wait_closed()
    assert (info.value.code, info.value.message) == ("network_error", "LocalProtocolError")
    assert TEST_KEY not in "".join(traceback.format_exception(info.value))


async def test_last_attempts_reports_retries(client: MetaClient, meta: respx.MockRouter) -> None:
    assert client.last_attempts == 0
    meta.post("/responses").mock(
        side_effect=[
            httpx.Response(200, json={"id": "first"}),
            httpx.Response(429, headers={"Retry-After": "0"}, json=error_body("rate_limit_exceeded")),
            httpx.Response(200, json={"id": "after-retry"}),
            httpx.Response(400, json=error_body("bad")),
        ]
    )
    await client.create_response({})
    assert client.last_attempts == 1
    await client.create_response({})
    assert client.last_attempts == 2
    with pytest.raises(MetaAPIError):
        await client.create_response({})
    assert client.last_attempts == 1


async def test_models_response_returns_raw_body(client: MetaClient, meta: respx.MockRouter) -> None:
    meta.get("/models").respond(200, json={"object": "list", "items": [{"name": "sam-3.1"}]})
    assert await client.models_response() == {"object": "list", "items": [{"name": "sam-3.1"}]}
    assert await client.list_models() == []


async def test_non_json_success_is_an_error(client: MetaClient, meta: respx.MockRouter) -> None:
    meta.post("/responses").respond(200, text="not json")
    with pytest.raises(MetaAPIError) as info:
        await client.create_response({})
    assert info.value.code == "invalid_response"
    assert info.value.__context__ is None and info.value.__cause__ is None


def test_parse_retry_after() -> None:
    assert parse_retry_after(None) is None
    assert parse_retry_after("") is None
    assert parse_retry_after("7") == 7.0
    assert parse_retry_after("1.5") == 1.5
    assert parse_retry_after("-3") == 0.0
    assert parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT") == 0.0  # date in the past
    assert parse_retry_after("soon") is None


def test_from_settings_requires_key() -> None:
    with pytest.raises(ValueError):
        MetaClient.from_settings(make_settings())


async def test_from_settings_uses_configured_base_url() -> None:
    settings = make_settings(model_api_key=TEST_KEY, meta_api_base_url="https://example.test/v9")
    with respx.mock(base_url="https://example.test/v9") as router:
        router.get("/models").respond(200, json={"data": []})
        async with MetaClient.from_settings(settings) as c:
            assert await c.list_models() == []

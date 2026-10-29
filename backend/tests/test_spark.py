from __future__ import annotations

from typing import Any

from app.meta.spark import (
    build_spark_probe_request,
    extract_chat_content,
    extract_finish_reason,
    extract_usage,
)

DATA_URL = "data:image/jpeg;base64,/9j/AAAA"


def walk_objects(schema: dict[str, Any]) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    if schema.get("type") == "object":
        found.append(schema)
        for child in schema["properties"].values():
            found.extend(walk_objects(child))
    if schema.get("type") == "array":
        found.extend(walk_objects(schema["items"]))
    return found


def test_probe_request_shape() -> None:
    req = build_spark_probe_request(DATA_URL, model="muse-spark-1.3", reasoning_effort="minimal")
    assert req["model"] == "muse-spark-1.3"
    assert req["reasoning_effort"] == "minimal"
    assert req["max_completion_tokens"] == 512
    assert "max_tokens" not in req
    developer, user = req["messages"]
    assert developer["role"] == "developer" and "at most 5" in developer["content"]
    assert user["role"] == "user"
    assert user["content"][0]["type"] == "text"
    assert user["content"][1] == {"type": "image_url", "image_url": {"url": DATA_URL}}


def test_probe_schema_is_strict() -> None:
    fmt = build_spark_probe_request(DATA_URL, model="m", reasoning_effort="low")["response_format"]
    assert fmt["type"] == "json_schema"
    assert fmt["json_schema"]["strict"] is True
    schema = fmt["json_schema"]["schema"]
    assert schema["type"] == "object"
    objects = walk_objects(schema)
    assert len(objects) == 2
    for obj in objects:
        assert obj["additionalProperties"] is False
        assert sorted(obj["required"]) == sorted(obj["properties"])
    position = schema["properties"]["objects"]["items"]["properties"]["position"]
    assert position["enum"] == ["left", "center", "right"]


def test_extract_chat_content_and_usage() -> None:
    body = {
        "choices": [{"message": {"role": "assistant", "content": '{"objects": []}'}, "finish_reason": "stop"}],
        "usage": {
            "prompt_tokens": 900,
            "completion_tokens": 150,
            "total_tokens": 1050,
            "completion_tokens_details": {"reasoning_tokens": 120},
        },
    }
    assert extract_chat_content(body) == '{"objects": []}'
    assert extract_finish_reason(body) == "stop"
    assert extract_usage(body) == {
        "input_tokens": 900,
        "output_tokens": 150,
        "reasoning_tokens": 120,
        "total_tokens": 1050,
    }


def test_extract_usage_accepts_responses_style_names() -> None:
    body = {"usage": {"input_tokens": 5, "output_tokens": 7, "output_tokens_details": {"reasoning_tokens": 3}}}
    assert extract_usage(body) == {"input_tokens": 5, "output_tokens": 7, "reasoning_tokens": 3, "total_tokens": None}


def test_extractors_tolerate_missing_fields() -> None:
    bodies: list[dict[str, Any]] = [{}, {"choices": []}, {"choices": [None]}, {"choices": [{"message": None}]}]
    for body in bodies:
        assert extract_chat_content(body) == ""
        assert extract_finish_reason(body) is None
    assert extract_usage({"usage": "bad"}) == {
        "input_tokens": None,
        "output_tokens": None,
        "reasoning_tokens": None,
        "total_tokens": None,
    }

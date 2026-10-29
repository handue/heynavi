"""Muse Spark over Chat Completions. M0 only needs the latency probe used by the benchmark."""

from __future__ import annotations

from typing import Any, TypedDict

PROBE_INSTRUCTIONS = (
    "You help a blind user understand a camera photo. Be concise. "
    "List at most 5 objects that are clearly visible in the image, and only things "
    "you can actually see. For each, give a short label and its position in the "
    "image: left, center or right."
)

# Strict structured output: object root, additionalProperties false, every key required.
PROBE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "objects": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "position": {"type": "string", "enum": ["left", "center", "right"]},
                },
                "required": ["label", "position"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["objects"],
    "additionalProperties": False,
}


def build_spark_probe_request(
    image_data_url: str,
    *,
    model: str,
    reasoning_effort: str,
    max_completion_tokens: int = 512,
) -> dict[str, Any]:
    return {
        "model": model,
        "messages": [
            {"role": "developer", "content": PROBE_INSTRUCTIONS},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "What objects are clearly visible in this photo?"},
                    {"type": "image_url", "image_url": {"url": image_data_url}},
                ],
            },
        ],
        "reasoning_effort": reasoning_effort,
        # Reasoning tokens count toward this cap and are billed as output.
        "max_completion_tokens": max_completion_tokens,
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "visible_objects", "schema": PROBE_SCHEMA, "strict": True},
        },
        "stream": False,
    }


class TokenUsage(TypedDict):
    input_tokens: int | None
    output_tokens: int | None
    reasoning_tokens: int | None
    total_tokens: int | None


def extract_chat_content(response_json: dict[str, Any]) -> str:
    """Text of the first choice's message, or "" when absent."""
    choices = response_json.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return ""
    message = choices[0].get("message")
    content = message.get("content") if isinstance(message, dict) else None
    return content if isinstance(content, str) else ""


def extract_finish_reason(response_json: dict[str, Any]) -> str | None:
    choices = response_json.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        reason = choices[0].get("finish_reason")
        return reason if isinstance(reason, str) else None
    return None


def extract_usage(response_json: dict[str, Any]) -> TokenUsage:
    """Reads Chat Completions names (prompt/completion_tokens) or Responses names
    (input/output_tokens), whichever is present."""
    usage = response_json.get("usage")
    usage = usage if isinstance(usage, dict) else {}
    details = usage.get("completion_tokens_details") or usage.get("output_tokens_details")
    details = details if isinstance(details, dict) else {}
    return TokenUsage(
        input_tokens=_int_or_none(usage.get("prompt_tokens", usage.get("input_tokens"))),
        output_tokens=_int_or_none(usage.get("completion_tokens", usage.get("output_tokens"))),
        reasoning_tokens=_int_or_none(details.get("reasoning_tokens")),
        total_tokens=_int_or_none(usage.get("total_tokens")),
    )


def _int_or_none(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None

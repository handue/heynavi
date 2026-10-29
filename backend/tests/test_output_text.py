from __future__ import annotations

from typing import Any

from app.meta.sam import extract_output_text, parse_sam_output

LINE = "<0f>0<|box;x1=1;y1=2;x2=3;y2=4;w=10;h=10;c=0.9|><|mask;x=0;y=0;data=!x|>"


def message(*texts: str) -> dict[str, Any]:
    return {
        "type": "message",
        "role": "assistant",
        "content": [{"type": "output_text", "text": t, "annotations": []} for t in texts],
    }


def envelope(*items: Any, **extra: Any) -> dict[str, Any]:
    return {"id": "resp_1", "status": "completed", "output": list(items), **extra}


def test_single_message_part() -> None:
    assert extract_output_text(envelope(message(LINE))) == LINE


def test_multiple_parts_and_messages_are_concatenated() -> None:
    body = envelope(message("<0f>", "0<|box"), message(";x1=1|>"))
    assert extract_output_text(body) == "<0f>0<|box;x1=1|>"


def test_non_message_items_and_non_text_parts_are_ignored() -> None:
    body = envelope(
        {"type": "reasoning", "summary": [{"type": "summary_text", "text": "thinking"}]},
        {
            "type": "message",
            "content": [
                {"type": "refusal", "refusal": "no"},
                {"type": "output_text", "text": LINE},
                {"type": "output_text"},  # missing text
                "not-a-dict",
            ],
        },
        "garbage",
    )
    assert extract_output_text(body) == LINE


def test_empty_output_means_empty_text() -> None:
    assert extract_output_text(envelope()) == ""
    assert extract_output_text(envelope(message(""))) == ""
    assert extract_output_text({"id": "x"}) == ""
    assert extract_output_text({"output": None}) == ""


def test_top_level_output_text_is_tolerated() -> None:
    assert extract_output_text({"output_text": LINE}) == LINE
    # When output[] has text, it wins over a top-level copy.
    assert extract_output_text(envelope(message(LINE), output_text="other")) == LINE


def test_end_to_end_with_parser() -> None:
    [det] = parse_sam_output(extract_output_text(envelope(message(LINE))))
    assert det.confidence == 0.9

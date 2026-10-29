"""SAM 3.1 over the Responses API: request builder, output-text extraction, box parser.

Output grammar (one line per frame, images use frame 0):

    <0f>0<|box;x1=353;y1=382;x2=453;y2=427;w=537;h=561;c=0.91|><|mask;...;data=!...|>,1<|box;...|><|mask;...|>

Mask data may contain any character except the closing "|>", including commas, "<"
and things that look like frame markers, so the parser scans tokens left to right
instead of splitting on separators. The scan is linear in the text length, so malformed
or hostile output (for example thousands of unterminated "<|" tokens) stays cheap.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any, Literal

HorizontalThird = Literal["left", "center", "right"]

# Matched only at a known "<" position, never searched, so each costs at most the
# length of its own run of word characters or digits.
_TOKEN_KIND = re.compile(r"\w+;")
_FRAME_MARKER = re.compile(r"(\d+)f>")
_REQUIRED_BOX_KEYS = ("x1", "y1", "x2", "y2", "w", "h")


def build_sam_request(
    concept: str,
    image_data_url: str,
    *,
    model: str,
    include_confidence: bool = True,
    mask_encoding: str = "one_bit",
) -> dict[str, Any]:
    return {
        "model": model,
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_text", "text": concept},
                    {"type": "input_image", "image_url": image_data_url},
                ],
            }
        ],
        "stream": False,
        # /v1/responses stores requests by default; frames must never be stored.
        "store": False,
        # Metadata values must be strings.
        "metadata": {
            "include_confidence": "true" if include_confidence else "false",
            "mask_encoding": mask_encoding,
        },
    }


def extract_output_text(response_json: dict[str, Any]) -> str:
    """Concatenate every output_text part of every message item in `output`.

    The raw JSON has no top-level output_text (that is an SDK convenience), but one is
    accepted as a fallback if a response ever carries it.
    """
    parts: list[str] = []
    output = response_json.get("output")
    if isinstance(output, list):
        for item in output:
            if not isinstance(item, dict) or item.get("type") != "message":
                continue
            content = item.get("content")
            if not isinstance(content, list):
                continue
            for part in content:
                if (
                    isinstance(part, dict)
                    and part.get("type") == "output_text"
                    and isinstance(part.get("text"), str)
                ):
                    parts.append(part["text"])
    if parts:
        return "".join(parts)
    top_level = response_json.get("output_text")
    return top_level if isinstance(top_level, str) else ""


@dataclass(frozen=True, slots=True)
class SamDetection:
    frame: int
    index: int
    x1: float  # pixel coordinates; x2/y2 are inclusive
    y1: float
    x2: float
    y2: float
    width: int  # source media size
    height: int
    confidence: float | None

    @property
    def box_norm(self) -> tuple[float, float, float, float]:
        """(x1, y1, x2, y2) in [0, 1], with the inclusive edge converted to exclusive."""
        return (
            _clamp01(self.x1 / self.width),
            _clamp01(self.y1 / self.height),
            _clamp01((self.x2 + 1) / self.width),
            _clamp01((self.y2 + 1) / self.height),
        )

    @property
    def center_x(self) -> float:
        x1, _, x2, _ = self.box_norm
        return (x1 + x2) / 2

    @property
    def area_fraction(self) -> float:
        x1, y1, x2, y2 = self.box_norm
        return (x2 - x1) * (y2 - y1)

    @property
    def horizontal_third(self) -> HorizontalThird:
        if self.center_x < 1 / 3:
            return "left"
        if self.center_x > 2 / 3:
            return "right"
        return "center"


def parse_sam_output(text: str) -> list[SamDetection]:
    """Parse SAM output text into detections. Empty text means no matches.

    Malformed records are skipped, never raised; masks and unknown fields are ignored.
    """
    detections: list[SamDetection] = []
    frame = 0
    in_frame = 0  # records seen in the current frame, used when an ordinal is missing
    pos = 0  # end of the previous token or frame marker
    cursor = 0  # where to look for the next "<"
    while (start := text.find("<", cursor)) != -1:
        if text.startswith("<|", start):
            kind = _TOKEN_KIND.match(text, start + 2)
            if kind is None:
                cursor = start + 1
                continue
            # A token's body runs to the first "|>", so nothing inside mask data is ever
            # mistaken for a marker or a box. No "|>" left means no complete token is left.
            end = text.find("|>", kind.end())
            if end == -1:
                break
            gap = text[pos:start]
            pos = cursor = end + 2
            if kind.group() != "box;":
                continue
            ordinal = _trailing_ordinal(gap)
            index = ordinal if ordinal is not None else in_frame
            in_frame += 1
            detection = _parse_box(frame, index, text[kind.end() : end])
            if detection is not None:
                detections.append(detection)
            continue
        marker = _FRAME_MARKER.match(text, start + 1)
        if marker is None:
            cursor = start + 1
            continue
        pos = cursor = marker.end()
        number = _to_int(marker.group(1))
        frame = number if number is not None else frame
        in_frame = 0
    return detections


def _trailing_ordinal(gap: str) -> int | None:
    """The record ordinal written right before a box token ("...,12<|box;"), if any."""
    stripped = gap.rstrip()
    i = len(stripped)
    while i > 0 and stripped[i - 1].isdecimal():
        i -= 1
    return _to_int(stripped[i:]) if i < len(stripped) else None


def _to_int(digits: str) -> int | None:
    try:
        return int(digits)
    except ValueError:  # more digits than int() accepts: treat as malformed
        return None


def _parse_box(frame: int, index: int, body: str) -> SamDetection | None:
    fields: dict[str, str] = {}
    for item in body.split(";"):
        key, sep, value = item.partition("=")
        if sep:
            fields[key.strip()] = value.strip()
    if any(key not in fields for key in _REQUIRED_BOX_KEYS):
        return None
    try:
        x1, y1, x2, y2, w, h = (float(fields[key]) for key in _REQUIRED_BOX_KEYS)
        confidence = float(fields["c"]) if "c" in fields else None
    except ValueError:
        return None
    numbers = [x1, y1, x2, y2, w, h] + ([confidence] if confidence is not None else [])
    if not all(math.isfinite(n) for n in numbers):
        return None
    width, height = int(w), int(h)
    if width <= 0 or height <= 0 or x2 < x1 or y2 < y1:
        return None
    return SamDetection(
        frame=frame,
        index=index,
        x1=x1,
        y1=y1,
        x2=x2,
        y2=y2,
        width=width,
        height=height,
        confidence=None if confidence is None else _clamp01(confidence),
    )


def _clamp01(value: float) -> float:
    return min(1.0, max(0.0, value))

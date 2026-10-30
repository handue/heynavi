"""Muse Spark scene understanding over the Responses API (ARCHITECTURE 4): prompt, strict
JSON schema, request builder and a tolerant parser.

The model proposes; it never speaks. Every label and sentence it returns is validated here and
run through the wording filter, and the app decides what, if anything, is said.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Literal

from app.wording import check_camera_text

Kind = Literal["object", "possible_obstacle", "person", "text", "landmark"]
Position = Literal["left", "center", "right"]
Band = Literal["lower", "middle", "upper"]
Status = Literal["new", "still", "moved", "gone"]
Importance = Literal["high", "medium", "low"]
Change = Literal["none", "minor", "major"]

KINDS: tuple[Kind, ...] = ("object", "possible_obstacle", "person", "text", "landmark")
POSITIONS: tuple[Position, ...] = ("left", "center", "right")
BANDS: tuple[Band, ...] = ("lower", "middle", "upper")
STATUSES: tuple[Status, ...] = ("new", "still", "moved", "gone")
IMPORTANCES: tuple[Importance, ...] = ("high", "medium", "low")
CHANGES: tuple[Change, ...] = ("none", "minor", "major")

# Round 1 on the iPhone: Spark p50 5.6 s with up to 5 items; fewer items, shorter output.
MAX_ITEMS = 4
MAX_ITEMS_DETAILED = 6
MAX_RAW_ITEMS = 12
MAX_SUMMARY_WORDS = 15
MAX_SUMMARY_WORDS_DETAILED = 35
MAX_TEXT_CHARS = 60
MAX_COUNT = 20
# Same shape the app and /v1/detect accept for a SAM concept.
LABEL_PATTERN = re.compile(r"^[a-z][a-z -]{0,63}$")
MAX_LABEL_WORDS = 4

INSTRUCTIONS = """\
You are the scene-understanding module of HeyNavi, an assistant for blind and low-vision people. \
You get one photo from a phone camera that the user holds pointed ahead, plus notes about what \
was reported in the last few seconds. Report what is visible as JSON matching the schema. Be quick: decide fast and keep the \
reasoning short.

Rules:
- Only report what you can actually see in this photo. Never guess what is outside it.
- Positions are relative to the photo: "position" is its left, center or right third; "band" is its \
lower, middle or upper third.
- Never give distances or sizes in meters, feet or steps. Never say whether anything is safe, clear \
or free of obstacles. Never tell the user to move, walk, turn, stop or be careful. Never describe \
the state of a traffic light or crossing signal.
- Do not identify people or describe faces or bodies; call each one "person".
- summary: one short, neutral sentence about the overall view, at most {summary_words} words, for \
example "A hallway with a door on the right." Do not start it with a verb.
- change: compared with the notes. "major" when this is a different place or the main content is \
different, "minor" when something appeared, moved or disappeared, otherwise "none". With no notes, "major".
- items: at most {max_items}, most important first. Prefer what matters to someone who cannot see: \
things on the floor or at body height that could be in the way, doors, stairs, steps, people, \
signs and readable text, furniture, landmarks. Skip walls, floor, ceiling, lights and small \
decorative details. Report each kind of thing once, with a count.
  - label: a short singular English noun phrase, at most 3 words, letters and spaces only, for \
example "office chair", "open door", "person".
  - count: how many of that thing are visible.
  - kind: "possible_obstacle" for a thing on the floor or at body height in the lower or middle \
band that someone moving the way the camera points could bump into; "person"; "text" for readable \
text or a sign with readable text; "landmark" for doors, doorways, stairs, steps, elevators, \
counters and similar; "object" for anything else.
  - status: compared with the notes: "new", "still" (same place), "moved", or "gone" (in the notes \
but no longer visible; list a gone item only if it mattered).
  - importance: "high" if it is worth interrupting the user for, "medium" if useful, "low" if \
background.
  - ground: the simplest common noun an object detector should look for to find it, for example \
"chair". Use "" for text and for things that are not one physical object.
  - text: for kind "text", the exact readable text, at most 60 characters; otherwise "".
"""

DETAIL_NOTE = (
    "The user just asked what is around them: make the summary a little fuller and list the "
    "most useful items."
)

_ITEM_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "label": {"type": "string"},
        "count": {"type": "integer"},
        "kind": {"type": "string", "enum": list(KINDS)},
        "position": {"type": "string", "enum": list(POSITIONS)},
        "band": {"type": "string", "enum": list(BANDS)},
        "status": {"type": "string", "enum": list(STATUSES)},
        "importance": {"type": "string", "enum": list(IMPORTANCES)},
        "ground": {"type": "string"},
        "text": {"type": "string"},
    },
    "required": ["label", "count", "kind", "position", "band", "status", "importance", "ground", "text"],
    "additionalProperties": False,
}

# Strict structured output: object root, additionalProperties false, every key required.
SCENE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "change": {"type": "string", "enum": list(CHANGES)},
        "items": {"type": "array", "items": _ITEM_SCHEMA},
    },
    "required": ["summary", "change", "items"],
    "additionalProperties": False,
}


@dataclass(frozen=True)
class ContextItem:
    label: str
    kind: Kind
    position: Position
    age_s: int
    spoken: bool


@dataclass(frozen=True)
class SceneContext:
    """What the app remembers from the last ~30 s; it keeps the prompt small."""

    summary: str | None = None
    items: tuple[ContextItem, ...] = ()


def context_notes(context: SceneContext) -> str:
    if context.summary is None and not context.items:
        return "Notes: none (this is the first look)."
    lines = ["Notes from the last few seconds:"]
    if context.summary:
        lines.append(f"- last summary: {context.summary}")
    for item in context.items:
        told = "already told the user" if item.spoken else "not told yet"
        lines.append(
            f"- {item.label} ({item.kind.replace('_', ' ')}, {item.position}, "
            f"seen {item.age_s} s ago, {told})"
        )
    return "\n".join(lines)


def build_scene_request(
    image_data_url: str,
    context: SceneContext,
    *,
    model: str,
    reasoning_effort: str,
    max_output_tokens: int,
    detailed: bool = False,
) -> dict[str, Any]:
    instructions = INSTRUCTIONS.format(
        summary_words=MAX_SUMMARY_WORDS_DETAILED if detailed else MAX_SUMMARY_WORDS,
        max_items=MAX_ITEMS_DETAILED if detailed else MAX_ITEMS,
    )
    user_text = context_notes(context) + (f"\n\n{DETAIL_NOTE}" if detailed else "")
    return {
        "model": model,
        "input": [
            # The fixed instructions come first, so the prompt cache can reuse them.
            {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": instructions}]},
            {
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_text", "text": user_text},
                    {"type": "input_image", "image_url": image_data_url},
                ],
            },
        ],
        "reasoning": {"effort": reasoning_effort},
        # Reasoning tokens count toward this cap.
        "max_output_tokens": max_output_tokens,
        "text": {
            "format": {"type": "json_schema", "name": "scene", "schema": SCENE_SCHEMA, "strict": True}
        },
        "stream": False,
        # /v1/responses stores requests by default; frames must never be stored.
        "store": False,
    }


@dataclass(frozen=True)
class SceneItem:
    label: str
    count: int
    kind: Kind
    position: Position
    band: Band
    status: Status
    importance: Importance
    ground: str | None
    text: str | None


@dataclass
class SceneParse:
    summary: str | None
    change: Change
    items: list[SceneItem]
    # Why each dropped sentence, label or text was dropped ("distance", "invalid_label", ...).
    filtered: list[str] = field(default_factory=list)


class SceneParseError(ValueError):
    """The output is not the scene JSON at all (not JSON, wrong root, missing keys)."""


def parse_scene_output(text: str, *, detailed: bool = False) -> SceneParse:
    """Validates the model's JSON. A bad item or sentence is dropped, not the whole reply."""
    try:
        data = json.loads(text)
    except ValueError:
        raise SceneParseError("output is not JSON") from None
    if not isinstance(data, dict):
        raise SceneParseError("output is not a JSON object")
    change = data.get("change")
    items = data.get("items")
    if change not in CHANGES or not isinstance(items, list):
        raise SceneParseError("output is missing change or items")

    filtered: list[str] = []
    summary = _clean_summary(data.get("summary"), detailed, filtered)
    limit = MAX_ITEMS_DETAILED if detailed else MAX_ITEMS
    parsed: list[SceneItem] = []
    seen: set[str] = set()
    # A bad item does not use up a place; the raw list is bounded so a long one stays cheap.
    for raw in items[: MAX_RAW_ITEMS]:
        if len(parsed) == limit:
            break
        item = _parse_item(raw, filtered)
        if item is None or item.label in seen:
            continue
        seen.add(item.label)
        parsed.append(item)
    return SceneParse(summary=summary, change=change, items=parsed, filtered=filtered)


def _clean_summary(value: Any, detailed: bool, filtered: list[str]) -> str | None:
    if not isinstance(value, str):
        return None
    summary = " ".join(value.split())
    if not summary:
        return None
    limit = MAX_SUMMARY_WORDS_DETAILED if detailed else MAX_SUMMARY_WORDS
    if len(summary.split()) > limit + 5:
        filtered.append("summary_too_long")
        return None
    reason = check_camera_text(summary)
    if reason:
        filtered.append(f"summary_{reason}")
        return None
    return summary


def _parse_item(raw: Any, filtered: list[str]) -> SceneItem | None:
    if not isinstance(raw, dict):
        filtered.append("invalid_item")
        return None
    label = " ".join(str(raw.get("label", "")).lower().split())
    if not LABEL_PATTERN.fullmatch(label) or len(label.split()) > MAX_LABEL_WORDS:
        filtered.append("invalid_label")
        return None
    reason = check_camera_text(label)
    if reason:
        filtered.append(f"label_{reason}")
        return None
    kind, position, band = raw.get("kind"), raw.get("position"), raw.get("band")
    status, importance = raw.get("status"), raw.get("importance")
    if (
        kind not in KINDS
        or position not in POSITIONS
        or band not in BANDS
        or status not in STATUSES
        or importance not in IMPORTANCES
    ):
        filtered.append("invalid_enum")
        return None
    count = raw.get("count")
    count = min(max(count, 1), MAX_COUNT) if isinstance(count, int) and not isinstance(count, bool) else 1

    ground = " ".join(str(raw.get("ground", "")).lower().split())
    if ground and (not LABEL_PATTERN.fullmatch(ground) or len(ground.split()) > MAX_LABEL_WORDS):
        filtered.append("invalid_ground")
        ground = ""

    text: str | None = None
    if kind == "text":
        text = " ".join(str(raw.get("text", "")).split())[:MAX_TEXT_CHARS] or None
        if text and (not text.isprintable() or check_camera_text(text)):
            filtered.append("text_filtered")
            text = None
    return SceneItem(
        label=label,
        count=count,
        kind=kind,
        position=position,
        band=band,
        status=status,
        importance=importance,
        ground=ground or None,
        text=text,
    )

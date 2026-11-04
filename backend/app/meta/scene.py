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

Kind = Literal["object", "possible_obstacle", "level_change", "overhead", "person", "text", "landmark"]
Position = Literal["left", "center", "right"]
Band = Literal["lower", "middle", "upper"]
Status = Literal["new", "still", "moved", "gone"]
Importance = Literal["high", "medium", "low"]
Change = Literal["none", "minor", "major"]
# The next step of a walking route the user follows in the app (ARCHITECTURE 8.6).
RouteNext = Literal["left", "right", "straight", "u-turn", "arrive"]

KINDS: tuple[Kind, ...] = ("object", "possible_obstacle", "level_change", "overhead", "person", "text", "landmark")
POSITIONS: tuple[Position, ...] = ("left", "center", "right")
BANDS: tuple[Band, ...] = ("lower", "middle", "upper")
STATUSES: tuple[Status, ...] = ("new", "still", "moved", "gone")
IMPORTANCES: tuple[Importance, ...] = ("high", "medium", "low")
CHANGES: tuple[Change, ...] = ("none", "minor", "major")
ROUTE_NEXTS: tuple[RouteNext, ...] = ("left", "right", "straight", "u-turn", "arrive")

# Spark's time follows its reasoning, which grows with the items it lists (M4 measurement): the
# default mode needs only the few most walking-relevant things.
MAX_ITEMS = 3
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
You are the scene-understanding module of HeyNavi, an assistant for blind and low-vision people \
who are walking. You get one photo from a phone camera that the user holds pointed ahead, plus \
notes about what was reported in the last few seconds. Report what is visible as JSON matching the \
schema. Be quick: decide fast and keep the reasoning short.

Rules:
- Only report what you can actually see in this photo. Never guess what is outside it.
- Positions are relative to the photo: "position" is its left, center or right third; "band" is its \
lower, middle or upper third.
- Never give distances or sizes in meters, feet or steps. Never say whether anything is safe, clear \
or free of obstacles. Never tell the user to move, walk, turn, stop or be careful. Never describe \
the state of a traffic light or crossing signal.
- Do not identify people or describe faces or bodies; call each one "person".
- summary: one short, neutral sentence about the layout a walker would care about, at most \
{summary_words} words, for example "A hallway with boxes along the left wall." Name only things that \
matter to walking, never screens, pictures or decorations. Do not start it with a verb.
- change: compared with the notes. "major" when this is a different place or the main content is \
different, "minor" when something appeared, moved or disappeared, otherwise "none". With no notes, "major".
- items: at most {max_items}, most relevant to walking first. Judge from the scene, not from a fixed \
list, what could get in the way of someone walking the way the camera points: things on the floor \
or in the walking area (bags, boxes, chairs and other furniture taking floor space, carts, cables), \
stairs, steps, curbs and other changes in floor level, low-hanging or protruding things at head or \
body height, people in the area ahead, doors or doorways, and outdoors crosswalks and intersections. Do not list things that cannot be in \
the way, such as pictures and wall decorations, screens and televisions, things standing on desks, \
tables, shelves or counters, windows, lights and ceilings, unless they stick out into the walking \
area. Report each kind of thing once, with a count.
  - label: the plain name of the thing, a singular English noun of at most 2 words, letters and \
spaces only, with no place in it: "bag", "office chair", "steps", "person"; not "bag on floor".
  - count: how many of that thing are visible; 1 for things you cannot count, like clothing.
  - kind: "possible_obstacle" for a thing on the floor or in the walking area that someone walking \
that way could bump into or trip over; "level_change" for stairs, steps, curbs, ramps and \
drop-offs; "overhead" for low-hanging or protruding things at head or body height; "person"; \
"landmark" for doors, doorways, entrances, elevators, crosswalks and intersections; "text" for a readable sign; "object" for \
anything else.
  - status: compared with the notes: "new", "still" (same place), "moved", or "gone" (in the notes \
but no longer visible; list a gone item only if it mattered).
  - importance: walking relevance. "high" if it is in or right next to the area ahead where someone \
walking that way would go; "medium" if it relates to walking but is off to the side; "low" if it \
cannot affect walking.
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


@dataclass(frozen=True)
class RouteHint:
    """The next step of the walking route the user follows, if any. Only the kind of step and
    whether it is close: never a place, a street or a position."""

    next: RouteNext
    soon: bool


_ROUTE_STEP: dict[RouteNext, str] = {
    "left": "The next turn is to the left",
    "right": "The next turn is to the right",
    "straight": "The route goes straight on for now",
    "u-turn": "The next step is to turn around",
    "arrive": "The destination is the next step",
}


def route_note(route: RouteHint) -> str:
    """Tells Spark what matters more while a route is followed. The route instructions come from
    the map and are spoken separately; Spark's reply stays a description of the photo."""
    step = _ROUTE_STEP[route.next] + (", coming up soon." if route.soon and route.next != "straight" else ".")
    matters = (
        "Entrances, doors, steps and signs with text matter more now."
        if route.next == "arrive"
        else "Corners, crosswalks, curbs and intersections matter more now."
    )
    return (
        "The user is following walking directions from a map, which HeyNavi gives separately. "
        f"{step} {matters} Still report only what you see in this photo, and never give directions."
    )


def build_scene_request(
    image_data_url: str,
    context: SceneContext,
    *,
    model: str,
    reasoning_effort: str,
    max_output_tokens: int,
    detailed: bool = False,
    route: RouteHint | None = None,
) -> dict[str, Any]:
    instructions = INSTRUCTIONS.format(
        summary_words=MAX_SUMMARY_WORDS_DETAILED if detailed else MAX_SUMMARY_WORDS,
        max_items=MAX_ITEMS_DETAILED if detailed else MAX_ITEMS,
    )
    # Notes that change per frame go after the fixed instructions, so the prompt cache still works.
    user_text = (
        context_notes(context)
        + (f"\n\n{route_note(route)}" if route else "")
        + (f"\n\n{DETAIL_NOTE}" if detailed else "")
    )
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


_IMPORTANCE_RANK: dict[str, int] = {"high": 0, "medium": 1, "low": 2}
_KIND_RANK: dict[str, int] = {
    "possible_obstacle": 0, "level_change": 0, "overhead": 0, "person": 1, "landmark": 2, "object": 3, "text": 4,
}
# What SAM checks: things that matter to walking. Everything else keeps the SAM budget.
_WALKING_KINDS = frozenset({"possible_obstacle", "level_change", "overhead", "person", "landmark"})


def grounding_order(items: list[SceneItem], limit: int) -> list[int]:
    """Indices of the items SAM should check, most walking-relevant first: visible physical
    things that matter to walking (not text, not plain objects, not "low" relevance, not
    "gone") with a ground concept, at most `limit`."""
    candidates = [
        i
        for i, item in enumerate(items)
        if item.ground and item.kind in _WALKING_KINDS and item.importance != "low" and item.status != "gone"
    ]
    candidates.sort(key=lambda i: (_IMPORTANCE_RANK[items[i].importance], _KIND_RANK[items[i].kind], i))
    return candidates[:limit]


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


# A place inside a label ("bag on floor") is not part of the thing's name: HeyNavi says where.
_PLACE_WORDS = frozenset({"on", "in", "at", "near", "by", "under", "beside", "next", "against", "with", "along"})


def clean_label(text: str) -> str:
    words = " ".join(text.lower().split()).split(" ")
    cut = next((i for i, w in enumerate(words) if i > 0 and w in _PLACE_WORDS), len(words))
    return " ".join(words[:cut])


def _parse_item(raw: Any, filtered: list[str]) -> SceneItem | None:
    if not isinstance(raw, dict):
        filtered.append("invalid_item")
        return None
    label = clean_label(str(raw.get("label", "")))
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

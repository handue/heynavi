"""Muse Spark answers a spoken question about the current view (ARCHITECTURE 7.2): prompt, strict
JSON schema, request builder and parser.

The answer is a description, like every camera line: no distances, no safety claims, no walking
directions, and positions in the same frame of reference as the app's own lines (user-relative
only when the phone is held forward). The backend filters it again, and the app checks it once
more before speaking.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Literal

from app.meta.scene import BANDS, LABEL_PATTERN, POSITIONS, Band, Position, SceneContext, clean_label, context_notes
from app.wording import check_camera_text

Hold = Literal["forward", "camera"]

MAX_ANSWER_WORDS = 35
MAX_QUESTION_CHARS = 200
QUESTION_PATTERN = re.compile(r"^[A-Za-z0-9' ,.?!-]{1,200}$")

_POSITION_RULE: dict[Hold, str] = {
    "forward": (
        "The phone is held upright and pointed ahead, so give positions as \"directly ahead\", "
        "\"ahead on your left\" or \"ahead on your right\"."
    ),
    "camera": (
        "Give positions relative to the camera view, as \"on the left of the camera view\", "
        "\"in the center of the camera view\" or \"on the right of the camera view\"."
    ),
}

INSTRUCTIONS = """\
You are HeyNavi, a voice assistant for blind and low-vision people. The user asked a question about \
their surroundings. You get one photo from their phone camera, taken just now, plus notes about \
what was seen in the last few seconds. Answer as JSON matching the schema. Be quick: decide fast \
and keep the reasoning short.

Rules for "answer":
- Answer only from what is visible in this photo and the notes. If what they ask about is not \
visible, say so plainly, for example "I don't see an entrance right now."
- One or two short sentences, at most {max_words} words, plain spoken English.
- {position_rule}
- Never give distances or sizes in meters, feet or steps. Never say whether anything is safe, clear \
or free of obstacles. Never tell the user to move, walk, turn, stop or be careful. Never describe the \
state of a traffic light or crossing signal.
- Do not identify people or describe faces or bodies; call each one "person".
- Do not ask questions back.

"about": the one physical thing the question is mainly about, if any ("where is the entrance" is \
about the entrance). label: its plain singular English name, at most 2 words, letters and spaces \
only; "" for a general question ("what is around me"). ground: the simplest common noun an object \
detector should look for to find it ("door" for an entrance); "" if none. visible: whether you can \
see it in this photo. position and band: where it is in the photo (left, center or right third; \
lower, middle or upper third); use "center" and "middle" when it is not visible.

"search": true only when the user asks where a specific thing is and it is not visible, so HeyNavi \
should keep looking for it with the camera. Never for a general question such as "what is nearby".
"""

ASK_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "answer": {"type": "string"},
        "about": {
            "type": "object",
            "properties": {
                "label": {"type": "string"},
                "ground": {"type": "string"},
                "visible": {"type": "boolean"},
                "position": {"type": "string", "enum": list(POSITIONS)},
                "band": {"type": "string", "enum": list(BANDS)},
            },
            "required": ["label", "ground", "visible", "position", "band"],
            "additionalProperties": False,
        },
        "search": {"type": "boolean"},
    },
    "required": ["answer", "about", "search"],
    "additionalProperties": False,
}


def build_ask_request(
    image_data_url: str,
    question: str,
    context: SceneContext,
    hold: Hold,
    *,
    model: str,
    reasoning_effort: str,
    max_output_tokens: int,
) -> dict[str, Any]:
    instructions = INSTRUCTIONS.format(max_words=MAX_ANSWER_WORDS, position_rule=_POSITION_RULE[hold])
    user_text = f"{context_notes(context)}\n\nThe user asks: {question}"
    return {
        "model": model,
        "input": [
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
        "max_output_tokens": max_output_tokens,
        "text": {"format": {"type": "json_schema", "name": "answer", "schema": ASK_SCHEMA, "strict": True}},
        "stream": False,
        # /v1/responses stores requests by default; frames must never be stored.
        "store": False,
    }


@dataclass(frozen=True)
class AskTarget:
    label: str
    ground: str | None
    visible: bool
    position: Position
    band: Band


@dataclass
class AskParse:
    # None when the answer broke the wording rules (the app then says it cannot answer).
    answer: str | None
    about: AskTarget | None
    search: bool
    filtered: list[str] = field(default_factory=list)


class AskParseError(ValueError):
    """The output is not the answer JSON at all."""


def parse_ask_output(text: str) -> AskParse:
    try:
        data = json.loads(text)
    except ValueError:
        raise AskParseError("output is not JSON") from None
    if not isinstance(data, dict) or not isinstance(data.get("answer"), str) or not isinstance(data.get("about"), dict):
        raise AskParseError("output is missing answer or about")
    filtered: list[str] = []

    answer: str | None = " ".join(data["answer"].split())
    if not answer:
        answer = None
    elif len(answer.split()) > MAX_ANSWER_WORDS + 10:
        filtered.append("answer_too_long")
        answer = None
    elif reason := check_camera_text(answer):
        filtered.append(f"answer_{reason}")
        answer = None

    raw = data["about"]
    label = clean_label(str(raw.get("label", "")))
    ground = clean_label(str(raw.get("ground", "")))
    position, band = raw.get("position"), raw.get("band")
    about: AskTarget | None = None
    if label and LABEL_PATTERN.fullmatch(label) and not check_camera_text(label) and position in POSITIONS and band in BANDS:
        about = AskTarget(
            label=label,
            ground=ground if ground and LABEL_PATTERN.fullmatch(ground) else None,
            visible=raw.get("visible") is True,
            position=position,
            band=band,
        )
    elif label:
        filtered.append("invalid_about")
    # A search needs something to search for.
    search = data.get("search") is True and about is not None and about.ground is not None and not about.visible
    return AskParse(answer=answer, about=about, search=search, filtered=filtered)

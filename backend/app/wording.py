"""Wording filter for anything HeyNavi may speak about the camera view (ARCHITECTURE 6.3).

Camera observations are descriptions. They must never carry a distance, a safety or permission
claim, a movement instruction, or a traffic-signal state, because a monocular camera cannot
support any of those. The app runs the same rules again before speaking (scene/wording.ts).
"""

from __future__ import annotations

import re

_UNITS = (
    r"(?:m|cm|mm|km|meters?|metres?|centimeters?|centimetres?|kilometers?|kilometres?|"
    r"feet|foot|ft|inch(?:es)?|yards?|yd|steps?|paces?|blocks?)"
)
# No bare "a": "a step" or "a block" names an object; "a meter" is caught by the next rule.
_NUMBER = r"(?:\d+(?:[.,]\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|a few|few|several|half a)"

# Each rule: (reason, pattern). Patterns run on the lowercased text.
_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("distance", re.compile(rf"\b{_NUMBER}[\s-]*{_UNITS}\b")),
    ("distance", re.compile(r"\b(?:meters?|metres?|feet|yards?|inches|centimeters?|centimetres?)\b")),
    # "a step ahead" names a step; counted steps ("two steps ahead") are caught by the first rule.
    ("distance", re.compile(r"\b(?:arm'?s length|within reach|steps? away)\b")),
    ("safety", re.compile(r"\b(?:safe|safely|safety|unsafe|danger(?:ous)?|hazard(?:ous)?|harmless)\b")),
    (
        "safety",
        re.compile(
            r"\b(?:all clear|clear (?:path|way|route|walkway)|(?:path|way|route|walkway|road|floor|sidewalk)"
            r"(?: \w+){0,2} (?:is|looks|seems|appears) (?:clear|free|open|empty)|clear ahead|no obstacles?|"
            r"nothing (?:is )?in (?:your|the) way|unobstructed|obstacle[- ]free|free of obstacles)\b"
        ),
    ),
    (
        "permission",
        re.compile(
            r"\b(?:you (?:can|could|may|should|must|need to|have to|'ll be able to) "
            r"(?:walk|go|cross|proceed|move|continue|pass|step|turn)|go ahead|it'?s (?:fine|okay|ok) to)\b"
        ),
    ),
    (
        "direction",
        re.compile(
            r"(?:^|[.!?;]\s*)(?:please\s+)?(?:walk|turn|step|move|go|head|proceed|cross|keep|stop|"
            r"watch out|be careful|careful|avoid|veer|wait)\b"
        ),
    ),
    ("signal", re.compile(r"\b(?:green|red|amber|yellow) (?:light|signal|man)\b")),
    (
        "signal",
        re.compile(
            r"\b(?:light|signal|traffic light|crossing light|pedestrian light) (?:is|turned|shows|says) "
            r"(?:green|red|amber|yellow|walk|on|off)\b|\bwalk signal\b"
        ),
    ),
    # TTS must never say the wake word: the microphone would hear HeyNavi call itself.
    ("wake_word", re.compile(r"\bnav(?:i|y|vy|ie)\b")),
)


def check_camera_text(text: str) -> str | None:
    """The first rule `text` breaks, or None when it may be spoken as a camera observation."""
    lowered = text.lower().replace("’", "'")
    for reason, pattern in _RULES:
        if pattern.search(lowered):
            return reason
    return None

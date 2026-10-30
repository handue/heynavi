from __future__ import annotations

import pytest

from app.wording import check_camera_text


@pytest.mark.parametrize(
    "text",
    [
        "A hallway with a door on the right.",
        "A kitchen with a table in the center.",
        "A step down in the lower center of the view.",
        "There's a step ahead on your left.",
        "A person walking on the left.",
        "A crosswalk in the center of the view.",
        "A stop sign on the right.",
        "Two chairs near a window.",
        "A wooden block on the floor.",
        "A street with parked cars and a bus stop.",
        "It looks far away.",
    ],
)
def test_allows_plain_descriptions(text: str) -> None:
    assert check_camera_text(text) is None


@pytest.mark.parametrize(
    ("text", "reason"),
    [
        ("A door about 3 meters ahead.", "distance"),
        ("A chair 2m in front.", "distance"),
        ("A table two steps away.", "distance"),
        ("A bench a few feet to the left.", "distance"),
        ("The door is a few steps ahead.", "distance"),
        ("A box half a metre away.", "distance"),
        ("The bin is a step away.", "distance"),
        ("The path is clear.", "safety"),
        ("The path ahead is clear.", "safety"),
        ("The sidewalk in front looks free.", "safety"),
        ("It is safe to continue.", "safety"),
        ("No obstacles in view.", "safety"),
        ("Nothing in your way.", "safety"),
        ("You can walk forward.", "permission"),
        ("Go ahead, the hallway is empty.", "permission"),
        ("Turn left at the door.", "direction"),
        ("A box ahead. Step around it.", "direction"),
        ("Watch out for the chair.", "direction"),
        ("Be careful near the stairs.", "direction"),
        ("The light is green.", "signal"),
        ("A red light above the crossing.", "signal"),
        ("A walk signal on the pole.", "signal"),
        ("Hey Navi is listening.", "wake_word"),
    ],
)
def test_blocks_claims_the_camera_cannot_support(text: str, reason: str) -> None:
    assert check_camera_text(text) == reason


def test_is_case_and_apostrophe_insensitive() -> None:
    assert check_camera_text("ALL CLEAR") == "safety"
    assert check_camera_text("It’s fine to cross.") == "permission"

from __future__ import annotations

from app.meta.sam import build_sam_request

DATA_URL = "data:image/jpeg;base64,/9j/AAAA"


def test_request_matches_documented_shape() -> None:
    assert build_sam_request("chair", DATA_URL, model="sam-3.1") == {
        "model": "sam-3.1",
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "chair"},
                    {"type": "input_image", "image_url": DATA_URL},
                ],
            }
        ],
        "stream": False,
        "store": False,
        "metadata": {"include_confidence": "true", "mask_encoding": "one_bit"},
    }


def test_store_is_always_false() -> None:
    req = build_sam_request("door", DATA_URL, model="sam-3.1", include_confidence=False)
    assert req["store"] is False


def test_metadata_values_are_strings() -> None:
    for include in (True, False):
        req = build_sam_request("cup", DATA_URL, model="m", include_confidence=include, mask_encoding="lossless")
        assert all(isinstance(v, str) for v in req["metadata"].values())
    assert build_sam_request("cup", DATA_URL, model="m", include_confidence=False)["metadata"][
        "include_confidence"
    ] == "false"


def test_model_and_concept_are_passed_through() -> None:
    req = build_sam_request("water bottle", DATA_URL, model="sam-x")
    assert req["model"] == "sam-x"
    assert req["input"][0]["content"][0]["text"] == "water bottle"

from __future__ import annotations

import time

import pytest

from app.meta.sam import SamDetection, parse_sam_output


def box(x1: float, y1: float, x2: float, y2: float, w: int = 537, h: int = 561, c: float | None = 0.91) -> str:
    conf = f";c={c}" if c is not None else ""
    return f"<|box;x1={x1};y1={y1};x2={x2};y2={y2};w={w};h={h}{conf}|>"


MASK = "<|mask;x=0;y=0;c=0.91;data=!abc|>"


def test_single_record() -> None:
    text = f"<0f>0{box(353, 382, 453, 427)}{MASK}"
    [det] = parse_sam_output(text)
    assert det == SamDetection(
        frame=0, index=0, x1=353, y1=382, x2=453, y2=427, width=537, height=561, confidence=0.91
    )


def test_multiple_comma_separated_records() -> None:
    text = f"<0f>0{box(10, 10, 50, 50, c=0.8)}{MASK},1{box(300, 20, 400, 90, c=0.6)}{MASK},2{box(480, 100, 530, 200, c=0.45)}{MASK}"
    dets = parse_sam_output(text)
    assert [d.index for d in dets] == [0, 1, 2]
    assert [d.confidence for d in dets] == [0.8, 0.6, 0.45]
    assert [d.x1 for d in dets] == [10, 300, 480]


@pytest.mark.parametrize(
    "token",
    [
        "<|box;c=0.77;x1=1;y1=2;x2=3;y2=4;w=10;h=10|>",
        "<|box;x1=1;c=0.77;y1=2;x2=3;y2=4;w=10;h=10|>",
        "<|box;h=10;w=10;y2=4;x2=3;y1=2;x1=1;c=0.77|>",
    ],
)
def test_confidence_in_any_field_position(token: str) -> None:
    [det] = parse_sam_output(f"<0f>0{token}{MASK}")
    assert (det.x1, det.y1, det.x2, det.y2, det.width, det.height) == (1, 2, 3, 4, 10, 10)
    assert det.confidence == 0.77


def test_without_confidence() -> None:
    [det] = parse_sam_output(f"<0f>0{box(1, 2, 3, 4, c=None)}<|mask;x=0;y=0;data=~xyz|>")
    assert det.confidence is None


def test_unknown_fields_are_ignored() -> None:
    [det] = parse_sam_output("<0f>0<|box;x1=1;y1=2;x2=3;y2=4;w=10;h=10;c=0.5;id=7;label=chair|>")
    assert det.confidence == 0.5


def test_mask_data_with_commas_semicolons_and_angle_brackets() -> None:
    # Mask data may contain anything except "|>", including things that look like
    # separators, frame markers and even a box token.
    nasty = "<|mask;x=0;y=0;c=0.9;data=!a,b;c<d,1<|box;x1=0;y1=0;x2=1;y2=1;w=2;h=2;c=1<5f>>,,;;<|>"
    text = f"<0f>0{box(10, 20, 30, 40, c=0.9)}{nasty},1{box(50, 60, 70, 80, c=0.7)}{MASK}"
    dets = parse_sam_output(text)
    assert [(d.frame, d.index, d.x1) for d in dets] == [(0, 0, 10), (0, 1, 50)]


def test_multiple_frame_lines() -> None:
    text = (
        f"<0f>0{box(1, 1, 5, 5)}{MASK},1{box(6, 6, 9, 9)}{MASK}\n"
        f"<1f>\n"
        f"<2f>0{box(2, 2, 8, 8)}{MASK}\n"
    )
    dets = parse_sam_output(text)
    assert [(d.frame, d.index) for d in dets] == [(0, 0), (0, 1), (2, 0)]


def test_frame_lines_without_newlines_between_them() -> None:
    text = f"<0f>0{box(1, 1, 5, 5)}{MASK}<1f>0{box(2, 2, 6, 6)}{MASK}"
    assert [(d.frame, d.index) for d in parse_sam_output(text)] == [(0, 0), (1, 0)]


@pytest.mark.parametrize("text", ["", "   ", "\n\n", "<0f>", "<0f>\n"])
def test_empty_output_means_no_matches(text: str) -> None:
    assert parse_sam_output(text) == []


@pytest.mark.parametrize(
    "bad_box",
    [
        "<|box;x1=1;y1=2;x2=3;w=10;h=10;c=0.9|>",  # missing y2
        "<|box;x1=a;y1=2;x2=3;y2=4;w=10;h=10|>",  # not a number
        "<|box;x1=1;y1=2;x2=3;y2=4;w=0;h=10|>",  # zero width
        "<|box;x1=5;y1=2;x2=3;y2=4;w=10;h=10|>",  # x2 < x1
        "<|box;x1=1;y1=2;x2=3;y2=4;w=10;h=10;c=high|>",  # bad confidence
        "<|box;x1=nan;y1=2;x2=3;y2=4;w=10;h=10|>",  # non-finite
        "<|box;garbage|>",
    ],
)
def test_malformed_record_is_skipped_not_raised(bad_box: str) -> None:
    text = f"<0f>0{bad_box}{MASK},1{box(1, 1, 2, 2, w=10, h=10, c=0.6)}{MASK}"
    dets = parse_sam_output(text)
    assert [(d.index, d.confidence) for d in dets] == [(1, 0.6)]


def test_unterminated_token_does_not_raise() -> None:
    text = f"<0f>0{box(1, 1, 2, 2, w=10, h=10)}{MASK},1<|box;x1=3;y1=3"
    assert [d.index for d in parse_sam_output(text)] == [0]


def test_many_unterminated_tokens_parse_in_linear_time() -> None:
    text = f"<0f>0{box(1, 1, 2, 2, w=10, h=10)}{MASK}," + "<|a;" * 50_000
    started = time.perf_counter()
    dets = parse_sam_output(text)
    assert time.perf_counter() - started < 0.25  # the old regex scan took many seconds
    assert [d.index for d in dets] == [0]


def test_long_runs_before_a_token_stay_fast_and_do_not_raise() -> None:
    # A huge digit run is more than int() accepts: it falls back to the position index.
    text = "<0f>" + "1" * 50_000 + box(1, 1, 2, 2, w=10, h=10) + "<" * 50_000 + "<|" * 50_000 + "|>"
    started = time.perf_counter()
    [det] = parse_sam_output(text)
    assert time.perf_counter() - started < 0.25
    assert det.index == 0


def test_tokens_after_an_unterminated_one_are_ignored() -> None:
    text = f"<0f>0{box(1, 1, 2, 2, w=10, h=10)},1<|box;x1=3;y1=3,2<|mask;data=!"
    assert [d.index for d in parse_sam_output(text)] == [0]


def test_missing_ordinal_falls_back_to_position() -> None:
    text = f"<0f>{box(1, 1, 2, 2, w=10, h=10)}{MASK},{box(3, 3, 4, 4, w=10, h=10)}{MASK}"
    assert [d.index for d in parse_sam_output(text)] == [0, 1]


# ----- derived properties -----


def det(x1: float, y1: float, x2: float, y2: float, w: int = 100, h: int = 100) -> SamDetection:
    return SamDetection(frame=0, index=0, x1=x1, y1=y1, x2=x2, y2=y2, width=w, height=h, confidence=0.9)


def test_normalized_box_treats_x2_y2_as_inclusive() -> None:
    d = det(0, 0, 49, 24, w=100, h=50)
    assert d.box_norm == (0.0, 0.0, 0.5, 0.5)
    assert d.area_fraction == pytest.approx(0.25)
    assert d.center_x == pytest.approx(0.25)


def test_full_frame_box_is_clamped_to_one() -> None:
    d = det(0, 0, 99, 99)
    assert d.box_norm == (0.0, 0.0, 1.0, 1.0)
    assert d.area_fraction == pytest.approx(1.0)


def test_out_of_range_coordinates_are_clamped() -> None:
    d = det(-20, -5, 150, 120)
    assert d.box_norm == (0.0, 0.0, 1.0, 1.0)


def test_thirds_boundaries_exact() -> None:
    # w=300: a box spanning [0, 200) has center exactly 1/3 -> "center";
    # a box spanning [100, 300) has center exactly 2/3 -> "center".
    assert det(0, 0, 199, 9, w=300).center_x == pytest.approx(1 / 3)
    assert det(0, 0, 199, 9, w=300).horizontal_third == "center"
    assert det(100, 0, 299, 9, w=300).center_x == pytest.approx(2 / 3)
    assert det(100, 0, 299, 9, w=300).horizontal_third == "center"
    # Just past each boundary.
    assert det(0, 0, 198, 9, w=300).horizontal_third == "left"
    assert det(101, 0, 299, 9, w=300).horizontal_third == "right"


def test_thirds_typical_positions() -> None:
    assert det(0, 0, 19, 9).horizontal_third == "left"
    assert det(40, 0, 59, 9).horizontal_third == "center"
    assert det(80, 0, 99, 9).horizontal_third == "right"

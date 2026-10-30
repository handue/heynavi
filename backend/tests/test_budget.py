from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pytest

from app.budget import UsageMeter
from app.pricing import estimate_cost


class Clock:
    def __init__(self, day: date) -> None:
        self.day = day

    def __call__(self) -> date:
        return self.day


def test_counts_cost_at_list_price_and_trips_at_the_limit() -> None:
    meter = UsageMeter(0.01, today=Clock(date(2026, 10, 30)))
    assert not meter.exhausted()
    assert meter.add(sam_images=2) == pytest.approx(0.005)
    assert not meter.exhausted()
    meter.add(input_tokens=1000, output_tokens=1000)  # 0.00125 + 0.00425
    assert meter.spent_today_usd() == pytest.approx(estimate_cost(2, 1000, 1000))
    assert meter.exhausted()


def test_resets_on_a_new_day() -> None:
    clock = Clock(date(2026, 10, 30))
    meter = UsageMeter(0.001, today=clock)
    meter.add(sam_images=1)
    assert meter.exhausted()
    clock.day = date(2026, 10, 31)
    assert not meter.exhausted()
    assert meter.spent_today_usd() == 0


def test_survives_a_restart_through_the_file(tmp_path: Path) -> None:
    path = tmp_path / "var" / "usage.json"
    clock = Clock(date(2026, 10, 30))
    UsageMeter(1.0, path, today=clock).add(sam_images=4, input_tokens=10, output_tokens=20)
    data = json.loads(path.read_text())
    assert data == {"day": "2026-10-30", "sam_images": 4, "spark_input_tokens": 10, "spark_output_tokens": 20}
    again = UsageMeter(1.0, path, today=clock)
    assert again.spent_today_usd() == pytest.approx(estimate_cost(4, 10, 20))
    # Yesterday's file does not count today.
    assert UsageMeter(1.0, path, today=Clock(date(2026, 10, 31))).spent_today_usd() == 0


def test_a_broken_file_starts_at_zero(tmp_path: Path) -> None:
    path = tmp_path / "usage.json"
    path.write_text("{not json")
    meter = UsageMeter(1.0, path, today=Clock(date(2026, 10, 30)))
    assert meter.spent_today_usd() == 0
    meter.add(sam_images=1)
    assert json.loads(path.read_text())["sam_images"] == 1

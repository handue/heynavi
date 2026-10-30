"""Daily spending guard (ARCHITECTURE 10). Counts SAM images and Spark tokens at list price per
UTC day and refuses new Meta calls once DAILY_BUDGET_USD is reached, so a runaway loop cannot
drain the hackathon credits. The day's totals survive a restart through a small JSON file.
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime
from pathlib import Path

from app.pricing import estimate_cost

log = logging.getLogger("heynavi.budget")


@dataclass
class DayUsage:
    day: str
    sam_images: int = 0
    spark_input_tokens: int = 0
    spark_output_tokens: int = 0

    @property
    def usd(self) -> float:
        return estimate_cost(self.sam_images, self.spark_input_tokens, self.spark_output_tokens)


def _utc_today() -> date:
    return datetime.now(UTC).date()


class UsageMeter:
    def __init__(
        self,
        daily_limit_usd: float,
        path: Path | None = None,
        today: Callable[[], date] = _utc_today,
    ) -> None:
        self.daily_limit_usd = daily_limit_usd
        self._path = path
        self._today = today
        self._usage = self._load()

    def _current(self) -> DayUsage:
        day = self._today().isoformat()
        if self._usage.day != day:
            self._usage = DayUsage(day)
        return self._usage

    def exhausted(self) -> bool:
        return self._current().usd >= self.daily_limit_usd

    def spent_today_usd(self) -> float:
        return self._current().usd

    def add(self, sam_images: int = 0, input_tokens: int = 0, output_tokens: int = 0) -> float:
        """Records one call and returns its estimated cost in USD."""
        usage = self._current()
        usage.sam_images += sam_images
        usage.spark_input_tokens += input_tokens
        usage.spark_output_tokens += output_tokens
        self._save()
        return estimate_cost(sam_images, input_tokens, output_tokens)

    def _load(self) -> DayUsage:
        today = self._today().isoformat()
        if self._path is None or not self._path.exists():
            return DayUsage(today)
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            usage = DayUsage(
                day=str(data["day"]),
                sam_images=int(data["sam_images"]),
                spark_input_tokens=int(data["spark_input_tokens"]),
                spark_output_tokens=int(data["spark_output_tokens"]),
            )
        except (OSError, ValueError, KeyError, TypeError):
            log.warning("could not read %s; starting the day's usage at zero", self._path)
            return DayUsage(today)
        return usage if usage.day == today else DayUsage(today)

    def _save(self) -> None:
        if self._path is None:
            return
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(".tmp")
            tmp.write_text(json.dumps(asdict(self._usage)), encoding="utf-8")
            os.replace(tmp, self._path)
        except OSError:
            log.warning("could not write %s; usage is kept in memory only", self._path)

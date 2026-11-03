"""Results table from the app's metric lines (PLAN M7: "numbers in the README are real").

Reads `[heynavi-metrics] {...}` lines from the backend's metrics file (`var/metrics.jsonl`, what
release builds upload) and from saved Metro logs (plain text), and prints a Markdown table:
latencies as p50 / p95, SAM agreement, lines and cost per minute, stop latency, route events.

    cd backend && .venv/bin/python -m scripts.results                     # var/metrics.jsonl
    cd backend && .venv/bin/python -m scripts.results metro.log --since 2026-11-03

The lines hold timings, counts and decisions only (no frames, coordinates or transcripts), so the
table can be pasted into the README as it is.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

TAG = "[heynavi-metrics] "
DEFAULT_FILE = Path(__file__).resolve().parent.parent / "var" / "metrics.jsonl"


@dataclass(frozen=True)
class Metric:
    """One metric line: its fields, which file it came from, and its app session if known."""

    fields: dict[str, Any]
    source: str
    session: str | None = None
    t: float | None = None


def read_metrics(path: Path, since: float | None = None) -> Iterator[Metric]:
    """Metric lines from a metrics.jsonl file or a plain-text log. Unparseable lines are skipped."""
    with path.open(encoding="utf-8", errors="replace") as lines:
        for raw in lines:
            raw = raw.strip()
            session: str | None = None
            t: float | None = None
            if raw.startswith("{"):
                try:
                    wrapper = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if not isinstance(wrapper, dict) or not isinstance(wrapper.get("line"), str):
                    continue
                session, t, raw = wrapper.get("session"), wrapper.get("t"), wrapper["line"]
            at = raw.find(TAG)
            if at < 0:
                continue
            try:
                fields = json.loads(raw[at + len(TAG) :])
            except json.JSONDecodeError:
                continue
            if not isinstance(fields, dict):
                continue
            # Plain-text logs carry no time: --since keeps only timed lines after it.
            if since is not None and (t is None or t < since):
                continue
            yield Metric(fields, str(path), session, t)


def percentile(values: list[float], p: float) -> float | None:
    """Linear interpolation between closest ranks, like the app's lib/stats.ts and NumPy."""
    if not values:
        return None
    ordered = sorted(values)
    rank = p / 100 * (len(ordered) - 1)
    low, high = int(rank), min(int(rank) + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (rank - low)


def _numbers(metrics: Iterable[Metric], key: str) -> list[float]:
    out: list[float] = []
    for m in metrics:
        value = m.fields.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            out.append(float(value))
    return out


@dataclass
class Results:
    rows: list[tuple[str, str, str, str]] = field(default_factory=list)
    counts: list[tuple[str, str]] = field(default_factory=list)


def _ms_row(label: str, values: list[float]) -> tuple[str, str, str, str]:
    def fmt(v: float | None) -> str:
        return "–" if v is None else f"{v / 1000:.2f} s" if v >= 1000 else f"{v:.0f} ms"

    return (label, str(len(values)), fmt(percentile(values, 50)), fmt(percentile(values, 95)))


def _session_totals(summaries: list[Metric]) -> dict[str, float]:
    """Sums the last scene-summary of each run. Summaries are cumulative within a run; a run ends
    where the counters go back down (a new session in the same log)."""
    totals: Counter[str] = Counter()
    last: dict[str, dict[str, Any]] = {}
    for m in summaries:
        key = f"{m.source}:{m.session}"
        prev = last.get(key)
        calls = (m.fields.get("calls") or 0) + (m.fields.get("failures") or 0)
        if prev is not None and calls < (prev.get("calls") or 0) + (prev.get("failures") or 0):
            _add_run(totals, prev)
        last[key] = m.fields
    for fields in last.values():
        _add_run(totals, fields)
    return dict(totals)


def _add_run(totals: Counter[str], fields: dict[str, Any]) -> None:
    for key in ("calls", "failures", "lines", "activeMin", "costUsd"):
        value = fields.get(key)
        if isinstance(value, (int, float)):
            totals[key] += value


def summarize(metrics: list[Metric]) -> Results:
    by_reason: dict[str, list[Metric]] = {}
    for m in metrics:
        by_reason.setdefault(str(m.fields.get("reason")), []).append(m)
    scene = by_reason.get("scene", [])
    ask = by_reason.get("ask", [])
    results = Results()

    results.rows += [
        _ms_row("Scene look: phone round trip (Spark + SAM)", _numbers(scene, "rttMs")),
        _ms_row("Muse Spark per look", _numbers(scene, "sparkMs")),
        _ms_row("SAM 3.1 checks per look (parallel, slowest)", _numbers(scene, "samMs")),
        _ms_row("Photo taken to decision", _numbers(scene, "totalMs")),
        _ms_row("Photo taken to speech starting", _numbers(by_reason.get("scene-spoken", []), "frameToSpeechMs")),
        _ms_row("Question: photo taken to answer", _numbers(ask, "totalMs")),
    ]
    stops = [
        float(s["ms"])
        for m in by_reason.get("stop-latency", [])
        for s in m.fields.get("samples") or []
        if isinstance(s, dict) and isinstance(s.get("ms"), (int, float))
    ]
    results.rows.append(_ms_row("Stop: command to speech cut off", stops))
    route = by_reason.get("route", [])
    results.rows += [
        _ms_row("Route: MapKit place search", _numbers([m for m in route if m.fields.get("event") == "search"], "searchMs")),
        _ms_row("Route: MapKit walking route", _numbers([m for m in route if "routeMs" in m.fields], "routeMs")),
    ]

    found = checked = 0
    for m in scene:
        grounded = m.fields.get("grounded")
        if isinstance(grounded, str) and "/" in grounded:
            a, _, b = grounded.partition("/")
            if a.isdigit() and b.isdigit():
                found, checked = found + int(a), checked + int(b)
    totals = _session_totals(by_reason.get("scene-summary", []))
    notes = Counter(str(m.fields.get("note")) for m in scene)
    spoken = sum(n for note, n in notes.items() if note in {"first-look", "summary", "item", "describe"})
    minutes = totals.get("activeMin", 0.0)
    cost = sum(_numbers(scene, "costUsd")) + sum(_numbers(ask, "costUsd"))

    results.counts += [
        ("Scene looks", f"{len(scene)} ({int(totals.get('failures', 0))} failed)"),
        ("SAM confirmed Spark's walking-relevant items", f"{found} of {checked}" + (f" ({found / checked:.0%})" if checked else "")),
        ("Looks that led to a line", f"{spoken} of {len(scene)}" + (f" ({spoken / len(scene):.0%})" if scene else "")),
        ("Why the other looks stayed quiet", ", ".join(f"{note} {n}" for note, n in notes.most_common() if note not in {"first-look", "summary", "item", "describe"}) or "–"),
        ("Observing time", f"{minutes:.1f} min"),
        ("Lines per minute while observing", f"{totals.get('lines', 0) / minutes:.1f}" if minutes else "–"),
        ("Meta API cost (estimated from usage)", f"${cost:.2f}" + (f", ${totals.get('costUsd', 0.0) / minutes:.3f} per observing minute" if minutes else "")),
        ("Questions answered", f"{sum(1 for m in ask if m.fields.get('answered'))} of {len(ask)}"),
    ]
    events = Counter(str(m.fields.get("event")) for m in route)
    if events:
        results.counts.append(("Route events", ", ".join(f"{e} {n}" for e, n in sorted(events.items()))))
    return results


def markdown(results: Results) -> str:
    out = ["| Measure | n | p50 | p95 |", "|---|---|---|---|"]
    out += [f"| {label} | {n} | {p50} | {p95} |" for label, n, p50, p95 in results.rows if n != "0"]
    out += ["", "| Count | Value |", "|---|---|"]
    out += [f"| {label} | {value} |" for label, value in results.counts]
    return "\n".join(out)


def _parse_since(value: str) -> float:
    try:
        return float(value)
    except ValueError:
        moment = datetime.fromisoformat(value)
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=timezone.utc)
        return moment.timestamp()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("files", nargs="*", type=Path, help=f"metrics.jsonl or Metro logs (default: {DEFAULT_FILE})")
    parser.add_argument("--since", type=_parse_since, help="only uploaded lines at or after this time (ISO date or epoch s)")
    args = parser.parse_args(argv)
    files: list[Path] = args.files or [DEFAULT_FILE]
    metrics: list[Metric] = []
    for path in files:
        if not path.exists():
            print(f"not found: {path}", file=sys.stderr)
            return 1
        metrics += read_metrics(path, args.since)
    print(f"{len(metrics)} metric lines from {len(files)} file(s)\n")
    print(markdown(summarize(metrics)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

from __future__ import annotations

import json
from pathlib import Path

from scripts.results import main, percentile, read_metrics, summarize


def metric_line(**fields: object) -> str:
    return "[heynavi-metrics] " + json.dumps(fields)


def test_reads_uploaded_and_metro_lines_and_skips_the_rest(tmp_path: Path) -> None:
    uploaded = tmp_path / "metrics.jsonl"
    uploaded.write_text(
        "\n".join(
            [
                json.dumps({"t": 100.0, "session": "a", "line": metric_line(reason="scene", rttMs=4000)}),
                json.dumps({"t": 200.0, "session": "a", "line": "[heynavi-voice] heard something"}),
                "not json",
                json.dumps({"t": 300.0, "session": "a", "line": metric_line(reason="scene", rttMs=5000)}),
            ]
        )
    )
    metro = tmp_path / "metro.log"
    metro.write_text(f" LOG  {metric_line(reason='ask', totalMs=2400, answered=True)}\n LOG  [heynavi] other\n")
    assert [m.fields["rttMs"] for m in read_metrics(uploaded)] == [4000, 5000]
    assert [m.fields["rttMs"] for m in read_metrics(uploaded, since=250)] == [5000]
    assert [m.fields["reason"] for m in read_metrics(metro)] == ["ask"]
    assert list(read_metrics(metro, since=0)) == [], "plain-text lines have no time"


def test_summarizes_latency_agreement_and_runs(tmp_path: Path) -> None:
    lines = [
        metric_line(reason="scene", rttMs=4000, sparkMs=3000, samMs=600, totalMs=5000, grounded="2/3", note="first-look", costUsd=0.01),
        metric_line(reason="scene", rttMs=6000, sparkMs=5000, samMs=800, totalMs=7000, grounded="1/1", note="nothing-new", costUsd=0.01),
        metric_line(reason="scene-spoken", frameToSpeechMs=5500),
        metric_line(reason="stop-latency", samples=[{"source": "voice", "ms": 12}, {"source": "button", "ms": 30}]),
        metric_line(reason="route", event="search", searchMs=700),
        metric_line(reason="route", event="start", routeMs=150),
        # Two runs in one log: cumulative summaries, the second run starts again from zero.
        metric_line(reason="scene-summary", calls=10, failures=0, lines=4, activeMin=1.0, costUsd=0.1),
        metric_line(reason="scene-summary", calls=20, failures=1, lines=8, activeMin=2.0, costUsd=0.2),
        metric_line(reason="scene-summary", calls=5, failures=0, lines=2, activeMin=0.5, costUsd=0.05),
    ]
    log = tmp_path / "metro.log"
    log.write_text("\n".join(lines))
    results = summarize(list(read_metrics(log)))
    rows = {label: (n, p50, p95) for label, n, p50, p95 in results.rows}
    assert rows["Scene look: phone round trip (Spark + SAM)"] == ("2", "5.00 s", "5.90 s")
    assert rows["Stop: command to speech cut off"][0] == "2"
    assert rows["Route: MapKit walking route"] == ("1", "150 ms", "150 ms")
    counts = dict(results.counts)
    assert counts["Scene looks"] == "2 (1 failed)"
    assert counts["SAM confirmed Spark's walking-relevant items"] == "3 of 4 (75%)"
    assert counts["Looks that led to a line"] == "1 of 2 (50%)"
    assert counts["Observing time"] == "2.5 min"
    assert counts["Lines per minute while observing"] == "4.0"
    assert counts["Route events"] == "search 1, start 1"
    assert main([str(log)]) == 0


def test_percentile_matches_the_app() -> None:
    assert percentile([], 50) is None
    assert percentile([1, 2, 3, 4], 50) == 2.5
    assert percentile([10], 95) == 10

"""The Day-0 bench, run end to end against mocked Meta endpoints (never the real API)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest
import respx

from app.settings import ENV_FILE
from scripts import bench
from tests.conftest import BASE_URL, TEST_KEY, make_settings

SAM_TEXT = "<0f>0<|box;x1=10;y1=10;x2=20;y2=40;w=36;h=64;c=0.88|><|mask;x=0;y=0;c=0.88;data=!,;<|>"
MODELS = {"data": [{"id": "sam-3.1"}, {"id": "muse-spark-1.3"}]}


def sam_ok() -> httpx.Response:
    return httpx.Response(
        200,
        json={"id": "r", "status": "completed",
              "output": [{"type": "message", "content": [{"type": "output_text", "text": SAM_TEXT}]}]},
    )


def spark_reply(content: str, finish_reason: str = "stop") -> httpx.Response:
    return httpx.Response(200, json={
        "choices": [{"message": {"content": content}, "finish_reason": finish_reason}],
        "usage": {"prompt_tokens": 800, "completion_tokens": 100},
    })


def ok_record(ms: float, **extra: object) -> dict[str, object]:
    return {"ok": True, "ms": ms, **extra}


def error_record(status: int | None, error: str, **extra: object) -> dict[str, object]:
    return {"ok": False, "ms": 5.0, "status": status, "error": error, "message": "x", **extra}


@pytest.fixture
def results_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "results"
    monkeypatch.setattr(bench, "RESULTS_DIR", path)
    monkeypatch.setattr(bench, "G3_RETRY_DELAY_SECONDS", 0.0)
    monkeypatch.setattr("app.meta.client.MAX_JITTER_SECONDS", 0.0)
    return path


def saved_results(results_dir: Path) -> tuple[str, dict[str, object]]:
    [saved] = results_dir.glob("bench-*.json")
    text = saved.read_text()
    return text, json.loads(text)


def run(argv: list[str], **settings: object) -> int:
    args = bench.parse_args(argv)
    args.images = args.images.resolve()
    return asyncio.run(bench._run(args, make_settings(**settings)))


def test_percentile_and_summary() -> None:
    assert bench.percentile([4, 1, 3, 2], 50) == 2.5
    assert bench.percentile([1, 2, 3, 4], 95) == pytest.approx(3.85)
    assert bench.percentile([7], 95) == 7
    assert bench.summarize_ms([]) == {"n": 0}
    assert bench.summarize_ms([100, 300, 200]) == {"n": 3, "p50": 200, "p95": 290, "min": 100, "max": 300}


def test_cost_estimate() -> None:
    assert bench.estimate_cost(41, 0, 0) == pytest.approx(0.1025)
    assert bench.estimate_cost(0, 1_000_000, 1_000_000) == pytest.approx(1.25 + 4.25)


def test_g2_passes_only_with_low_error_rate_and_no_timeouts() -> None:
    fast = [ok_record(100.0) for _ in range(18)]
    two_errors = bench.g2_stats(fast + [error_record(500, "http_500")] * 2, 20_000)
    assert two_errors["pass"] is True and two_errors["error_rate"] == 0.1  # 10% is allowed
    three_errors = bench.g2_stats(fast[:17] + [error_record(500, "http_500")] * 3, 20_000)
    assert three_errors["pass"] is False and three_errors["p50"] == 100  # fast, but 15% errors
    one_timeout = bench.g2_stats(fast + [ok_record(100.0), error_record(None, "timeout")], 20_000)
    assert one_timeout["pass"] is False
    assert (one_timeout["timeouts"], one_timeout["n"], one_timeout["max"]) == (1, 20, 20_000)  # counted at the timeout


def test_g2_excludes_retried_calls_from_percentiles() -> None:
    records = [ok_record(100.0) for _ in range(9)] + [ok_record(6000.0, retried=True)]
    stats = bench.g2_stats(records, 20_000)
    assert (stats["n"], stats["retried"], stats["max"], stats["errors"]) == (9, 1, 100, 0)
    assert stats["pass"] is True
    assert bench.g2_stats([ok_record(100.0, retried=True)], 20_000)["pass"] is False  # nothing usable
    assert bench.g2_stats([], 20_000)["pass"] is False


@pytest.mark.parametrize(
    ("record", "rejected"),
    [
        (error_record(400, "bad_request"), True),
        (error_record(413, "too_large"), True),
        (error_record(415, "unsupported"), True),
        (error_record(422, "invalid"), True),
        (error_record(429, "rate_limit_exceeded"), False),
        (error_record(500, "http_500"), False),
        (error_record(503, "http_503"), False),
        (error_record(504, "http_504"), False),
        (error_record(None, "timeout"), False),
        (error_record(None, "network_error"), False),
        ({"ok": False, "ms": 1.0, "response_status": "failed"}, False),
        (ok_record(1.0), False),
    ],
)
def test_only_real_4xx_is_a_rejection(record: dict[str, object], rejected: bool) -> None:
    assert bench.is_rejection(record) is rejected


def test_sam_cost_upper_bound_counts_timeouts_5xx_and_retries() -> None:
    calls = [
        ok_record(1.0),
        ok_record(1.0, attempts=2),  # first attempt was a 429/503
        error_record(None, "timeout"),
        error_record(504, "http_504"),
        error_record(500, "http_500"),
        error_record(400, "bad_request"),
        error_record(None, "network_error"),
    ]
    assert bench.sam_images_upper_bound(calls) == (6, 4)


def test_raw_models_text_is_truncated_and_scrubbed() -> None:
    text, truncated = bench.raw_models_text({"items": [{"name": "sam-3.1", "note": TEST_KEY}]}, TEST_KEY)
    assert TEST_KEY not in text and "[redacted]" in text and truncated is False
    big, truncated = bench.raw_models_text({"items": ["m" * 50_000]}, None)
    assert len(big) == 10 * 1024 and truncated is True


def test_invalid_settings_exit_2_with_env_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("MODEL_API_KEY", "LLM_leakcheck_bench value")
    assert bench.main(["--images", str(tmp_path), "--synthetic"]) == bench.EXIT_PRECONDITION
    err = capsys.readouterr().err
    assert str(ENV_FILE) in err and "MODEL_API_KEY" in err
    assert "leakcheck" not in err


def test_sizes_argument() -> None:
    assert bench.parse_args(["--sizes", "640, 768"]).sizes == [640, 768]
    with pytest.raises(SystemExit):
        bench.parse_args(["--sizes", "big"])


def test_missing_key_exits_2_with_env_path(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert run(["--images", str(tmp_path), "--synthetic"]) == bench.EXIT_PRECONDITION
    err = capsys.readouterr().err
    assert str(ENV_FILE) in err and "MODEL_API_KEY=" in err


def test_no_photos_without_synthetic_exits_2(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert run(["--images", str(tmp_path)], model_api_key=TEST_KEY) == bench.EXIT_PRECONDITION
    err = capsys.readouterr().err
    assert "bench/frames" in err and "--synthetic" in err and "JPEG/HEIC/PNG" in err
    assert TEST_KEY not in err


def test_full_synthetic_run_against_mocks(
    tmp_path: Path, results_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    spark_body = {
        "choices": [{"message": {"content": '{"objects": [{"label": "zebra-lamp", "position": "left"}]}'}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 800, "completion_tokens": 100, "completion_tokens_details": {"reasoning_tokens": 60}},
    }
    with respx.mock(base_url=BASE_URL) as router:
        router.get("/models").respond(200, json={"data": [{"id": "sam-3.1"}, {"id": "muse-spark-1.3"}]})
        sam = router.post("/responses").respond(
            200,
            json={"id": "r", "status": "completed",
                  "output": [{"type": "message", "content": [{"type": "output_text", "text": SAM_TEXT}]}]},
        )
        spark = router.post("/chat/completions").respond(200, json=spark_body)
        code = run(
            ["--images", str(tmp_path), "--synthetic", "--n", "2", "--sizes", "64,96", "--spark-n", "1"],
            model_api_key=TEST_KEY,
        )

    out = capsys.readouterr().out
    assert code == bench.EXIT_OK, out
    assert sam.call_count == 1 + 2 * 2  # G3 warm-up + n per size
    assert spark.call_count == 1
    assert all(json.loads(c.request.content)["store"] is False for c in sam.calls)

    [saved] = results_dir.glob("bench-*.json")
    text = saved.read_text()
    assert TEST_KEY not in text and TEST_KEY not in out
    assert "data:image" not in text  # frames are never persisted
    results = json.loads(text)
    gates = results["gates"]
    assert gates["G1"]["sam_listed"] and gates["G1"]["spark_listed"]
    assert gates["G3"]["accepted"] is True and gates["G3"]["verdict"] == "accepted"
    assert set(gates["G2"]) == {"64", "96"} and all(g["pass"] for g in gates["G2"].values())
    assert gates["G4"]["n"] == 1 and gates["G4"]["tokens"]["reasoning_tokens"] == 60
    assert (gates["G4"]["truncated"], gates["G4"]["invalid"]) == (0, 0)
    assert results["calls"]["sam"][0]["max_confidence"] == 0.88
    assert results["calls"]["sam"][0]["retried"] is False
    # Spark's object labels describe the user's photos: only counts are saved.
    assert "zebra-lamp" not in text and "objects" not in results["calls"]["spark"][0]
    assert results["calls"]["spark"][0]["object_count"] == 1
    assert results["estimated_cost_usd"] == pytest.approx(round(5 * 0.0025 + 800 * 1.25e-6 + 100 * 4.25e-6, 4))
    assert results["estimated_cost"] == {"upper_bound": True, "sam_images": 5, "sam_uncertain": 0, "spark_timeouts": 0}
    assert "Estimated cost of this run: at most" in out and "Spark calls timed out: 0" in out
    assert "errors=0/2 (0%), timeouts=0, retried=0 (excluded)" in out


def test_rejected_key_stops_after_g1(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(bench, "RESULTS_DIR", tmp_path / "results")
    with respx.mock(base_url=BASE_URL, assert_all_called=False) as router:
        router.get("/models").respond(401, json={"error": {"code": "invalid_api_key", "message": "no"}})
        sam = router.post("/responses").mock(side_effect=httpx.ConnectError("must not be called"))
        code = run(["--images", str(tmp_path), "--synthetic", "--n", "1"], model_api_key=TEST_KEY)
    assert code == bench.EXIT_GATE_FAILED
    assert not sam.called


def test_g2_fails_on_errors_even_when_fast(
    tmp_path: Path, results_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with respx.mock(base_url=BASE_URL) as router:
        router.get("/models").respond(200, json=MODELS)
        router.post("/responses").mock(
            side_effect=[sam_ok(), sam_ok(), httpx.Response(500, json={"error": {"code": "server_error"}}), sam_ok(), sam_ok()]
        )
        code = run(["--images", str(tmp_path), "--synthetic", "--n", "4", "--sizes", "64", "--skip-spark"],
                   model_api_key=TEST_KEY)
    out = capsys.readouterr().out
    assert code == bench.EXIT_GATE_FAILED, out
    _, results = saved_results(results_dir)
    g2 = results["gates"]["G2"]["64"]
    assert (g2["pass"], g2["errors"], g2["attempted"], g2["error_rate"]) == (False, 1, 4, 0.25)
    assert "G2 SAM   64px         FAIL" in out and "errors=1/4 (25%)" in out


def test_g2_timeout_fails_and_retried_call_is_excluded(
    tmp_path: Path, results_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    rate_limited = httpx.Response(429, headers={"Retry-After": "0"}, json={"error": {"code": "rate_limit_exceeded"}})
    with respx.mock(base_url=BASE_URL) as router:
        router.get("/models").respond(200, json=MODELS)
        sam = router.post("/responses").mock(
            side_effect=[sam_ok(), rate_limited, sam_ok(), httpx.ReadTimeout("slow"), *[sam_ok() for _ in range(8)]]
        )
        code = run(["--images", str(tmp_path), "--synthetic", "--n", "10", "--sizes", "64", "--skip-spark"],
                   model_api_key=TEST_KEY)
    out = capsys.readouterr().out
    assert code == bench.EXIT_GATE_FAILED, out
    assert sam.call_count == 12
    _, results = saved_results(results_dir)
    g2 = results["gates"]["G2"]["64"]
    # 10% errors is allowed, but any timeout fails the size; it is a sample at the timeout value.
    assert (g2["pass"], g2["error_rate"], g2["timeouts"], g2["retried"], g2["n"]) == (False, 0.1, 1, 1, 9)
    assert g2["max"] == 20_000
    assert [c["retried"] for c in results["calls"]["sam"]][:3] == [False, True, False]
    assert "timeouts=1, retried=1 (excluded)" in out and "retried after a back-off" in out
    # Upper bound: 10 answered images + the retried 429 attempt + the timeout.
    assert results["estimated_cost"]["sam_images"] == 12
    assert results["estimated_cost"]["sam_uncertain"] == 2


def test_g3_real_rejection_skips_g2_and_suggests_png(
    tmp_path: Path, results_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with respx.mock(base_url=BASE_URL) as router:
        router.get("/models").respond(200, json=MODELS)
        sam = router.post("/responses").respond(415, json={"error": {"code": "unsupported_media_type"}})
        code = run(["--images", str(tmp_path), "--synthetic", "--n", "2", "--sizes", "64", "--skip-spark"],
                   model_api_key=TEST_KEY)
    out = capsys.readouterr().out
    assert code == bench.EXIT_GATE_FAILED
    assert sam.call_count == 1  # a real 4xx is not retried
    _, results = saved_results(results_dir)
    assert results["gates"]["G3"]["verdict"] == "rejected" and "G2" not in results["gates"]
    assert "REJECTED with HTTP 415" in out and "PNG" in out


def test_g3_transient_failures_are_inconclusive_and_g2_still_runs(
    tmp_path: Path, results_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with respx.mock(base_url=BASE_URL) as router:
        router.get("/models").respond(200, json=MODELS)
        sam = router.post("/responses").mock(
            side_effect=[httpx.Response(504, text="Gateway Timeout"), httpx.ReadTimeout("slow"),
                         httpx.Response(500, json={"error": {"code": "server_error"}}), sam_ok(), sam_ok()]
        )
        spark = router.post("/chat/completions").mock(
            side_effect=[httpx.ReadTimeout("slow"), spark_reply('{"objects": []}')]
        )
        code = run(["--images", str(tmp_path), "--synthetic", "--n", "2", "--sizes", "64", "--spark-n", "2"],
                   model_api_key=TEST_KEY)
    out = capsys.readouterr().out
    assert code == bench.EXIT_GATE_FAILED, out  # inconclusive is not a pass
    assert sam.call_count == 5 and spark.call_count == 2
    _, results = saved_results(results_dir)
    gates = results["gates"]
    assert (gates["G3"]["verdict"], gates["G3"]["calls"], gates["G3"]["accepted"]) == ("inconclusive", 3, False)
    assert gates["G2"]["64"]["pass"] is True
    assert "INCONCLUSIVE" in out and "PNG" not in out
    # The 504, the timeout and the 500 may still be billed: counted in the upper bound.
    assert results["estimated_cost"] == {"upper_bound": True, "sam_images": 5, "sam_uncertain": 3, "spark_timeouts": 1}
    assert "Spark calls timed out: 1" in out


def test_g3_transient_failure_then_success_is_accepted(
    tmp_path: Path, results_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with respx.mock(base_url=BASE_URL) as router:
        router.get("/models").respond(200, json=MODELS)
        router.post("/responses").mock(side_effect=[httpx.ConnectError("blip"), sam_ok(), sam_ok()])
        code = run(["--images", str(tmp_path), "--synthetic", "--n", "1", "--sizes", "64", "--skip-spark"],
                   model_api_key=TEST_KEY)
    out = capsys.readouterr().out
    assert code == bench.EXIT_OK, out
    assert "accepted on attempt 2 of 3" in out


def test_g4_times_only_valid_answers_and_reports_truncation(
    tmp_path: Path, results_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with respx.mock(base_url=BASE_URL) as router:
        router.get("/models").respond(200, json=MODELS)
        router.post("/responses").mock(side_effect=[sam_ok(), sam_ok()])
        spark = router.post("/chat/completions").mock(
            side_effect=[
                spark_reply('{"objects": [{"label": "zebra-lamp", "position": "left"}]}'),
                spark_reply('{"objects": [{"label": "zeb', "length"),
                spark_reply("not json"),
            ]
        )
        code = run(["--images", str(tmp_path), "--synthetic", "--n", "1", "--sizes", "64", "--spark-n", "3",
                    "--max-completion-tokens", "300"], model_api_key=TEST_KEY)
    out = capsys.readouterr().out
    assert code == bench.EXIT_OK, out  # G4 is measured only
    assert all(json.loads(c.request.content)["max_completion_tokens"] == 300 for c in spark.calls)
    text, results = saved_results(results_dir)
    g4 = results["gates"]["G4"]
    assert (g4["n"], g4["calls"], g4["truncated"], g4["invalid"], g4["errors"]) == (1, 3, 1, 1, 0)
    assert g4["tokens"]["input_tokens"] == 3 * 800  # every answer is billed
    assert "truncated=1, invalid=1" in out
    assert "--max-completion-tokens (this run: 300)" in out
    assert "zebra-lamp" not in text and "zeb" not in text


def test_g1_unparseable_model_list_saves_raw_body(
    tmp_path: Path, results_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    body = {"object": "list", "items": [{"name": "sam-3.1"}, {"name": "muse-spark-1.3"}]}
    with respx.mock(base_url=BASE_URL) as router:
        router.get("/models").respond(200, json=body)
        router.post("/responses").mock(side_effect=[sam_ok(), sam_ok()])
        code = run(["--images", str(tmp_path), "--synthetic", "--n", "1", "--sizes", "64", "--skip-spark"],
                   model_api_key=TEST_KEY)
    out = capsys.readouterr().out
    assert code == bench.EXIT_GATE_FAILED
    text, results = saved_results(results_dir)
    g1 = results["gates"]["G1"]
    assert json.loads(g1["raw_models_response"]) == body and g1["raw_models_response_truncated"] is False
    assert "no model IDs could be parsed" in out and "raw_models_response" in out
    assert TEST_KEY not in text

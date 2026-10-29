"""Day-0 gates G1-G4 against the real Meta Model API (see docs/FEASIBILITY.md section 7).

Run from backend/:

    .venv/bin/python -m scripts.bench                 # photos from bench/frames/
    .venv/bin/python -m scripts.bench --synthetic     # latency only, generated images

Calls are made one at a time (one request in flight, like the app). Frames are sent
with store:false and never written anywhere. The results JSON holds timings, counts,
token usage, error codes and photo file names: never image data, Muse Spark's object
labels or the key.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import platform
import sys
import time
from collections.abc import Sequence
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app import __version__
from app.images import EncodedImage, load_jpeg_data_url, make_synthetic_jpeg
from app.meta.client import MetaAPIError, MetaClient, parse_model_ids
from app.meta.sam import build_sam_request, extract_output_text, parse_sam_output
from app.meta.spark import (
    build_spark_probe_request,
    extract_chat_content,
    extract_finish_reason,
    extract_usage,
)
from app.settings import BACKEND_DIR, ENV_FILE, Settings, get_settings, invalid_settings_message

SAM_USD_PER_IMAGE = 2.50 / 1000
SPARK_USD_PER_INPUT_TOKEN = 1.25 / 1_000_000
SPARK_USD_PER_OUTPUT_TOKEN = 4.25 / 1_000_000  # reasoning tokens are billed as output
G2_P50_LIMIT_MS = 1500.0
G2_MAX_ERROR_RATE = 0.10
G3_ATTEMPTS = 3  # the first call, plus up to 2 more when the failure looks transient
G3_RETRY_DELAY_SECONDS = 2.0
RAW_MODELS_MAX_CHARS = 10 * 1024
MAX_CONSECUTIVE_ERRORS = 3
SYNTHETIC_VARIANTS = 3
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"}
DEFAULT_FRAMES_DIR = BACKEND_DIR / "bench" / "frames"
RESULTS_DIR = BACKEND_DIR / "bench" / "results"

EXIT_OK = 0
EXIT_GATE_FAILED = 1
EXIT_PRECONDITION = 2


# ---------- arguments and preconditions ----------


def _sizes(value: str) -> list[int]:
    try:
        sizes = [int(part) for part in value.split(",") if part.strip()]
    except ValueError:
        raise argparse.ArgumentTypeError("sizes must be comma-separated integers") from None
    if not sizes or any(size <= 0 for size in sizes):
        raise argparse.ArgumentTypeError("sizes must be positive integers")
    return sizes


def _positive_int(value: str) -> int:
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return number


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="python -m scripts.bench", description=__doc__.split("\n")[0])
    parser.add_argument("--images", type=Path, default=DEFAULT_FRAMES_DIR,
                        help="folder of JPEG/HEIC/PNG room photos (default: backend/bench/frames)")
    parser.add_argument("--n", type=_positive_int, default=20, help="SAM calls per size (default 20)")
    parser.add_argument("--sizes", type=_sizes, default=[768, 1008],
                        help="longest-side sizes in px, comma-separated (default 768,1008)")
    parser.add_argument("--concept", default="chair", help="SAM text prompt (default: chair)")
    parser.add_argument("--spark-n", type=_positive_int, default=5, help="Muse Spark probe calls (default 5)")
    parser.add_argument("--spark-timeout", type=float, default=60.0,
                        help="per-call timeout for Spark probes in seconds (default 60)")
    parser.add_argument("--max-completion-tokens", type=_positive_int, default=512,
                        help="Spark probe token cap, reasoning tokens included (default 512)")
    parser.add_argument("--skip-spark", action="store_true", help="skip gate G4")
    parser.add_argument("--synthetic", action="store_true",
                        help="use generated images when there are no photos (latency only)")
    return parser.parse_args(argv)


def find_images(folder: Path) -> list[Path]:
    if not folder.is_dir():
        return []
    return sorted(p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_SUFFIXES)


def precondition_problems(settings: Settings, photos: list[Path], args: argparse.Namespace) -> list[str]:
    problems: list[str] = []
    if not settings.key_configured:
        problems.append(
            "MODEL_API_KEY is not set.\n"
            f"  Put your key in this file: {ENV_FILE}\n"
            "  as the line:  MODEL_API_KEY=<your key from dev.meta.ai>\n"
            "  (cp .env.example .env && chmod 600 .env, then edit .env). Never paste the key into chat."
        )
    if not photos and not args.synthetic:
        problems.append(
            f"No photos found in {args.images}.\n"
            f"  Drop 3-10 JPEG/HEIC/PNG photos of real rooms (ideally with a {args.concept} in some)\n"
            f"  into {DEFAULT_FRAMES_DIR}/, or rerun with --synthetic for a latency-only run."
        )
    return problems


def encode_images(photos: list[Path], sizes: list[int]) -> tuple[dict[int, list[EncodedImage]], list[str], str]:
    """Pre-encode every photo at every size, so encoding time is not counted as latency."""
    encoded: dict[int, list[EncodedImage]] = {size: [] for size in sizes}
    names: list[str] = []
    if photos:
        for path in photos:
            try:
                per_size = {size: load_jpeg_data_url(path, size) for size in sizes}
            except Exception as exc:  # unreadable photo: skip it, keep the run going
                print(f"  skipping {path.name}: {type(exc).__name__}: {exc}")
                continue
            names.append(path.name)
            for size, image in per_size.items():
                encoded[size].append(image)
    if names:
        return encoded, names, "photos"
    for size in sizes:
        encoded[size] = [make_synthetic_jpeg(size, seed=seed) for seed in range(SYNTHETIC_VARIANTS)]
    return encoded, [f"synthetic-{seed}" for seed in range(SYNTHETIC_VARIANTS)], "synthetic"


# ---------- statistics and cost ----------


def percentile(values: Sequence[float], pct: float) -> float:
    """Linear-interpolated percentile (same as numpy's default)."""
    if not values:
        raise ValueError("no values")
    ordered = sorted(values)
    rank = (len(ordered) - 1) * pct / 100
    low, high = math.floor(rank), math.ceil(rank)
    return ordered[low] + (ordered[high] - ordered[low]) * (rank - low)


def summarize_ms(values: Sequence[float]) -> dict[str, float | int]:
    if not values:
        return {"n": 0}
    return {
        "n": len(values),
        "p50": round(percentile(values, 50), 1),
        "p95": round(percentile(values, 95), 1),
        "min": round(min(values), 1),
        "max": round(max(values), 1),
    }


def is_rejection(record: dict[str, Any]) -> bool:
    """A real 4xx answer about the request itself (400, 413, 415, 422...). 429 is a rate
    limit, and timeouts, network errors and 5xx are transient, so none of those count."""
    status = record.get("status")
    return "error" in record and isinstance(status, int) and 400 <= status < 500 and status != 429


def g2_stats(records: Sequence[dict[str, Any]], timeout_ms: float) -> dict[str, Any]:
    """Gate G2 for one size. Timeouts are latency samples at the timeout value. Calls the
    client retried after a back-off are left out of p50/p95 (their time includes the wait)
    and counted as "retried". Pass needs p50 <= limit, error rate <= 10% and no timeouts."""
    attempted = len(records)
    errors = sum(1 for r in records if not r["ok"])
    timeouts = sum(1 for r in records if r.get("error") == "timeout")
    samples = [
        timeout_ms if r.get("error") == "timeout" else r["ms"]
        for r in records
        if not r.get("retried") and (r["ok"] or r.get("error") == "timeout")
    ]
    error_rate = errors / attempted if attempted else 1.0
    stats: dict[str, Any] = {
        **summarize_ms(samples),
        "attempted": attempted,
        "errors": errors,
        "error_rate": round(error_rate, 3),
        "timeouts": timeouts,
        "retried": sum(1 for r in records if r.get("retried")),
    }
    stats["pass"] = (
        bool(samples)
        and float(stats["p50"]) <= G2_P50_LIMIT_MS
        and error_rate <= G2_MAX_ERROR_RATE
        and timeouts == 0
    )
    return stats


def g4_stats(spark_calls: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """Gate G4: p50/p95 only over usable answers (valid JSON, finish_reason "stop").
    Truncated answers (finish_reason "length") and other invalid ones are counted apart."""
    ok = [c for c in spark_calls if c["ok"]]
    valid = [c for c in ok if c["valid_json"] and c["finish_reason"] == "stop"]
    truncated = sum(1 for c in ok if c["finish_reason"] == "length")
    return {
        **summarize_ms([c["ms"] for c in valid]),
        "calls": len(spark_calls),
        "responses": len(ok),
        "errors": len(spark_calls) - len(ok),
        "timeouts": sum(1 for c in spark_calls if c.get("error") == "timeout"),
        "truncated": truncated,
        "invalid": len(ok) - len(valid) - truncated,
        "tokens": _token_totals(ok),
    }


def sam_images_upper_bound(sam_calls: Sequence[dict[str, Any]]) -> tuple[int, int]:
    """(images that may be billed, how many of those are uncertain). Besides 2xx answers,
    a timeout or 5xx may still have been processed and billed, and so may the first
    attempt of a call the client retried (429/503)."""
    answered = uncertain = 0
    for call in sam_calls:
        uncertain += max(0, call.get("attempts", 1) - 1)
        if "error" not in call:
            answered += 1
        elif call["error"] == "timeout" or (call.get("status") or 0) >= 500:
            uncertain += 1
    return answered + uncertain, uncertain


def raw_models_text(body: Any, secret: str | None) -> tuple[str, bool]:
    """The /models body as JSON text, key scrubbed just in case, cut to 10 KB."""
    text = json.dumps(body, ensure_ascii=True)
    if secret:
        text = text.replace(json.dumps(secret)[1:-1], "[redacted]")
    return text[:RAW_MODELS_MAX_CHARS], len(text) > RAW_MODELS_MAX_CHARS


def estimate_cost(sam_images: int, spark_input_tokens: int, spark_output_tokens: int) -> float:
    return (
        sam_images * SAM_USD_PER_IMAGE
        + spark_input_tokens * SPARK_USD_PER_INPUT_TOKEN
        + spark_output_tokens * SPARK_USD_PER_OUTPUT_TOKEN
    )


# ---------- single calls ----------


def _elapsed_ms(started: float) -> float:
    return round((time.perf_counter() - started) * 1000, 1)


def _error_record(exc: MetaAPIError, ms: float) -> dict[str, Any]:
    return {"ok": False, "ms": ms, "status": exc.status, "error": exc.code, "message": exc.message}


async def sam_call(client: MetaClient, settings: Settings, concept: str, image: EncodedImage) -> dict[str, Any]:
    payload = build_sam_request(concept, image.data_url, model=settings.sam_model)
    started = time.perf_counter()
    try:
        response = await client.create_response(payload)
    except MetaAPIError as exc:
        record = _error_record(exc, _elapsed_ms(started))
    else:
        ms = _elapsed_ms(started)
        detections = parse_sam_output(extract_output_text(response))
        confidences = [d.confidence for d in detections if d.confidence is not None]
        response_status = response.get("status")
        record = {
            "ok": response_status in (None, "completed"),
            "ms": ms,
            "response_status": response_status,
            "detections": len(detections),
            "max_confidence": max(confidences, default=None),
            "positions": [d.horizontal_third for d in detections],
        }
    # attempts > 1: the client waited and retried after a 429/503, so ms includes the wait.
    record.update(attempts=client.last_attempts, retried=client.last_attempts > 1)
    return record


async def spark_call(
    client: MetaClient,
    settings: Settings,
    image: EncodedImage,
    timeout: float,
    max_completion_tokens: int = 512,
) -> dict[str, Any]:
    payload = build_spark_probe_request(
        image.data_url,
        model=settings.spark_model,
        reasoning_effort=settings.spark_reasoning_effort,
        max_completion_tokens=max_completion_tokens,
    )
    started = time.perf_counter()
    try:
        response = await client.chat_completion(payload, timeout=timeout)
    except MetaAPIError as exc:
        return _error_record(exc, _elapsed_ms(started))
    ms = _elapsed_ms(started)
    content = extract_chat_content(response)
    try:
        parsed = json.loads(content)
        objects = parsed.get("objects") if isinstance(parsed, dict) else None
    except ValueError:
        objects = None
    return {
        "ok": True,
        "ms": ms,
        "finish_reason": extract_finish_reason(response),
        "usage": dict(extract_usage(response)),
        "valid_json": isinstance(objects, list),
        # A count only: the labels describe the user's own photos and are not saved.
        "object_count": len(objects) if isinstance(objects, list) else None,
    }


def _fmt_sam(record: dict[str, Any]) -> str:
    if "error" in record:
        return f"{record['ms']:.0f} ms  ERROR {record['status']} {record['error']}: {record['message']}"
    c = record["max_confidence"]
    c_text = f"{c:.2f}" if c is not None else "-"
    flag = "" if record["ok"] else f"  (response status {record['response_status']})"
    if record.get("retried"):
        flag += "  (retried after a back-off)"
    return f"{record['ms']:.0f} ms  {record['detections']} detections  max c={c_text}{flag}"


def _failure_text(record: dict[str, Any]) -> str:
    if "error" in record:
        return f"{record['status']} {record['error']}"
    return f"response status {record.get('response_status')}"


# ---------- gates ----------


async def run_gates(
    client: MetaClient,
    settings: Settings,
    args: argparse.Namespace,
    images: dict[int, list[EncodedImage]],
) -> dict[str, Any]:
    gates: dict[str, Any] = {}
    calls: dict[str, list[dict[str, Any]]] = {"sam": [], "spark": []}

    print("\nG1  GET /models")
    try:
        body = await client.models_response()
    except MetaAPIError as exc:
        gates["G1"] = _error_record(exc, 0.0)
        print(f"    ERROR {exc.status} {exc.code}: {exc.message}")
        if exc.status in (401, 403):
            print(f"    The key was rejected. Check MODEL_API_KEY in {ENV_FILE}. Stopping.")
            return {"gates": gates, "calls": calls}
    else:
        models = parse_model_ids(body)
        gates["G1"] = {
            "ok": True,
            "model_count": len(models),
            "models": models,
            "sam_listed": settings.sam_model in models,
            "spark_listed": settings.spark_model in models,
        }
        for model in (settings.sam_model, settings.spark_model):
            print(f"    {model}: {'listed' if model in models else 'NOT listed'}")
        print(f"    ({len(models)} models visible to this key)")
        if not models:
            key = settings.model_api_key.get_secret_value() if settings.model_api_key else None
            raw, truncated = raw_models_text(body, key)
            gates["G1"]["raw_models_response"] = raw
            gates["G1"]["raw_models_response_truncated"] = truncated
            print(
                "    HTTP 200 but no model IDs could be parsed, so the list may be in an unexpected shape.\n"
                "    The raw body (a model list, no secrets) is saved as gates.G1.raw_models_response in the\n"
                "    results file" + (" (cut to 10 KB)" if truncated else "")
                + ". Compare it with parse_model_ids() in app/meta/client.py."
            )

    first_size = args.sizes[0]
    print(f"\nG3  First SAM call with a JPEG data URL ({first_size}px, cold connection)")
    attempts: list[dict[str, Any]] = []
    for attempt in range(1, G3_ATTEMPTS + 1):
        if attempt > 1:
            await asyncio.sleep(G3_RETRY_DELAY_SECONDS)
        record = await sam_call(client, settings, args.concept, images[first_size][0])
        record.update(size=first_size, image=0, phase="G3")
        calls["sam"].append(record)
        attempts.append(record)
        print(f"    [{attempt}/{G3_ATTEMPTS}] {_fmt_sam(record)}")
        # Only a success or a real 4xx rejection is conclusive; anything else may be transient.
        if record["ok"] or is_rejection(record):
            break
    last = attempts[-1]
    verdict = "accepted" if last["ok"] else "rejected" if is_rejection(last) else "inconclusive"
    gates["G3"] = {
        **{k: v for k, v in last.items() if k != "phase"},  # the deciding call
        "verdict": verdict,
        "accepted": verdict == "accepted",
        "calls": len(attempts),
        "first_ms": attempts[0]["ms"],
    }
    if verdict == "accepted":
        print("    accepted (HTTP 2xx)")
    elif verdict == "rejected":
        print(f"    REJECTED with HTTP {last['status']}: SAM refused the JPEG data URL.")
    else:
        print(
            f"    INCONCLUSIVE: {len(attempts)} attempts failed with transient errors (timeout, network, "
            "429 or 5xx),\n    which says nothing about the image format. Running G2 anyway."
        )

    if verdict != "rejected":
        gates["G2"] = {}
        for size in args.sizes:
            print(f"\nG2  SAM latency at {size}px: {args.n} sequential calls, concept '{args.concept}'")
            pool = images[size]
            records: list[dict[str, Any]] = []
            consecutive_errors = 0
            for i in range(args.n):
                record = await sam_call(client, settings, args.concept, pool[i % len(pool)])
                record.update(size=size, image=i % len(pool), phase="G2")
                calls["sam"].append(record)
                records.append(record)
                print(f"    [{i + 1:>2}/{args.n}] {_fmt_sam(record)}")
                if record["ok"]:
                    consecutive_errors = 0
                else:
                    consecutive_errors += 1
                    if consecutive_errors >= MAX_CONSECUTIVE_ERRORS:
                        print(f"    {MAX_CONSECUTIVE_ERRORS} errors in a row, stopping this size.")
                        break
            gates["G2"][str(size)] = g2_stats(records, settings.meta_timeout_seconds * 1000)
    else:
        print("    Skipping G2. FEASIBILITY fallback: rerun with PNG frames instead of JPEG.")

    if args.skip_spark:
        print("\nG4  skipped (--skip-spark)")
    else:
        print(
            f"\nG4  Muse Spark probe: {args.spark_n} sequential calls, "
            f"reasoning_effort={settings.spark_reasoning_effort}, {first_size}px"
        )
        pool = images[first_size]
        for i in range(args.spark_n):
            record = await spark_call(
                client, settings, pool[i % len(pool)], args.spark_timeout, args.max_completion_tokens
            )
            record.update(size=first_size, image=i % len(pool))
            calls["spark"].append(record)
            if record["ok"]:
                u = record["usage"]
                print(
                    f"    [{i + 1}/{args.spark_n}] {record['ms']:.0f} ms  tokens in={u['input_tokens']} "
                    f"out={u['output_tokens']} reasoning={u['reasoning_tokens']}  "
                    f"finish={record['finish_reason']}  valid_json={record['valid_json']}"
                )
            else:
                print(f"    [{i + 1}/{args.spark_n}] {record['ms']:.0f} ms  ERROR {record['status']} {record['error']}: {record['message']}")
        gates["G4"] = {**g4_stats(calls["spark"]), "max_completion_tokens": args.max_completion_tokens}
    return {"gates": gates, "calls": calls}


def _token_totals(spark_calls: list[dict[str, Any]]) -> dict[str, int]:
    totals = {"input_tokens": 0, "output_tokens": 0, "reasoning_tokens": 0}
    for call in spark_calls:
        for key in totals:
            totals[key] += call["usage"].get(key) or 0
    return totals


def print_summary(settings: Settings, gates: dict[str, Any]) -> bool:
    """Print the gate table; returns True when every gate that ran passed."""
    all_passed = True
    print("\n=== Day-0 gate summary ===")
    g1 = gates.get("G1")
    if g1 is not None:
        passed = bool(g1.get("sam_listed") and g1.get("spark_listed"))
        all_passed &= passed
        detail = (
            f"{settings.sam_model} {'yes' if g1.get('sam_listed') else 'no'}, "
            f"{settings.spark_model} {'yes' if g1.get('spark_listed') else 'no'}"
            if g1.get("ok") else f"error {g1.get('status')} {g1.get('error')}"
        )
        if "raw_models_response" in g1:
            detail += "; no model IDs parsed, raw body saved in the results file"
        print(f"G1 models listed       {'PASS' if passed else 'FAIL'}  ({detail})")
    g3 = gates.get("G3")
    if g3 is not None:
        verdict = g3["verdict"]
        all_passed &= verdict == "accepted"
        if verdict == "accepted":
            when = f"first call {g3['first_ms']:.0f} ms" if g3["calls"] == 1 else (
                f"accepted on attempt {g3['calls']} of {G3_ATTEMPTS}, {g3['ms']:.0f} ms")
            print(f"G3 JPEG data URL       PASS  ({when})")
        elif verdict == "rejected":
            print(f"G3 JPEG data URL       FAIL  (rejected: {_failure_text(g3)}; try PNG frames)")
        else:
            print(
                f"G3 JPEG data URL       INCONCLUSIVE  ({g3['calls']} attempts, last {_failure_text(g3)}; "
                "transient, not a format rejection)"
            )
    g2 = gates.get("G2")
    if g2:
        all_passed &= any(stats["pass"] for stats in g2.values())
        for size, stats in g2.items():
            verdict = "PASS" if stats["pass"] else "FAIL"
            quality = (
                f"errors={stats['errors']}/{stats['attempted']} ({stats['error_rate']:.0%}), "
                f"timeouts={stats['timeouts']}, retried={stats['retried']} (excluded)"
            )
            if stats["n"]:
                print(
                    f"G2 SAM {size:>4}px         {verdict}  p50 {stats['p50']:.0f} ms, p95 {stats['p95']:.0f} ms "
                    f"(min {stats['min']:.0f}, max {stats['max']:.0f}, n={stats['n']}; {quality}; "
                    f"pass: p50 <= {G2_P50_LIMIT_MS:.0f} ms, errors <= {G2_MAX_ERROR_RATE:.0%}, no timeouts)"
                )
            else:
                print(f"G2 SAM {size:>4}px         FAIL  no usable calls ({quality})")
    g4 = gates.get("G4")
    if g4 is not None:
        counts = (
            f"n={g4['n']} of {g4['calls']}, errors={g4['errors']}, "
            f"truncated={g4['truncated']}, invalid={g4['invalid']}"
        )
        if g4["n"]:
            responses, tokens = g4["responses"], g4["tokens"]
            print(
                f"G4 Spark {settings.spark_reasoning_effort:<8}      MEASURED  p50 {g4['p50']:.0f} ms, p95 {g4['p95']:.0f} ms "
                f"({counts}); avg tokens in={tokens['input_tokens'] / responses:.0f} "
                f"out={tokens['output_tokens'] / responses:.0f} reasoning={tokens['reasoning_tokens'] / responses:.0f}"
            )
        else:
            all_passed = False
            print(f"G4 Spark               FAIL  no valid answers ({counts})")
        if g4["truncated"]:
            print(
                f"   {g4['truncated']} Spark answer(s) hit the token cap (finish_reason=length). Rerun with a higher "
                f"--max-completion-tokens (this run: {g4['max_completion_tokens']})."
            )
    return all_passed


def save_results(results: dict[str, Any], started_at: datetime) -> Path:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    path = RESULTS_DIR / f"bench-{started_at.strftime('%Y%m%dT%H%M%SZ')}.json"
    path.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    return path


# ---------- entry point ----------


async def _run(args: argparse.Namespace, settings: Settings) -> int:
    started_at = datetime.now(timezone.utc)
    photos = find_images(args.images)
    problems = precondition_problems(settings, photos, args)
    if problems:
        for problem in problems:
            print(f"error: {problem}\n", file=sys.stderr)
        return EXIT_PRECONDITION

    images, names, source = encode_images(photos, args.sizes)
    if source == "synthetic" and not args.synthetic:
        print(f"error: none of the files in {args.images} could be read. Add JPEG/PNG photos "
              "or rerun with --synthetic.", file=sys.stderr)
        return EXIT_PRECONDITION

    max_sam_calls = G3_ATTEMPTS + args.n * len(args.sizes)
    print(f"HeyNavi Day-0 bench  (backend {__version__}, {settings.meta_api_base_url})")
    print(f"  images: {len(names)} {source}" + ("  (latency only: expect 0 detections)" if source == "synthetic" else ""))
    for size in args.sizes:
        kb = [round(img.byte_size / 1024) for img in images[size]]
        dims = {f"{img.width}x{img.height}" for img in images[size]}
        print(f"  {size}px: {', '.join(sorted(dims))}, JPEG {min(kb)}-{max(kb)} KB")
    print(f"  up to {max_sam_calls} SAM calls (about ${max_sam_calls * SAM_USD_PER_IMAGE:.2f})"
          + ("" if args.skip_spark else f" + {args.spark_n} Spark calls (billed by tokens)"))
    print("  every SAM request is sent with store:false; frames are not saved")

    async with MetaClient.from_settings(settings) as client:
        outcome = await run_gates(client, settings, args, images)

    gates, calls = outcome["gates"], outcome["calls"]
    sam_images, sam_uncertain = sam_images_upper_bound(calls["sam"])
    tokens = _token_totals([c for c in calls["spark"] if c["ok"]])
    spark_timeouts = sum(1 for c in calls["spark"] if c.get("error") == "timeout")
    cost = estimate_cost(sam_images, tokens["input_tokens"], tokens["output_tokens"])
    all_passed = print_summary(settings, gates)
    print(f"Estimated cost of this run: at most ${cost:.4f} (upper bound: {sam_images} SAM images, "
          f"{sam_uncertain} of them timed out, 5xx or retried and maybe not billed; "
          f"Spark {tokens['input_tokens']} in / {tokens['output_tokens']} out tokens)")
    print(f"  Spark calls timed out: {spark_timeouts}"
          + (" (their tokens are unknown and not included above)" if spark_timeouts else ""))

    results = {
        "started_at": started_at.isoformat(),
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "backend_version": __version__,
        "python": platform.python_version(),
        "config": {
            "base_url": settings.meta_api_base_url,
            "sam_model": settings.sam_model,
            "spark_model": settings.spark_model,
            "spark_reasoning_effort": settings.spark_reasoning_effort,
            "timeout_seconds": settings.meta_timeout_seconds,
            "spark_timeout_seconds": args.spark_timeout,
            "max_completion_tokens": args.max_completion_tokens,
            "n": args.n,
            "sizes": args.sizes,
            "concept": args.concept,
            "spark_n": 0 if args.skip_spark else args.spark_n,
        },
        "images": {
            "source": source,
            "names": names,
            "per_size": {
                str(size): [{"width": i.width, "height": i.height, "jpeg_bytes": i.byte_size} for i in imgs]
                for size, imgs in images.items()
            },
        },
        "gates": gates,
        "calls": calls,
        "estimated_cost_usd": round(cost, 4),
        "estimated_cost": {
            "upper_bound": True,
            "sam_images": sam_images,
            "sam_uncertain": sam_uncertain,
            "spark_timeouts": spark_timeouts,
        },
    }
    path = save_results(results, started_at)
    print(f"Results saved to {path}")
    return EXIT_OK if all_passed else EXIT_GATE_FAILED


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    args.images = args.images.expanduser().resolve()
    try:
        settings = get_settings()
    except ValueError as exc:  # pydantic's ValidationError is a ValueError
        print(f"error: {invalid_settings_message(exc)}", file=sys.stderr)
        return EXIT_PRECONDITION
    return asyncio.run(_run(args, settings))


if __name__ == "__main__":
    sys.exit(main())

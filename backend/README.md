# HeyNavi backend

FastAPI service between the HeyNavi app and the Meta Model API (`sam-3.1`, `muse-spark-1.3`). The Meta key lives only here, never in the app.

Status: **M0** (2026-10-29). There is a Meta client, a SAM 3.1 request builder and box parser, a Muse Spark probe, `GET /health`, and the Day-0 benchmark. The `/v1/*` routes arrive in M1.

All commands below run from this `backend/` folder. The project path contains spaces, so quote it:

```sh
cd "/Users/anjung/Library/Application Support/Claude/scratch-workspaces/53c75bd1-0e53-40bb-ba78-bedd5ff8d753/3f19a1b2-6c89-4037-b1e9-8b70b850118a/scratch-2026-10-29-9d3e2e/backend"
```

## 1. Setup

Requires Python 3.12 or newer (developed on 3.14.7).

```sh
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
```

## 2. Put your Meta API key in `backend/.env`

1. Create a key at **dev.meta.ai › API keys**. Keys start with `LLM_`.
2. Copy the template and lock down its permissions:

   ```sh
   cp .env.example .env
   chmod 600 .env
   ```

3. Open `backend/.env` in a text editor (for example `open -e .env`) and paste the key after `MODEL_API_KEY=`, with no quotes or spaces:

   ```
   MODEL_API_KEY=LLM_your_key_here
   ```

4. Set `HEYNAVI_APP_TOKEN` if you want `GET /health?deep=true` (section 3). The deep check and the future `/v1/*` routes require it in the `X-HeyNavi-Token` header. Generate one with:

   ```sh
   python3 -c "import secrets; print(secrets.token_urlsafe(24))"
   ```

Rules: `.env` is git-ignored. Never commit it, never paste the key into chat, and never put it in the mobile app. The server and the benchmark never print the key. It is kept out of `repr()`, logs, error messages, exception tracebacks and `/health` responses.

Spaces and line breaks around `MODEL_API_KEY` and `HEYNAVI_APP_TOKEN` are trimmed. Inside the value, only printable ASCII is allowed: an inner space, a line break or a non-ASCII character is rejected at startup. The benchmark then exits with code 2 and the server refuses to start. Both print the `backend/.env` path and the setting's name, never the value. The path is resolved from the code location, so the same `backend/.env` is used no matter which folder you run commands from. Every setting is listed with a one-line comment in [`.env.example`](.env.example).

## 3. Run the server

```sh
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
```

`--host 0.0.0.0` lets an iPhone on the same Wi-Fi reach the Mac at `http://<mac-lan-ip>:8000`. Check it with:

```sh
curl http://127.0.0.1:8000/health
curl -H "X-HeyNavi-Token: <your HEYNAVI_APP_TOKEN>" "http://127.0.0.1:8000/health?deep=true"
```

- `GET /health` is public and needs no token. It returns `{"ok": true, "service": "heynavi-backend", "version": "0.1.0", "key_configured": <bool>}`.
- `?deep=true` needs the app token in `X-HeyNavi-Token`. Without it, or when `HEYNAVI_APP_TOKEN` is not set on the server, it returns HTTP 401 and does not call Meta. With the token, it calls `GET /v1/models` and adds `models_reachable`, `sam_available` and `spark_available` (booleans only). When the check fails, it adds `error` with a short code: `key_not_configured`, `timeout`, `network_error`, or the error code Meta returned.

## 4. Run the tests

```sh
.venv/bin/pytest
```

The tests never call the real Meta API: HTTP is mocked with `respx`. They also ignore your shell variables and your real `backend/.env`.

## 5. Day-0 benchmark (gates G1–G4)

These gates come from `docs/FEASIBILITY.md` §7. Run them once your key is in `backend/.env`.

1. Put 3–10 photos of real rooms (JPEG, HEIC or PNG, ideally some with a chair) into `bench/frames/`. HEIC is converted in memory with the macOS `sips` tool. The photos stay local: the folder is git-ignored.
2. Run:

   ```sh
   .venv/bin/python -m scripts.bench                  # real photos
   .venv/bin/python -m scripts.bench --synthetic      # no photos yet: latency only
   .venv/bin/python -m scripts.bench --skip-spark     # SAM gates only
   ```

   Options: `--images DIR`, `--n 20` (SAM calls per size), `--sizes 768,1008`, `--concept chair`, `--spark-n 5`, `--spark-timeout 60`, `--max-completion-tokens 512` (Spark token cap, reasoning included), `--skip-spark`, `--synthetic`.

| Gate | What it measures | Pass |
|---|---|---|
| G1 | `GET /v1/models` with your key; are `sam-3.1` and `muse-spark-1.3` listed? | Both listed. If not, it's a region or billing issue: ask in Discord #questions. If the answer is HTTP 200 but no model IDs can be read from it, the raw body (first 10 KB, no secrets) is saved as `gates.G1.raw_models_response` |
| G3 | First SAM call with a JPEG data URL (cold connection). Timeouts, network errors, 429 and 5xx are retried up to 2 more times | HTTP 2xx. A real 4xx (400, 413, 415, 422...) is a rejection: try PNG. If every attempt fails transiently, G3 is **inconclusive** (not a pass) and G2 still runs |
| G2 | SAM latency at each size: `--n` calls made **one at a time**, as the app does, cycling through the photos. Reports p50/p95/min/max, error rate, timeouts, detection count and max confidence. A timeout counts as a sample at the timeout value. Calls the client retried after a 429/503 back-off are left out of p50/p95 and reported as `retried` | At one size or more: p50 ≤ 1500 ms, error rate ≤ 10% and no timeouts |
| G4 | Muse Spark at `SPARK_REASONING_EFFORT` (default `minimal`): short strict-JSON listing of visible objects. p50/p95 cover only valid JSON answers with `finish_reason` `stop`. Truncated answers (`length`) and other invalid ones are counted separately; truncation prints a hint to raise `--max-completion-tokens`. Also reports token usage, including reasoning tokens | Measured only, no threshold (fails only if no answer is valid) |

- **Output.** The script prints each call, a gate summary and an estimated cost. A default run makes at most 43 SAM calls (about $0.11) plus 5 Spark calls, which are billed by tokens. The cost is an upper bound: SAM calls that timed out, got a 5xx or were retried count as possibly billed. Spark calls that timed out are listed next to it, because their tokens are unknown. Full results go to `bench/results/bench-<UTC timestamp>.json`, which is git-ignored. That file holds timings, counts, token usage, Meta error codes and messages, and your photo file names. It never holds image data, Muse Spark's object labels or the key.
- **Exit codes.** `0` means every gate that ran passed. `1` means a gate failed or was inconclusive. `2` means something is missing or invalid: no key or an invalid value in `backend/.env` (both print the exact file path), or no photos and no `--synthetic`.

## Privacy

- Every SAM request sends `store: false`. The Responses API stores requests by default.
- Frames exist only in memory. The server never writes images to disk. The benchmark saves measurements, counts and photo file names, never image data or Muse Spark's object labels. One exception: the benchmark converts a HEIC photo through a temporary JPEG copy, which is deleted as soon as it has been read.
- Request bodies, which contain images, are never logged. Logs show method, path, status and latency only.

## Layout

```
app/
  settings.py      pydantic-settings; backend/.env resolved from this file
  deps.py          shared FastAPI dependencies: settings, Meta client, require_app_token
  main.py          create_app(), lifespan (one shared MetaClient), GET /health
  images.py        JPEG data-URL encoding (EXIF-aware resize) + synthetic frames
  meta/client.py   async httpx client: bearer auth, one retry on 429/503, error mapping
  meta/sam.py      SAM 3.1 request builder, output_text extraction, box-token parser
  meta/spark.py    Muse Spark probe request + strict schema, usage extraction
scripts/bench.py   Day-0 gates G1-G4
tests/             unit tests (Meta calls mocked)
```

Note: Starlette 1.x warns that its `TestClient` prefers the separate `httpx2` package. Plain `httpx` still works, so `pyproject.toml` filters that one warning.

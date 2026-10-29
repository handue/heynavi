# HeyNavi

**See more. Go further.** HeyNavi is a voice-first AI visual companion for blind and low-vision people. You tell it what you're looking for. It keeps that goal while it watches the camera, and it tells you when it finds the object.

Built for the Meta Global AI Developer Hackathon 2026 (Indie Developer Track, theme: *Build for Your World*).

> **Status (2026-10-29): M0 complete.** The scaffold, Meta API client, SAM parser, benchmark and on-device diagnostics are built and tested. The dev build runs on an iPhone 16e. See [docs/PLAN.md](docs/PLAN.md) for milestones and what is blocked.

## Run locally

All commands run from the repo root on a Mac.

1. **Backend** (put the Meta key in `backend/.env` first, using `backend/.env.example` as the template):
   `cd backend && .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000`
2. **Metro** (the JavaScript dev server for the app):
   `cd apps/mobile && npx expo start --dev-client`
3. **App on a cabled iPhone** (rebuild at least every 7 days with a free Apple ID):
   `cd apps/mobile && npm run ios:device`
4. **Tests:** `cd backend && .venv/bin/python -m pytest -q`, and `cd apps/mobile && npm test && npm run typecheck`
5. **Day-0 benchmark:** `cd backend && .venv/bin/python -m scripts.bench`

`apps/mobile/.env` must set `EXPO_PUBLIC_API_URL` to the Mac's LAN IP (`ipconfig getifaddr en0`) and `EXPO_PUBLIC_HEYNAVI_TOKEN` to the same value as `HEYNAVI_APP_TOKEN` in `backend/.env`. Templates are in the `.env.example` files.

## What makes it different

Most image-description apps answer one photo at a time. HeyNavi keeps a goal running instead:

> "Hey Navi, find my chair." → *"Looking for a chair. Move your phone slowly."* → *"I found a chair, on the left of the camera view."*

- **SAM 3.1** (Meta) checks every sampled frame for the target object.
- **Muse Spark** (Meta) interprets requests, double-checks findings, describes scenes and reads text.
- **The app** confirms an object across several frames, decides what is worth saying, and lets you interrupt at any time by voice or touch.

## Docs

- [docs/FEASIBILITY.md](docs/FEASIBILITY.md): what we verified about the Meta models, Expo and iOS, with sources
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): system design, the search agent, the announcement engine and the API contract
- [docs/PLAN.md](docs/PLAN.md): milestones, the first testable slice, demo plan and risks
- [docs/BUILD_LOG.md](docs/BUILD_LOG.md): what was built when, for the hackathon's new-work rule

## Stack

React Native + Expo SDK 58 + TypeScript + Expo Router (iPhone first), and Python + FastAPI + Pydantic on the backend. Meta Model API models: `sam-3.1`, `muse-spark-1.3`, and optionally `muse-voice-transcribe-1.0`.

## Safety

HeyNavi is an assistive tool for understanding your surroundings. It is **not** a navigation or collision-avoidance system. It does not replace a cane, a guide dog or orientation-and-mobility training. Positions are given relative to the camera view, and HeyNavi never claims a path is safe.

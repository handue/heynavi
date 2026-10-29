# HeyNavi

**See more. Go further.** HeyNavi is a voice-first AI visual companion for blind and low-vision people. You tell it what you're looking for. It keeps that goal while it watches the camera, and it tells you when it finds the object.

Built for the Meta Global AI Developer Hackathon 2026 (Indie Developer Track, theme: *Build for Your World*).

> **Status (2026-10-29): planning complete, implementation not started.** See [docs/PLAN.md](docs/PLAN.md) for milestones and what is blocked.

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

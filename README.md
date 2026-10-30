# HeyNavi

**See more. Go further.** HeyNavi is a voice-first AI environmental-awareness and navigation companion for blind and low-vision people. You start it and point the camera ahead. HeyNavi interprets the scene on its own, decides what is worth mentioning, and tells you. You can interrupt it, ask questions in plain English, or ask it to find a specific object.

Built for the Meta Global AI Developer Hackathon 2026 (Indie Developer Track, theme: *Build for Your World*).

> **Status (2026-10-29): M2 complete; roadmap revised.** Working today on an iPhone 16e: say "Hey Navi, find a chair" and HeyNavi searches the camera view with SAM 3.1 and says where the chair is. Stop, cancel, pause, resume and repeat work by voice, by button and by VoiceOver Magic Tap, with on-device English speech recognition. **Planned next:** continuous scene understanding with Muse Spark (M3), grounded checks with SAM 3.1 and questions (M4), and a destination-routing prototype (M5, stretch). See [docs/PLAN.md](docs/PLAN.md).

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

Most image-description apps answer one photo when asked. HeyNavi keeps watching, remembers what it has seen in the last half minute, and speaks up only when something matters (planned in M3–M4):

> *"A hallway, with a door on the right of the camera view."* … *"Possible obstacle: a chair in the lower center of the view."* … "Hey Navi, where can I sit?" → *"I found a chair, on the left of the camera view."*

- **Muse Spark** (Meta) interprets sampled camera frames together with short-term scene memory, and proposes what deserves attention. It also answers questions.
- **SAM 3.1** (Meta) locates and checks the objects Spark picked, which can be anything Spark names, not a fixed list. A "possible obstacle" is mentioned only after SAM confirms it. SAM also runs the goal-directed search ("find my cup"), which already works.
- **The app** decides what is said and when. It prioritizes, skips repeats, keeps updates sparse, and lets you cut it off at any time by voice or touch.
- **Destination routing** (stretch goal): a real walking route from Apple MapKit with GPS, spoken as "Route: …" instructions, kept separate from what the camera sees.

## Docs

- [docs/FEASIBILITY.md](docs/FEASIBILITY.md): what we verified about the Meta models, Expo and iOS, with sources
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): system design: scene understanding, grounding, voice guidance, questions, navigation, API contract
- [docs/PLAN.md](docs/PLAN.md): scope for Nov 4, milestones, gates, demo plan and risks
- [docs/research/routing.md](docs/research/routing.md): walking-route providers checked for the navigation milestone
- [docs/BUILD_LOG.md](docs/BUILD_LOG.md): what was built when, for the hackathon's new-work rule

## Stack

React Native + Expo SDK 58 + TypeScript + Expo Router (iPhone first), and Python + FastAPI + Pydantic on the backend. Meta Model API models: `sam-3.1` and `muse-spark-1.3`. Navigation (planned): Apple MapKit and Core Location on the phone.

## Scope

The hackathon MVP is **English-only**: speech recognition, voice commands, spoken announcements and the interface. Multilingual support is planned as a future enhancement (see [docs/ARCHITECTURE.md §15](docs/ARCHITECTURE.md)).

## Safety

HeyNavi is an assistive tool for understanding your surroundings. It is **not** a collision-avoidance system, and it does not replace a cane, a guide dog or orientation-and-mobility training.

- **Camera observations are descriptions**, given relative to the camera view, never as distances. HeyNavi never claims a path is safe, and it does not detect every obstacle.
- **Route instructions** (planned) come from map data and GPS, which can be off by tens of meters. They are spoken separately from camera observations.

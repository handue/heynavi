# Build Log

This log supports the hackathon's new-work requirement. It records what existed before the event and what was built during it, with dates, so judges can see where the line falls.

Building period: 2026-10-27 → 2026-11-04 21:00 ET.

## Materials created before the event

| Item | Notes |
|---|---|
| Product concept and name ("HeyNavi", "See more. Go further.") | Idea discussion only |
| Nine-screen wireframe / UI concept board | Visual direction only, no code. Image file kept outside the repo |

No HeyNavi code existed before the event.

## During the event

| Date (ET) | Work | Evidence |
|---|---|---|
| 2026-10-29 | Feasibility research (Meta Model API, SAM 3.1, Expo camera, iOS voice, rules) with source-checked findings. Architecture, plan and demo outline | `docs/FEASIBILITY.md`, `docs/ARCHITECTURE.md`, `docs/PLAN.md` |
| 2026-10-29 | **M0.** Expo SDK 58 app scaffold (`apps/mobile`): camera, speech recognition, TTS, haptics, dev client. FastAPI backend (`backend/`): Meta Model API client, SAM 3.1 request builder and output parser, Muse Spark probe, `/health`, app-token auth, Day-0 benchmark script, test suite. On-device diagnostics screen for gates G5/G6. Dev build compiled with Xcode 27.1 and installed on an iPhone 16e (gate G7 passed). | `backend/`, `apps/mobile/`, `apps/mobile/scripts/build-ios-device.sh` |

## AI assistance disclosure

Development uses Claude Code (Anthropic) as an AI coding assistant for research, planning and implementation. The team reviews, tests and owns all submitted work. Every external library is listed with its license in the README's attribution section, which will be added when code lands.

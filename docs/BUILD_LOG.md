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
| 2026-10-29 | Day-0 gates against the real Meta API: G1, G2, G3 pass; G4 measured (Muse Spark `minimal` median 2.8 s); run cost at most $0.06. | `docs/FEASIBILITY.md` |
| 2026-10-29 | **M1 (VS-1).** Backend `POST /v1/detect`: SAM 3.1, strict validation, no retry on the main loop, body limit, token checked before the body is read. App: camera search session, 2-of-3 spatial confirmation state machine, priority/dedupe announcer, English and Korean phrases, haptics, metrics. First live search on the iPhone 16e found a real chair. G5 passed (no shutter sound). | `backend/app/routes/detect.py`, `apps/mobile/src/agent/`, `apps/mobile/src/session/`, `apps/mobile/src/app/session.tsx` |
| 2026-10-29 | **M2 (VS-2).** MVP made English-only (Korean phrases, language toggle and tests removed). Always-on on-device en-US voice commands: wake phrase, find/search, stop, cancel, quiet, pause, resume, repeat, help. Echo gate against HeyNavi's own speech, barge-in before or after its echo, listener restart and stall watchdog, mic status control, stop-latency metric. React Native 0.88 patch so VoiceOver Magic Tap reaches the app. Tested on the iPhone 16e: VS-1 acceptance checks pass, G6 passed in Airplane Mode. Device testing found and fixed a ~500 ms JS stall from re-applying the audio session category, "cancel" heard as "cancer", and a segment reset that turned a barge-in "stop" into ending the search. | `apps/mobile/src/voice/`, `apps/mobile/src/session/voice-actions.ts`, `apps/mobile/patches/`, `docs/FEASIBILITY.md` |
| 2026-10-29 | Product vision clarified: HeyNavi pairs Active Object Search (signature, goal-directed) with limited Ambient Scene and Obstacle Awareness (proactive). M3 refocused on search reliability; M4 becomes the Ambient Awareness MVP, planned in detail after M3. | `docs/ARCHITECTURE.md` §1, §4.4; `docs/PLAN.md` |
| 2026-10-29 | Product vision revised again (supersedes the row above): HeyNavi is an environmental-awareness and navigation companion. Continuous Scene Understanding with Muse Spark is primary; SAM 3.1 checks what Spark picks; Active Object Search becomes one optional capability; destination navigation is a stretch milestone. Architecture and roadmap rewritten with a Nov 4 scope and decision gates. Routing check from the Mac: Apple MapKit walking route and place search in Seoul (no key), OSRM foot route as fallback. No app behavior changed. | `docs/ARCHITECTURE.md`, `docs/PLAN.md`, `docs/research/routing.md` |
| 2026-10-30 | **M3.** Continuous scene understanding with Muse Spark (`POST /v1/scene`, strict schema, wording filter, daily spending guard, `POST /v1/metrics`); automatic SAM 3.1 checks of Spark's walking-relevant objects on the same frame; attention policy that announces potential walking obstacles first and hedges what SAM cannot localize; directions relative to the user only when the motion sensor shows the phone held forward; blue boxes for every confirmed object; camera-first screen with no object picker; "what's around me", "quieter", "more detail", "updates off/on"; commands said over HeyNavi's speech picked out of the echo. Five device rounds on the iPhone 16e (results in FEASIBILITY). | `backend/app/meta/scene.py`, `backend/app/routes/scene.py`, `apps/mobile/src/scene/`, `apps/mobile/src/perception/orientation.ts`, `apps/mobile/src/app/session.tsx` |

**Magic Tap (fixed in M2):** in React Native 0.88 the JavaScript side passed the Magic Tap prop under a different name than the native side reads, so the gesture never reached the app. `apps/mobile/patches/react-native+0.88.1.patch` (applied by `patch-package` on install) adds the missing name. Verified with VoiceOver on the iPhone 16e.

## AI assistance disclosure

Development uses Claude Code (Anthropic) as an AI coding assistant for research, planning and implementation. The team reviews, tests and owns all submitted work. Every external library is listed with its license in the README's attribution section, which will be added when code lands.

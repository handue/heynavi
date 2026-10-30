# HeyNavi — Execution Plan

As of **Thu 2026-10-29**, revised the same day after the product vision changed (see [ARCHITECTURE.md §1](ARCHITECTURE.md)). M0–M2 are done. This plan replaces the earlier search-first roadmap.

- Hard deadline: **Wed Nov 4, 9:00 PM ET** (Nov 5, 11:00 KST).
- Internal deadline: **Nov 4, 12:00 PM ET** (Nov 5, 02:00 KST), leaving 9 hours of buffer.
- Working days left: Oct 30, Oct 31, Nov 1, Nov 2, Nov 3, and the morning of Nov 4.

Every status here is one of: **Implemented & tested**, **Implemented, not verified**, **Planned**, **Blocked**.

## 0. Actions only you can do

| # | Action | Unblocks | Status |
|---|---|---|---|
| U1 | Xcode 27.x on macOS 26.6+ | Dev build | Done (Xcode 27.1) |
| U2 | Shutter test on the demo iPhone | Frame capture (G5) | Done: silent |
| U3 | Meta credits and API key in `backend/.env` | All Meta calls | Done |
| U5 | ~~Korean dictation~~ | — | Dropped: the MVP is English-only |
| U6 | Attach the **Participant Guide**: the exact new-work rule, video length, repo rules, judge access | Compliance | Blocked on you |
| U7 | GitHub: `brew install gh`, `gh auth login`, choose the repo name | Public repo | Blocked on you |
| U8 | Developer Mode on the iPhone | Dev build install | Done |
| U9 | **Check the credit balance** on the dev.meta.ai billing page and tell me what remains. Meta has no API for it, and the new scene loop spends more than search did (§3) | Budget | Blocked on you |
| U10 | **Pick the demo places** (needed by M5): one indoor walk (2–3 rooms or a hallway) and, for navigation, one outdoor walking route of 300–800 m that you know well, with a sighted companion | M3 exit, M5 | Blocked on you, by Nov 1 |

U4 (Expo Go) is no longer needed: we use the dev build.

## 1. What already works, and is reused

| Piece | From | Reused for |
|---|---|---|
| Camera capture queue (one in flight, 768 px JPEG, ~1.1–1.5 s cycle) | M1 | All tracks: scene, checking, search |
| `POST /v1/detect` (SAM 3.1, strict validation, no retry on the frame path) | M1 | Search, and checking scene items |
| 2-of-3 spatial confirmation; search machine (searching, confirming, found, guiding, lost, coaching) | M1 | Active Object Search (unchanged); checking scene items |
| Announcer (priority, preemption, dedupe, TTL, stale-goal drop, repeat) | M1 | All speech; it gains channels and rate caps |
| Voice controller, echo gate, barge-in, English command grammar, speaker | M2 | All commands; it gains new commands and questions |
| Magic Tap patch, mic status, stop-latency metric, `[heynavi-metrics]` log | M2 | Unchanged |
| Meta client and Spark request helpers (`backend/app/meta/`) | M0 | `/v1/scene`, `/v1/ask` |

Nothing is thrown away. Active Object Search becomes one optional capability inside the session instead of the whole product.

## 2. Proposed scope for Nov 4

**Must ship (demo-critical):**

1. **Continuous Scene Understanding.** HeyNavi starts in explore mode and Muse Spark interprets a frame every ~4–8 s, using short-term scene memory.
2. **Proactive voice guidance.** The app decides what to say: possible obstacles, new notable things, scene changes and visible text. It uses priorities, dedupe and rate caps, can always be interrupted, and keeps updates sparse by default.
3. **Grounded checks with SAM 3.1.** Any object Spark picks is checked by SAM, and "possible obstacle" lines are spoken only after SAM confirms them.
4. **Wording safety in code.** Camera lines come from templates, and a wording filter blocks distances, safety claims and directions.
5. **What already works**: voice commands and Active Object Search.

**Should ship:**

6. **Natural English questions** ("Hey Navi, what does that sign say?", "Where can I sit?"). Spark answers, or hands off to the existing search.
7. **Verbosity and updates by voice**: "fewer updates", "updates off".
8. **Outdoor readiness**: a release build, a backend reachable over cellular, and metrics uploaded to the backend.

**Stretch (gated, see M5):**

9. **Destination navigation prototype.** "Navigate to X" resolves the place with Apple MapKit and fetches a real walking route. GPS route tracking speaks "Route: …" instructions separately from camera observations. Apple MapKit returned a Seoul walking route in 320 ms with no key ([research/routing.md](research/routing.md)).

**Not in this hackathon:**

- turn-by-turn haptics;
- tracking objects between Spark calls;
- Korean;
- Muse Voice Transcribe;
- the history screen;
- attribute checks ("empty chair");
- translate and summarize.

## 3. Milestones

Rubric key: I = Impact, M = Use of Meta AI tooling, D = Demo, T = Technical depth.

| Milestone | Dates (ET) | Scope | Exit criteria | Rubric | Status |
|---|---|---|---|---|---|
| **M0 Gates + scaffold** | Oct 29 | Repo, Expo SDK 58 app, FastAPI service, Meta client, SAM parser, bench | `pytest` passes; bench reports SAM and Spark latency | T | **Implemented & tested** |
| **M1 Search loop (VS-1)** | Oct 29 | Capture queue, `/v1/detect`, confirmation, announcer, TTS, metrics | VS-1 on the iPhone | D, M | **Implemented & tested** (iPhone 16e): 6 of 6 finds; 40 s with no chair, 0 false "found"; stop 11–29 ms. See [FEASIBILITY.md §7](FEASIBILITY.md) |
| **M2 Voice (VS-2)** | Oct 29 | On-device en-US commands, echo gate, barge-in, Magic Tap fix | VS-2 works on the iPhone; G6, G7 | D, T | **Implemented & tested** (iPhone 16e). Not verified: auto-lock on a release build, recovery after a call or Siri |
| **M3 Continuous Scene Understanding** | Oct 30–31 | Day 1 starts by measuring the scene call's latency and token use on real phone frames. **Backend:** `POST /v1/scene` (Spark `minimal`, strict schema, wording filter, daily spending guard) and `POST /v1/metrics`. **App:** perception scheduler, scene memory, attention policy, scene templates, announcer channels and rate caps, explore mode as the session default, "what's around me", "fewer/more updates", "updates off/on", stop-in-silence pauses updates. Unit tests for memory, policy, filter, scheduler | On the iPhone, a scripted 5-minute indoor walk with planted objects. **Timing:** the first summary is spoken within 6 s of the start; a scene line starts p50 ≤ 5 s / p95 ≤ 7 s after its frame was captured. **Quality:** 0 repeats inside the dedupe window; 0 filtered phrases reach the speaker; every proactive line can be stopped (M2 latency). **Logged:** lines per minute and cost per minute | I, M, D, T | Planned |
| **M4 Grounding + questions** | Nov 1 | SAM checks of Spark-picked concepts (same frame, then a fresh frame); "possible obstacle" only when both pass; Spark/SAM agreement metric. `POST /v1/ask` with frame and scene memory, Spark actions `find` / `describe` / `navigate`; "Hey Navi" plus the Ask button for questions; "where can I sit?" hands off to the existing search | On the iPhone: 0 "possible obstacle" lines without SAM confirmation across 2 walks; agreement rate measured on ≥ 30 checked items; 10 scripted questions answered (latency logged, tester judges correctness); 3 searches started from natural questions | M, T, D | Planned |
| **M5 Outdoor + navigation prototype (stretch)** | Nov 2–3 | **Step 1, kept even if navigation is cut:** release build, backend over cellular (hosted or tunnel), metrics upload, auto-lock check. **Step 2:** local Expo module for MapKit place search and walking routes, `expo-location` with GPS and heading, pure-TS route tracker (snap, next step, off-route re-route, arrival), GPS accuracy gate, "Route: …" lines with a chime, scene loop kept as context, "navigate to / where am I / what's next / stop navigation" | Step 1: the app works on cellular and outdoor runs leave logs. Step 2: one real walk of 300 m or more on the U10 route with a sighted companion. Every step is announced, no instruction is given while GPS accuracy is worse than 20 m, and camera lines stay separate from route lines | I, D, T | Planned |
| **M6 Accessibility + onboarding** | Nov 2–3 (beside M5) | Voice onboarding with the safety lines, verbosity on screen and by voice, VoiceOver audit, high contrast, scene and route cards in the UI | Core tasks done with VoiceOver on and the screen covered | I, D | Planned |
| **M7 Eval, deploy, demo** | Nov 3–4 AM | Results table from the M3–M5 logs, hosted backend for judging, README/docs, **rebuild the app**, record and cut the demo video | Results filled with real numbers; video cut | T, D | Planned |
| **M8 Submit** | Nov 4 by 12:00 ET | Public repo, video link, track, models used, "built during the event" section | Submitted, with a confirmation screenshot | — | Planned |

### Gates (decided in advance, so we don't slip)

- **End of Oct 31 ET:** if the M3 exit criteria have not passed, M4 shrinks to SAM checks for obstacles only and questions are cut. M5 step 2 is cut.
- **End of Nov 1 ET:** start M5 step 2 (navigation) only if M3 and M4 have passed. Otherwise, do M5 step 1 and spend the time on demo quality.
- **End of Nov 2 ET:** if live route tracking isn't working outdoors, fall back to a **route preview**. HeyNavi speaks the real MapKit route summary and first instruction, plus the bearing from the compass, with no live tracking. If even that fails, the demo leaves navigation out and the submission lists it as planned.

### Cut list (cut from the top when behind)

1. History screen (P5)
2. Muse Voice Transcribe push-to-talk
3. Navigation re-routing and arrival polish (keep the route preview)
4. Live route tracking (keep the route preview)
5. Detailed verbosity and background items
6. Spark's `navigate` action inside questions (keep the "navigate to" command)
7. Free-form questions (keep "what's around me")

**Never cut:**
- the continuous scene loop with the attention policy;
- SAM confirmation before any "possible obstacle" line;
- the wording filter;
- stop and barge-in;
- dedupe and rate caps;
- Active Object Search (already working);
- metrics;
- the spending guard;
- the safety disclaimer.

## 4. Budget (Meta credits)

Estimates, to be replaced by the per-call `usage` the backend logs.

| Item | Estimate |
|---|---|
| Scene loop: one Spark call per ~4 s ≈ 900 calls per active hour × ~$0.0034 (G4 measured 563 input / 258 output tokens, $0.0018 per call; the scene reply is assumed about 2× larger) | about $3 per active hour |
| SAM checks: 2 calls per checked item, ~0.5–1 item per scene reply ≈ 900–1,800 calls × $0.0025 | about $2–5 per active hour |
| Active Object Search: ~1 SAM call per second while searching | about $9 per searching hour |
| Questions: ~300 × ~$0.004 | about $1 |
| **Remaining plan:** ~8 h of scene testing and demo, plus ~2 h of searching | **about $60–85** |

- **The backend's daily guard** (`DAILY_BUDGET_USD`, default $25) stops a runaway loop.
- **Please check the balance (U9).** If less than about $90 remains, the scene interval starts at 6 s instead of 4 s.

## 5. Three-minute demo (draft)

| Time | Beat | What's on screen |
|---|---|---|
| 0:00–0:15 | **Problem.** Visual information is everywhere and hard to reach without sight. Most AI apps answer *one photo* when asked. | Cold open: a phone in an unfamiliar hallway |
| 0:15–0:30 | **Start.** VoiceOver on; Magic Tap starts HeyNavi. "HeyNavi is on. I'll mention what I notice." The first summary is spoken unasked | Phone screen and the scene, side by side |
| 0:30–1:15 | **Autonomous understanding.** A slow indoor walk with no requests. Unprompted lines: "A hallway, with a door on the right of the camera view." "Possible obstacle: a chair in the lower center of the view." "I see a sign with text." The user says "fewer updates", and a "stop" barge-in cuts a line | Scene memory panel: Spark's items, each turning from *proposed* to *checked by SAM*; live SAM box; latency readout |
| 1:15–1:45 | **Conversation.** "Hey Navi, what does that sign say?" → it reads the sign. "Hey Navi, where can I sit?" → Spark starts a search for a chair → "I found a chair, on the left of the camera view" → guiding pulses → "Centered." | Ask card; search state strip (SEARCHING → CONFIRMING → FOUND → GUIDING) |
| 1:45–2:20 | **Destination route prototype (if M5 lands).** Outdoors: "Hey Navi, take me to the nearest pharmacy." → "Route: about 450 meters, 3 turns. First, …" → "Route: in about 30 meters, turn left." Separately: "I see a crosswalk in the center of the camera view." If M5 is cut, this slot becomes a longer walk plus measured latency and cost | Route card (map data + GPS accuracy) and camera card, visibly separate |
| 2:20–2:45 | **Engineering.** Spark understands → SAM verifies → the app decides what to say. Scene memory, attention policy, announcer; measured p50/p95; cost per minute | Diagram and metrics table |
| 2:45–3:00 | **Impact and honesty.** Who it helps; limits (no collision avoidance, no exact distances, doesn't replace a cane); what's next | Results and disclaimer |

Rules:

- Only show features built during the event.
- Every model output shown must be live.
- Earbuds for the recording, which also keeps echo out of the audio.
- Outdoor shots only with a sighted companion.

## 6. Bonus positioning

**Best Agentic Use-Case** fits, as long as the demo shows the loop itself:

- **Perceive:** Spark reads the scene.
- **Remember:** scene memory over time.
- **Decide** what matters: the attention policy.
- **Use a tool to check:** SAM confirms.
- **Act:** speak, or start a search from a question.
- **Keep goals:** a search or a destination persists until it is met.
- **Yield to the user:** stop, quiet, a change of goal.

We label only this loop as "agentic". The open-weight bonus stays out of scope.

## 7. Top risks

| Risk | Likelihood / impact | Trigger | Mitigation |
|---|---|---|---|
| Scene call slower than ~4 s or too costly | Medium / High | M3 day-1 measurement | 640 px frames, a smaller schema, adaptive cadence (4–8 s), the daily guard; the latency is stated honestly in the demo |
| Spark mentions things that aren't there | Medium / High | M3–M4 walks | SAM confirmation before obstacle lines; templates instead of free text; the agreement rate is reported |
| Too much talking | High / Medium | M3 walks | Rate caps, novelty and dedupe, quiet by default, "fewer updates" |
| Camera lines arrive late for a walking user | High / Medium | Latency log | Wording says what *was* visible; demo walks are slow; no safety claims |
| No connection outdoors (Metro and LAN backend unreachable) | Certain without action / High | First outdoor test | M5 step 1: release build plus a hosted or tunneled backend |
| GPS off by 10–30 m between buildings | High / Medium | M5 walk | Accuracy gate, distances prefixed with "about", re-route only after 10 s off the route |
| MapKit walking data uneven in Korea | Medium / Medium | U10 route check | Walk the route first; OSRM foot fallback |
| Free provisioning profile expires before the live final (Nov 9) | Certain / High | Calendar | Rebuild Nov 3 and again Nov 8 |
| Seen as a "Simple Image Analyzer" | Medium / Critical | Positioning | Show memory, decisions and SAM checks live, not single answers |
| Scope creep | High / High | Daily check | The gates and the cut list above |

## 8. Wireframe changes (visual identity unchanged)

Decided 2026-10-30: HeyNavi is not an object-picker app. The session screen is camera first, with minimal controls ([ARCHITECTURE §3.3](ARCHITECTURE.md)).

1. **No object selection anywhere.** The concept chooser (Chair, Cup, Door…) and "Start searching for a chair" are removed. Searches start by voice ("Find a chair", "Where is the entrance").
2. **Camera preview first**, at 9:16 so captures keep the full field of view, with tap-anywhere doing what Magic Tap does.
3. **Status and "Last said"**: what HeyNavi is doing (Observing / Observing paused / the search strip) and the line it last spoke. No lists of detected objects.
4. **Two controls**: Pause / Resume observing (End search during a search) and Describe the view, plus the mic status.
5. **Two kinds of card later (M5)**: a Route card for map instructions appears only while navigating; camera observations stay in "Last said".
6. **No distance claims from the camera.** "Caution ahead" becomes "Possible obstacle in view" (M4, after SAM confirms).
7. **Onboarding:** spoken safety lines (cane and guide dog, no guarantee of detecting obstacles, map and GPS limits) and spoken recovery when a permission is denied.

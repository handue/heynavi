# HeyNavi — Execution Plan

As of **Thu 2026-10-29**, revised the same day after the product vision changed (see [ARCHITECTURE.md §1](ARCHITECTURE.md)). This plan replaces the earlier search-first roadmap. **Updated 2026-11-02:** M0–M5 done; M6 implemented with its outdoor walk deferred; development for the demo finished (feature freeze), device checks pending (§0.1). **2026-11-03:** an outdoor walk partly verified D2 and found two bugs, fixed (§0.1); D4 still to walk.

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

### 0.1 Device checks pending (deferred by the user on 2026-11-02)

The user chose to finish development first and test afterwards. These need the iPhone and the user; none is marked as tested until the logs show it.

| # | Check | How it passes | Status |
|---|---|---|---|
| D1 | **Decision panel** (Settings › Advanced › Decision panel) | Observing indoors: the panel shows Spark's items, SAM's verdicts, and the queued line or the reason HeyNavi held back; it matches what is spoken; the camera stays smooth; VoiceOver reads it as one element | Implemented, not verified |
| D2 | **Route hint for Spark** | During a route (indoors is enough to see it): scene metrics show `"route":"right:soon"` etc. and scene replies still pass; outdoors at a crossing, a crosswalk may be mentioned as a camera line, never merged into a route line | **Partly verified** (2026-11-03 walk): every look on the route carried `route=straight`, and 12 of 13 replies passed (one Spark timeout). A turn coming up (`:soon`, left/right) and the crossing part are not seen yet |
| D3 | **Crosswalks and intersections in the scene prompt** | Outdoors: a visible crosswalk is reported as a landmark and said as a description ("A crosswalk is visible …"), with no signal state | Implemented, not verified |
| D4 | **M6 outdoor walk** (exit test) | One walk of 300 m or more with a sighted companion: a step line for every turn, the arrival, no instruction with GPS worse than 20 m, few re-routes (`"reason":"route"` metrics) | Not passed: first walk failed, fix unit-tested only. **Second try (2026-11-03) did not test it:** a 1.1 km route (6 turns) started, GPS was good after the first fix (21 m), but after 2 minutes a tap paused observing and HeyNavi then left the foreground for ~10 minutes (no GPS in the background), so no turn was reached; one off-route later (34 m at 3 m accuracy). Walk again with HeyNavi kept on screen |
| D5 | Earlier not-verified items | "quieter" recognized on the phone; the hedged "There may be …" line heard; a run with Screen Curtain on; recovery after a call or Siri | Implemented, not verified. The 2026-11-03 sessions ran at verbosity "Few" (quiet), which only "quieter"/"fewer updates" or Settings set, so "quieter" probably worked earlier; set it back to Normal for the demo |
| D6 | Rebuild for the live final | Xcode reused the free profile, so the app installed on 2026-11-02 still stops launching at **2026-11-05 19:10 UTC (2:10 PM ET)**. Fine for recording and the Nov 4 submission; rebuild after it expires and before the Nov 9 final (Nov 6–8) | Planned |

**For the next walk (learned 2026-11-03):** keep HeyNavi on screen the whole time (in the background iOS stops the camera, GPS and route; the screen does not auto-lock while a route is active); do not tap the camera view (when nothing is being spoken, a tap pauses observing, so a tap meant to cut a line that just ended pauses everything); Settings › Announcement frequency › Normal. Fixed after the walk and unit-tested: a camera line that expires unheard behind a route line is said on the next look if still in view; boxes no longer jump back after 10 s.

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

Revised 2026-10-30 after M3 round 2. The target experience: open HeyNavi → the camera observes automatically → the AI recognizes several relevant objects → HeyNavi says what is ahead and roughly where → the user asks questions naturally. Priorities, in order:

**Must ship (demo-critical):**

1. **Autonomous multi-object recognition.** Muse Spark reads a frame every ~4–8 s with short-term scene memory and proposes the relevant objects, features and possible obstacles; SAM 3.1 automatically locates and confirms up to 3 of them on the same frame. No object picker, no target required.
2. **Approximate directional announcements.** "There's a chair ahead on your left." "Possible obstacle: a box directly ahead." User-relative only while the phone is held upright and level (motion sensor); otherwise relative to the camera view. Never distances, never which way is safe.
3. **Automatic detection overlays.** Blue boxes for every SAM-confirmed object while observing, not only during a search.
4. **Reliable, non-repetitive speech.** Only confirmed objects, obstacles first, at most two things per line, dedupe and rate caps from scene memory, interruptible at any time, wording filter and command audit on every line.
5. **Real-device testing on the iPhone 16e** every round, measured from the Metro log.
6. **What already works**: voice commands, "what's around me", and voice-started Active Object Search ("Find a chair", "Where is the entrance").

**Should ship:**

7. **Natural English questions** ("Hey Navi, what does that sign say?", "Where can I sit?"). Spark answers from the frame and scene memory, or hands off to the existing search.
8. **Outdoor readiness**: a release build, a backend reachable over cellular, and metrics uploaded to the backend.

**Stretch (gated, see M5):**

9. **Destination navigation prototype.** "Navigate to X" resolves the place with Apple MapKit and fetches a real walking route. GPS route tracking speaks "Route: …" instructions separately from camera observations. Apple MapKit returned a Seoul walking route in 320 ms with no key ([research/routing.md](research/routing.md)).

**Not in this hackathon:**

- turn-by-turn haptics;
- tracking objects between Spark calls, and precise distances or safe-route decisions of any kind (never);
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
| **M3 Autonomous scene awareness** | Oct 30–Nov 1 | **Part 1 (done):** `POST /v1/scene` (Spark `minimal`, strict schema, wording filter, daily spending guard), `POST /v1/metrics`; scene memory, attention policy, templates, announcer channels and rate caps; observing as the session default; camera-first screen with no object picker; "what's around me", "quieter", "more detail", "updates off/on". **Part 2 (walking obstacles):** Spark selects what is relevant to walking, not what is interesting; SAM 3.1 checks Spark's top 3 walking-relevant objects on the same frame inside `/v1/scene`; confirmed hazards first, things SAM could not localize said hedged ("There may be …"), decor never; positions from SAM's boxes; "Possible obstacle" only after SAM confirms; up to two things per line; user-relative directions only when the motion sensor shows the phone held forward; blue boxes for every confirmed object; commands said over HeyNavi's speech are picked out of the echo | On the iPhone, scripted indoor walks. **Timing:** first summary within 6 s of the start; a scene line starts p50 ≤ 5 s / p95 ≤ 7 s after its frame (SAM included). **Quality:** 0 repeats inside the dedupe window; 0 filtered phrases reach the speaker; 0 "possible obstacle" lines without SAM confirmation; boxes shown for confirmed objects; directions match the phone's hold; every line can be stopped. **Logged:** lines and cost per minute, Spark/SAM agreement | I, M, D, T | **Implemented & tested** on the iPhone 16e (5 rounds, 2026-10-30). Only walking-relevant things announced and outlined; hazards first; directions followed the phone's hold on every frame; 0 failed looks in the final check (2 of 12 timed out in round 4, now not spoken unless twice in a row); no repeats observed. Frame-to-speech p50 5.7 s / p95 6.8 s: **p50 misses the 5 s target by ~0.7 s**. Not verified on the phone: "quieter" (not recognized in the final check), commands said over HeyNavi's speech, the hedged "There may be …" line (unit-tested only) |
| **M4 Questions + polish** | Oct 30 | `POST /v1/ask` (Spark answer + SAM check of what it is about); questions without the wake phrase, also said over HeyNavi's speech; "where is …" hands off to a search when the thing is not in view; "quieter" aliases; latency: 640 px scene frames, 3 items, SAM checks capped at 1.5 s | Questions answered on the iPhone; commands said over speech tested; frame-to-speech p50 ≤ 5 s | M, T, D | **Implemented & tested** on the iPhone 16e (round 1): "where is a door" answered and outlined (2.4 s), "where is the entrance" not in view → search, "what's in front of me" picked out of the echo twice, stop 11–12 ms and cancel over speech; frame-to-speech **p50 4.95 s** / p95 7.5 s. Fixed after the round, unit-tested only: searches start only from "where" questions (a misheard "what … projector nearby" started one), "spider" as an alias of "quieter" (heard twice over speech). Limitations in ARCHITECTURE §7.2 |
| **M5 Final UI design + outdoor readiness** | Oct 30 | Final session screen in the approved visual identity (clean white, Meta blue, high contrast): camera-first layout, status and "last said" caption, route card slot; voice onboarding with the safety lines; VoiceOver audit; **release build** with the JS bundled, a backend reachable over cellular (hosted or tunnel), metrics upload, auto-lock check | The app runs on cellular without Metro; core tasks done with VoiceOver on and the screen covered; outdoor runs leave logs | I, D | **Part 1 implemented & tested** on the iPhone 16e (2026-10-30): final UI approved by the user (living jelly symbol, full-screen camera after wireframes 02–04, white description and obstacle cards, boxes kept on their objects with the gyroscope, onboarding, Settings, runtime server URL, metrics upload); VoiceOver order and Magic Tap checked; symbol 60 fps. **Release build on cellular (2026-10-30):** Wi-Fi off, Cloudflare tunnel to the Mac backend (requests arrived from a mobile-carrier address); 9 scene looks, 0 failures, round trip p50 4.8 s / p95 6.2 s, frame-to-speech p50 5.9 s; metrics uploaded to the backend; with Auto-Lock at 30 s the screen stayed on for a minute of observing and locked on Home. Not verified: a run with Screen Curtain on, a long outdoor walk |
| **M6 Destination navigation prototype** | Nov 1–2 | Local Expo module for MapKit place search and walking routes, `expo-location` GPS and heading, pure-TS route tracker (snap, next step, off-route re-route, arrival), GPS accuracy gate, "Route: …" lines with a chime kept apart from camera lines, scene loop kept as context; "navigate to / where am I / what's next / stop navigation" | One real walk of 300 m or more with a sighted companion: every step announced, no instruction while GPS accuracy is worse than 20 m, camera lines separate from route lines | I, D, T | **Part 1 implemented, walk not passed yet** (2026-10-30). Indoors on the iPhone 16e: "where am I", place search (24 results, 0.5–0.8 s), walking route (0.1–0.2 s), "what's next", "stop navigation" all worked. **First outdoor walk (release build, two short sessions): failed the exit test** — no turn or arrival announced; "off the route" fired 7 times at 26–41 m from the map's line with 6–16 m GPS accuracy (a wide street's sidewalk plus GPS error), each re-route looping "Recalculating"; GPS accuracy mostly 25–58 m, so instructions were withheld. Fixed after the walk, unit-tested only: off-route credits the GPS error (up to 15 m) and waits 20 s after a route starts; at most one re-route per 45 s (replaying the walk's readings: 1 re-route instead of 7). **Second walk deferred by the user (2026-11-02)** to finish the main features first: §0.1 D4. Added 2026-11-02, unit-tested only: each scene look carries a route hint (next step's kind and whether it is close, no place or street), so Spark weighs corners, crosswalks and curbs (§0.1 D2). If the walk is not passed before recording, the demo shows the route start line (a route preview) instead of live tracking |
| **M7 Demo, results, docs** | Nov 3 | Script and record the 3-minute video (indoor obstacles + questions, outdoor route if M6 lands); results table from the logs; README and architecture final; **rebuild the app** (7-day profile) | Video cut; numbers in the README are real | T, D | **Development part done 2026-11-02, not verified on the phone:** the decision panel for the agent-loop beat (§5, 0:30–1:15; §0.1 D1); `backend/scripts/results.py` makes the results table from the uploaded metrics, and the README's table comes from it. Release build reinstalled 2026-11-02. Still to do: device checks (§0.1), video, final README numbers from the demo runs |
| **M8 Submit** | Nov 4 by 12:00 ET | Public repo, video link, track, models used, "built during the event" section; buffer until the 9:00 PM ET deadline | Submitted, with a confirmation screenshot | — | Planned |

### Gates (decided in advance, so we don't slip)

Revised 2026-10-30 after M4: the user's order is final UI design, then the navigation prototype, with the demo and submission protected.

- **End of Nov 1 ET:** the release build must run on cellular (M5). If it does not, navigation (M6) shrinks to a route preview over Wi-Fi, and the outdoor demo beat is dropped.
- **End of Nov 2 ET:** if live route tracking is not working outdoors, fall back to a **route preview**: HeyNavi speaks the real MapKit route summary and first instruction, plus the bearing from the compass, with no live tracking. If even that fails, the demo leaves navigation out and the submission lists it as planned.
- **Nov 3 is for the demo.** No new features after the end of Nov 2 ET; only fixes for what the recording shows.

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
| Scene loop: one Spark call per ~4–5 s ≈ 750–900 calls per active hour × ~$0.005 (measured on the iPhone: ~1,350 input / ~850 output tokens) | about $4 per active hour |
| SAM checks: up to 3 calls per scene frame ≈ up to 2,700 calls per active hour × $0.0025 | up to about $7 per active hour |
| Active Object Search: ~1 SAM call per second while searching | about $9 per searching hour |
| Questions: ~300 × ~$0.004 | about $1 |
| **Remaining plan:** ~6 h of observing (tests and demo) at up to ~$11 per hour, plus ~2 h of searching | **about $70–90** |

- **The backend's daily guard** (`DAILY_BUDGET_USD`, default $25) stops a runaway loop.
- **Please check the balance (U9).** If less than about $90 remains, the scene interval starts at 6 s instead of 4 s, and SAM checks 2 objects per frame instead of 3.

## 5. Three-minute demo (draft)

| Time | Beat | What's on screen |
|---|---|---|
| 0:00–0:15 | **Problem.** Visual information is everywhere and hard to reach without sight. Most AI apps answer *one photo* when asked. | Cold open: a phone in an unfamiliar hallway |
| 0:15–0:30 | **Start.** VoiceOver on; Magic Tap starts HeyNavi. "HeyNavi is on. I'll mention what I notice." The first summary is spoken unasked | Phone screen and the scene, side by side |
| 0:30–1:15 | **Autonomous understanding.** A slow indoor walk with no requests. Unprompted lines: "A hallway, with a door on the right of the camera view." "Possible obstacle: a chair in the lower center of the view." "I see a sign with text." The user says "fewer updates", and a "stop" barge-in cuts a line | The decision panel (built 2026-11-02): Spark's items, SAM's verdict for each, and the line HeyNavi chose or why it held back; live SAM boxes; timings and cost |
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

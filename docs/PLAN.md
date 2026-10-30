# HeyNavi — Execution Plan

As of **Thu 2026-10-29**. Nothing is implemented yet, and we are about 2 days behind the original schedule.

- Hard deadline: **Wed Nov 4, 9:00 PM ET** (Nov 5, 11:00 KST).
- Internal deadline: **Nov 4, 12:00 PM ET**, leaving 9 hours of buffer.

Every status here is one of: **Implemented & tested**, **Implemented, not verified**, **Planned**, **Blocked**.

## 0. Blocking actions only you can do (today)

| # | Action | Unblocks | Status |
|---|---|---|---|
| U1 | **Chosen 2026-10-29:** update macOS to 26.6 or later, then install **Xcode 27.x from the App Store** (Xcode 27 needs macOS 26.6+). Open it once, then run `sudo xcode-select -s /Applications/Xcode.app`. Fallback if the update fails: Xcode 26.6 from developer.apple.com/download/all. | Dev build, voice input | In progress (you) |
| U2 | **Shutter test.** Silent switch on, take a photo in the Camera app. Tell me: click or no click, iPhone model, iOS version, and the country the phone was bought in. | Frame-capture choice (gate G5) | Blocked on you |
| U3 | **Claim the $150 credits** through the Participant Guide's form. Create an API key at dev.meta.ai and set a spend limit (suggest $60). Put the key in `backend/.env` yourself; never paste it in chat. | All Meta calls (gates G1–G4, G8) | Blocked on you |
| U4 | Install **Expo Go**, then sign in to the *same* Expo account in the app and in a terminal (`npx expo login`). | Today's Expo Go prototype | Blocked on you |
| U5 | ~~Add Korean dictation~~. Not needed: the MVP is English-only (decision 2026-10-29). | — | Dropped |
| U6 | Attach the **Participant Guide**. I need the exact new-work rule, video length, repo rules, judge access, and anti-project wording. | Compliance | Blocked on you |
| U7 | Choose the project folder and GitHub username. Then `brew install gh` and `gh auth login`. | Public repo with dated commits | Blocked on you |
| U8 | iPhone: enable Developer Mode (Settings › Privacy & Security) after first connecting it to the Mac. | Dev build install | Blocked on you, after U1 |

The $99 Apple Developer Program is **not needed** unless the guide requires judges to install the app themselves.

## 1. Smallest physically testable vertical slice (VS-1)

> **Tap anywhere → "Looking for a chair" → frames every ~1 s → FastAPI → `sam-3.1` → 2-of-3 confirmation → "I found a chair, on the left of the camera view" + haptic → tap again stops.**

- **Runs in Expo Go today**, before Xcode is installed: expo-camera, expo-image-manipulator, expo-speech and expo-haptics are all in Expo Go. The concept is fixed ("chair") or chosen with a button; voice input comes in VS-2.
- **Proves the riskiest pieces end to end, on the real device**: frame capture, hosted SAM latency, confirmation logic, spoken output, and the shutter-sound question.
- **Acceptance:**
  - It finds a real chair in a real room 5 times out of 5.
  - It doesn't announce when no chair is in view (30 s, 0 false "found").
  - Stage timings are logged.
  - Stop takes effect within 500 ms.

**VS-2** = VS-1 + dev build + voice: "Hey Navi, find my cup" → search, plus "stop", "repeat", "pause", "resume". This completes the P0 loop from the brief: Voice Command → Active Camera → Real Meta AI Inference → Contextual Reasoning → Automatic Spoken Feedback.

## 2. Milestones

Rubric key: I = Impact, M = Use of Meta AI tooling, D = Demo, T = Technical depth.

| Milestone | Dates (ET) | Scope | Exit criteria | Rubric | Status |
|---|---|---|---|---|---|
| **M0 Gates + scaffold** | Oct 29 | Repo, Expo SDK 58 app, FastAPI service, Meta client, SAM token parser plus unit tests, `bench.py` for gates G1–G4 | `pytest` passes; bench reports p50/p95 for `sam-3.1` and Spark `minimal` with our key | T | **Implemented & tested** (174 backend + 31 app tests). Bench not run yet: waiting for the key |
| **M1 VS-1 (P0)** | Oct 29–30 | Capture queue, `/v1/detect`, confirmation, announcer v0, TTS, pause/resume, stage metrics | VS-1 acceptance on the iPhone in Expo Go | D, M | **Implemented & tested** (dev build, iPhone 16e): 6 of 6 searches in a row found the chair; a 40 s run with no chair gave 0 false "found"; stop-to-silence 11–29 ms (button and Magic Tap). See [FEASIBILITY.md §7](FEASIBILITY.md) |
| **M2 Dev build + voice (P0)** | Oct 30 | Xcode build, expo-speech-recognition listener + watchdog, **English** command grammar, echo gate, barge-in, Magic Tap fix. Before M2 counts as complete, the remaining VS-1 checks must also pass: 5 successful searches in a row, a 30 s run with no chair and no false announcement, and measured stop latency | VS-2 works on the iPhone; G6 (en-US) and G7 resolved; VS-1 checks pass | D, T | **Implemented & tested on the iPhone 16e**: "Hey Navi, find/search a chair", stop, cancel, pause, resume, repeat by voice; echo gate and barge-in on the loudspeaker; Magic Tap with VoiceOver; G6 passed in Airplane Mode; VS-1 checks pass. Not verified: auto-lock on a release build, recovery after a call or Siri |
| **M3 Active Search agent (P1)** | Oct 30–31 | Full state machine, `/v1/plan` lexicon + Spark, multiple instances, guiding haptics, lost/coaching prompts, cancel/change goal, attribute verify (if G4 allows) | 10 scripted searches logged; 0 repeated "found" announcements | M, T, D | Planned |
| **M4 Announcer + context (P2)** | Oct 31–Nov 1 | Priorities, dedupe, TTL, preemption, rate limits, stale-goal dropping; Jest tests | Unit tests for every rule; no ambient speech during a search | T | Planned |
| **M5 Read + describe (P3)** | Nov 1 | Streamed `/v1/read` and `/v1/describe`; repeat / summarize / translate; text-hash dedupe; uncertainty phrasing | Reads 3 real signs; spoken feedback within 300 ms of each request | M, I | Planned |
| **M6 Accessibility + UI (P2/P4)** | Nov 1–2 | Voice onboarding, settings by voice, VoiceOver audit, high contrast, wireframe styling, cautious obstacle mentions in watch mode | Core tasks completed with VoiceOver on and the screen covered | I, D | Planned |
| **M7 Eval, deploy, docs** | Nov 2–3 | 40-photo eval, live-trial metrics, hosted backend, README/architecture/results, **rebuild the app** (7-day profile), record demo | Results table filled with real numbers; demo video cut | T, D | Planned |
| **M8 Submit** | Nov 4 by 12:00 ET | Checklist: public repo, video link, team, track, theme, models used, "built during the event" section | Submitted, with a confirmation screenshot | — | Planned |

### Cut list (cut from the bottom when behind)

1. History screen (P5)
2. Muse Voice Transcribe push-to-talk path
3. Watch mode / automatic obstacle mentions (P4)
4. Attribute verification ("empty chair")
5. Translate / summarize for text
6. ~~Korean~~: **cut by product decision on 2026-10-29.** The MVP is English-only, and multilingual support is a future enhancement (see ARCHITECTURE §12)

**Never cut:** VS-2, multi-frame confirmation, announcement dedupe/preemption, stop/barge-in, metrics, the safety disclaimer.

## 3. Budget (Meta credits)

| Item | Estimate |
|---|---|
| SAM 3.1: about 3 active hours of search at ~1 fps ≈ 10,800 frames × $0.0025 | about $27 |
| Muse Spark: plan, describe, read, verify ≈ 1,500 calls × ~2k tokens (reasoning included) | about $10–15 |
| Muse Voice Transcribe | < $1 |
| **Total** | **about $40 of the $150** |

The backend logs the cost of each session, so these estimates get replaced with real figures.

## 4. Three-minute demo (draft)

| Time | Beat | What's on screen |
|---|---|---|
| 0:00–0:20 | **Problem.** Visual information is everywhere and hard to get at without sight. Most AI apps answer *one photo*. | Cold open: a phone in an unfamiliar room, screen dark |
| 0:20–0:45 | **Voice-first.** VoiceOver on; Magic Tap starts HeyNavi; spoken English onboarding | Phone screen and room, side by side |
| 0:45–1:35 | **Signature search.** "Hey Navi, find my chair." The user sweeps slowly: "Still looking…" → candidate → "I found a chair, on the left" → guiding pulses → "Centered." Then they change the goal mid-search ("Actually, find the door") and stop by voice. | Live overlay of SAM boxes, the state chip (SEARCHING → CONFIRMING → FOUND), and a latency readout |
| 1:35–2:05 | **Text reader.** "Read that sign" → reads it, "repeat that", then "summarize that" | Text card from wireframe 05 |
| 2:05–2:35 | **Engineering.** Architecture diagram; why SAM 3.1 runs the main loop and Muse Spark plans and verifies; state machine; announcement engine; measured p50/p95 | Diagram + metrics table |
| 2:35–3:00 | **Impact and honesty.** Who it helps, real results, limits (doesn't replace a cane), what's next | Results + disclaimer |

Rules: only show features built during the event. Every model output shown must be live. Earbuds for the recording, which also avoids echo in the audio.

## 5. Bonus positioning

**Best Agentic Use-Case** is a genuine fit, as long as the demo shows the agent loop itself:

- a goal that persists over time,
- a plan step (Muse Spark),
- repeated observations (SAM 3.1),
- weighing evidence across frames,
- clarifying questions,
- goal changes and cancellation.

We should not label anything else as "agentic". The open-weight bonus is out of scope unless partner credits arrive *and* the core is finished.

## 6. Top risks

| Risk | Likelihood / impact | Trigger | Mitigation |
|---|---|---|---|
| Hosted SAM latency over 1.5 s | Medium / High | Gate G2 | Adaptive cadence; 640 px frames; Roboflow/fal behind the same interface |
| Meta API access, region or billing issue | Low–Medium / Critical | Gate G1 | Ask organizers in Discord #questions on day 0; nothing else depends on it until M0 |
| Shutter sound on a Korea-market iPhone | **Medium–High** / High | Gate G5 | VisionCamera v5 `useFrameOutput` behind `FrameSource` (budget 4 h); fallback: local Expo module |
| SDK 58 dev build fails | Low–Medium / High (lower now that we use Xcode 27, which SDK 58 targets) | Gate G7 | `EXPO_USE_PRECOMPILED_MODULES=0`; Expo Go keeps VS-1 alive meanwhile |
| Muse Spark 10–30 s per call | High / Medium | Gate G4 | Already off the main loop; streaming; earcons; text-only follow-ups |
| Echo breaks voice barge-in | Medium / Medium | M2 testing | Echo gate; earbuds; tap and Magic Tap always work |
| Seen as a "Simple Image Analyzer" | Medium / Critical | Positioning | Lead with the goal-holding agent; show state transitions live |
| Free provisioning profile expires before the live final (Nov 9) | Certain / High | Calendar | Rebuild Nov 3 and again Nov 8 |
| Scope creep | High / High | Daily check | The cut list above |

## 7. Proposed wireframe changes (visual identity unchanged)

1. **Screens 02–06 become modes of one camera session.** A mode chip (Find / Describe / Read) sits in the status pill. The camera never unmounts.
2. **Add a search-state strip** to 02: the target ("chair"), the state (Searching / Checking / Found / Guiding), and a 3-dot confirmation indicator. This is the most important visual for judges.
3. **Remove the distance claims** ("about 1 meter", "2 meters ahead") in 04 and 06. Replace them with camera-relative wording ("lower center of the view", "looks close"). Rename "Caution ahead" to "Possible obstacle in view".
4. **Preview at 9:16, not full-bleed**, so captures keep the full field of view. Controls go below the preview.
5. **A large tap-anywhere area** on the session screen for start, stop and listen, so the Pause/Options buttons aren't the only controls.
6. **History (08):** text only, opt-in, no thumbnails by default (frames are never stored).
7. **Onboarding (09):** add a spoken safety line ("HeyNavi doesn't replace your cane or guide dog") and spoken recovery when a permission is denied.

These change the wording and layout of the approved designs, not the colors, typography or brand.

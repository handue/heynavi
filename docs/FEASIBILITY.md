# HeyNavi — Feasibility Findings

Researched 2026-10-29 by five independent research passes, each followed by an adversarial fact-check against primary sources. Nothing here has been tested with our own API key or iPhone yet; the [Day-0 gates](#7-day-0-gates-must-be-measured-by-us) list what we still have to measure ourselves.

Status legend:

- ✅ **Verified**: confirmed from a primary source (official docs, source code, package registry, App Store listing).
- 🟡 **Likely**: secondary sources only, or a participant's copy of the private Participant Guide.
- ❓ **Unknown**: has to be measured or confirmed on our account or device.

---

## 1. Hackathon rules

| Item | Status | Finding |
|---|---|---|
| Host / submission | ✅ | Meta + Cerebral Valley. Submission portal: `cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit`. Event page: [dev.meta.ai/events/global-hackathon](https://dev.meta.ai/events/global-hackathon) |
| Official Rules | ✅ | "Hackathon Terms & Conditions ('Official Rules') and Event Waiver", dated Oct 25, 2026 ([waiver page](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)) |
| Judging weights | ✅ | Impact 30%, Use of Meta AI Tooling 25%, Demo 25%, Technical Depth & Execution 20%. The Demo criterion covers both whether the product holds up live and the quality of the demo video. |
| Indie track judging blurb | ✅ | "creativity, technical ambition, and whether it works" |
| Deadline | ✅ | Nov 4, 9:00 PM ET = **2026-11-05 02:00 UTC = Nov 5, 11:00 KST**. The platform shows a 6-hour grace field, but no rule mentions it, so don't rely on it. |
| Judging dates | ✅ | Judging runs Nov 4–8 (not Nov 5–8). Live final on Nov 9. Bonus prizes announced on or about Nov 10. |
| Meta credits | ✅ | $150 in Meta Model API credits per selected participant, valid for a 10-day window. Credit Terms PDF unreachable (expired link), so which models they cover is unverified. |
| Partner credits | 🟡 | Baseten / Modal / Fireworks credits go "to select participants", with conflicting amounts. Not a dependency. |
| New-work rule | 🟡 | The public rules only require original, solely owned work, and allow open source. Per community notes, the Participant Guide says the demo may only show work built during the event. **Confirm the wording in our guide.** |
| Anti-projects | 🟡 | Per community notes: "Simple Image Analyzers", and anything giving medical advice. Both shape how we position HeyNavi. |
| 3-min video, public repo | 🟡 | Per community notes. Confirm in the guide. |
| How judges run a mobile app | ❓ | Not found anywhere. Assume demo video + repo + live final. |
| Bonus categories | 🟡 | Best Agentic Use-Case ($5K), Best Build on Open Weight Models ($10K), Most Viral ($20K), Community Vote, Best Creative Build. Names come from community notes only. |

**Action:** the Participant Guide (login-gated at `cerebralvalley.ai/e/meta-ai-developer-hackathon/details`) overrides everything marked 🟡.

## 2. Meta Model API

Base URL is `https://api.meta.ai/v1`, with `Authorization: Bearer $MODEL_API_KEY` (keys start with `LLM_`). It is OpenAI-compatible: Chat Completions and Responses. Meta ships no SDK of its own; use `openai` (3.41.0, supports Python 3.14) with `base_url`. The old `llama-api-client` package is dead. ✅ ([auth](https://dev.meta.ai/docs/authentication.md), [sdks](https://dev.meta.ai/docs/sdks.md))

| Model ID | Role in HeyNavi | Price | Limit | Notes |
|---|---|---|---|---|
| `sam-3.1` | **Per-frame detector (main loop)** | $2.50 / 1k images | 3,000 RPM (separate from Spark's) | ✅ Called via `POST /v1/responses` with an `input_text` noun phrase plus an `input_image` data URL. Returns `<\|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..;c=..\|>` tokens; an empty `output_text` means no match. `metadata.include_confidence:"true"` adds the `c` score, `mask_encoding:"one_bit"` shrinks the masks. **No published latency.** ([segmenting](https://dev.meta.ai/docs/sam/segmenting.md)) |
| `muse-spark-1.3` | Planner, verifier, scene description, OCR | $1.25 in / $4.25 out per 1M tokens | 3,000 RPM | ✅ Image input, `json_schema` structured output, documented grounding on a 0–1000 box grid. **Reasoning cannot be disabled**: `minimal` is the lowest effort and `none` returns 400. Reasoning tokens are billed as output. |
| `muse-voice-transcribe-1.0` | Optional Meta STT for push-to-talk questions | $0.18 / audio hour | 256 concurrent streams | ✅ Realtime WebSocket or batch WAV. Supports English and Korean, with code-switching. The key must stay server-side (no client tokens). Third-party benchmark P99 about 1.9 s ([Pipecat](https://github.com/pipecat-ai/pipecat/blob/main/src/pipecat/services/stt_latency.py)). |
| `muse-spark-*-contributor` | **Do not use** | about 12× cheaper | 150 RPM | ✅ Meta may train on the content. Wrong for camera frames from a blind user's home. |
| `muse-wonder-1.0` | Not used | $4 / $20 | — | ✅ Expensive, slow, and **unavailable in South Korea**. |
| Muse Spark Open / Muse Glimmer | Not used | — | — | ✅ Open weights, not on the Model API. Only relevant to the open-weight bonus. |
| Text-to-speech | — | — | — | ✅ **The Meta API has no TTS.** Speech output is on-device. |

Five findings shape the design:

1. **Muse Spark latency is the biggest risk.** Roboflow's independent evals put Muse Spark 1.3 at *low* effort at about 26 s per object-detection sample and about 27 s for OCR ([Roboflow](https://playground.roboflow.com/models/meta/muse-spark-1-3)). `minimal` effort was never measured. ❓ So Muse Spark **cannot be in the per-frame loop**. It is used for planning, verification, description and reading, each behind spoken "one moment" feedback.
2. **SAM 3.1 is hosted, cheap, and built for this.** Text-prompted concept detection returns every instance with a confidence score. It needs English noun phrases (inferred) and works poorly with commands, questions or negation in the prompt. Per-image calls give no stable object IDs, so we have to match detections across frames ourselves. ✅
3. **Privacy defaults.** `/v1/responses` stores requests by default, so every SAM call must send `store:false`. ✅ ([responses](https://dev.meta.ai/docs/protocols/responses.md))
4. **Errors to handle.** These are all documented: `content_policy_violation` (400), 429 with Retry-After, 503 with Retry-After of 60 s, and a 504 on long non-streaming requests (stream Spark responses to avoid it). ✅ ([errors](https://dev.meta.ai/docs/error-handling.md))
5. **Region.** South Korea isn't on the restricted list, and only Wonder is blocked there. A forum thread (Oct 24) still reports "not available in your region" errors. ❓ Confirm with `GET /v1/models` from our account.

## 3. Camera frame sampling (Expo)

| Item | Status | Finding |
|---|---|---|
| Expo version | ✅ | **SDK 58** (RN 0.88.1, React 19.3, New Architecture mandatory). `expo@58.0.21` is npm `latest`. |
| Expo Go | ✅ | **Expo Go 58.0.5 is live in the US and KR App Stores** (since Oct 22). It requires logging in to the same Expo account in both the CLI and the app. |
| Primary capture path | ✅ | `CameraView` + `takePictureAsync({pictureRef:true, shutterSound:false})`, then `ImageManipulator.manipulate(ref).resize().renderAsync()` and `saveAsync({format:JPEG, compress, base64:true})`. Works in Expo Go and in dev builds. The manipulator also fixes EXIF orientation. |
| Concurrency | ✅ | A second `takePictureAsync` while one is in flight throws `CameraNotReadyException`. **One serialized capture queue** for all features. |
| Field-of-view crop | ✅ | Captures are cropped to the preview's aspect ratio. A full-screen portrait preview loses about 18% of the horizontal field of view, so size the preview at 9:16. |
| Remount crash | ✅ | [expo#50015](https://github.com/expo/expo/issues/50015): re-parenting `CameraView` breaks capture. Keep it mounted, with overlays as absolute siblings. |
| Screen lock | ✅ | Release builds auto-lock the screen. Call `useKeepAwake` while the camera is active. |
| **Shutter sound** | ❓ **critical** | `shutterSound:false` uses a legacy workaround. iPhones sold for Japan or Korea (possibly decided by the SIM) **always** play the shutter sound, and that applies to VisionCamera's photo capture too. If the demo iPhone clicks, only video-frame capture is silent: VisionCamera v5 `useFrameOutput` (dev build only), or a small local Expo module. |
| Lens switching | ✅ | expo-camera 58.0.12 made the multi-lens camera the default, so the field of view can jump between frames. Pin `selectedLens` to the wide lens if detections flicker. |

## 4. Voice input and output

| Item | Status | Finding |
|---|---|---|
| STT library | ✅ | `expo-speech-recognition@58.0.1` (SFSpeechRecognizer). **Needs a dev build; it is not in Expo Go.** Supports continuous recognition, interim results, `contextualStrings`, and `iosCategory`. |
| On-device recognition | ✅ | `requiresOnDeviceRecognition` falls back to network recognition *silently* when the locale has no on-device model. Network recognition has a 1-minute cap and quotas. **en-US verified in Airplane Mode on the iPhone 16e (G6).** The MVP is English-only. |
| Session lifecycle | ✅ | No auto-restart. Sessions end on Bluetooth route changes (#133) and occasionally stall (#81), so we need a restart and watchdog loop. |
| Audio session | ✅ | The default `measurement` mode lowers playback volume. Use `playAndRecord` with `defaultToSpeaker`/`allowBluetooth` and mode `default`. |
| TTS | ✅ | `expo-speech`: `speak()` **queues** and `stop()` clears the queue. `onError` never fires on iOS; track speaking state with `onStart`/`onDone`/`onStopped`. |
| Echo | ✅ | The mic hears our own TTS (confirmed on device: "Stopped searching." comes back as "stop searching"). `iosVoiceProcessingEnabled` was not tried. **Echo gating in JS works on the loudspeaker** (see the M2 results below), plus tap and Magic Tap as reliable barge-in. Earbuds are still safer for the demo. |
| Wake word | 🟡 | Picovoice's free tier reportedly ended Jun 30, 2026. "Hey Navi" will be matched as a phrase in the on-device transcript instead. |
| VoiceOver | ✅ | VoiceOver and app TTS can talk over each other. Policy: self-voice the camera screen with no live accessibility announcements, and provide `onMagicTap` and `onAccessibilityEscape`. Magic Tap needs a React Native 0.88 patch (`apps/mobile/patches/`); verified on device in M2. |
| expo-audio PCM stream | ✅ | Forces the iOS `.record` category, which mutes playback. Half-duplex only, never alongside the recognizer. |

## 5. Builds and distribution

| Item | Status | Finding |
|---|---|---|
| This Mac | ✅ | macOS 26.4, Apple Silicon, Node 24.20, Python 3.14.7, git, Homebrew. **No Xcode** (only Command Line Tools), no CocoaPods, no `gh`. |
| Xcode | ✅ | The App Store's Xcode 27.x **requires macOS 26.6+**. **Xcode 26.6** runs on macOS 26.2+, can install to iOS 15+ devices, and meets SDK 58's documented minimum (Xcode 26.4). Download it from developer.apple.com/download/all. ([Apple](https://developer.apple.com/support/xcode/)) |
| Precompiled modules | ❓ | Nobody has confirmed that SDK 58's prebuilt XCFrameworks build with Xcode 26.6. Fallback: `EXPO_USE_PRECOMPILED_MODULES=0`. Last resort: update macOS and install Xcode 27.1. |
| Free Apple ID | ✅ | Local `npx expo run:ios --device` works with a free Personal Team. Profiles **expire after 7 days**, with a limit of 3 devices and 10 App IDs. Needs Developer Mode on the iPhone. ([Apple](https://developer.apple.com/support/compare-memberships/)) |
| EAS cloud build | ✅ | Device builds need the **paid** $99 Apple Developer Program, and so does TestFlight. |
| Judges' access | 🟡 | Realistically: demo video + public repo + a hosted backend + the live final. Optional extra: an Expo **web** build in Safari, which captures frames through a canvas (silent) and could be shared as a URL. |

## 6. SAM 3.1 hosting alternatives

Used only if `sam-3.1` on the Meta API fails our Day-0 gate:

- **Roboflow Serverless** `sam3/concept_segment`: SAM 3, not 3.1. Hosted latency unknown; its 251 ms figure is self-hosted. Pricing not published.
- **fal.ai** `fal-ai/sam-3/image`: $0.005 per request, latency unknown.
- **Modal self-hosting**: SAM 3 via transformers on an L4. About half a day of work, requires gated Hugging Face access, and warm-up management.
- **Local Mac: no.** Community timings put the SAM 3.1 backbone alone at about 2 s per frame on M-series chips.

## 7. Day-0 gates (must be measured by us)

| # | Gate | Pass condition | If it fails |
|---|---|---|---|
| G1 | `GET /v1/models` with our key | `sam-3.1` and `muse-spark-1.3` are listed | Region or billing problem: contact organizers in Discord #questions |
| G2 | SAM 3.1 latency, 20 frames at 768 px and 1008 px, called from the backend | p50 ≤ 1.5 s | Lower the frame rate and tune frame size; try Roboflow/fal behind the same interface |
| G3 | JPEG data URL accepted by `sam-3.1` | Request returns 200 | Send PNG (bigger payload) |
| G4 | Muse Spark 1.3 at `minimal`, one frame, short JSON reply | Measure p50/p95, no threshold | Size the "one moment" UX around the real number |
| G5 | Shutter sound on the demo iPhone (Camera app, silent switch on) | Silent | Switch frame capture to VisionCamera v5 `useFrameOutput` (dev build) |
| G6 | en-US on-device STT in airplane mode (dev build) | Transcribes with no network | Fall back to network recognition (1-minute cap), or Muse Voice Transcribe push-to-talk |
| G7 | Xcode 26.6 + SDK 58 dev build on device | App launches | Retry with `EXPO_USE_PRECOMPILED_MODULES=0`; if that fails, update macOS and install Xcode 27.1 |
| G8 | Credits visible on the dev.meta.ai dashboard | Balance shows $150 | Set a spend limit; budget assumes ≤ $40 (see [PLAN.md](PLAN.md)) |

**Results so far (2026-10-29):**
- **G7: pass.** An Expo SDK 58 dev build compiled with Xcode 27.1 on macOS 27.2 and installed on an iPhone 16e running iOS 26.6.2, using a free Personal Team. Installing needed sequential code signing; see `apps/mobile/scripts/build-ios-device.sh`.
- **G8: credits applied** (reported by the team). Meta documents no API for reading credit balance or per-request cost. Each SAM response reports `usage.images_processed: 1`, the per-image billing unit. The deduction itself shows only on the dev.meta.ai billing page.

**Meta API results, measured 2026-10-29** with our key, from the Mac to `api.meta.ai` over home Internet, using `scripts.bench --synthetic`:

| Gate | Result |
|---|---|
| G1 models | **pass**: 9 models visible, including `sam-3.1` and `muse-spark-1.3`. `GET /v1/models` took 772 ms |
| G3 JPEG data URL | **pass**: first cold call took 869 ms. Responses echo `store: false` |
| G2 SAM 3.1, 768 px | **pass**: median 569 ms, 95th percentile 1,332 ms (min 211, max 1,503; 10 calls, 0 errors) |
| G2 SAM 3.1, 1008 px | **pass**: median 357 ms, 95th percentile 712 ms (min 208, max 763; 10 calls, 0 errors) |
| G4 Muse Spark 1.3, `minimal` effort | **measured**: median 2,764 ms, 95th percentile 2,901 ms (3 calls). All replies were valid JSON and finished normally. Averages: 563 input / 258 output tokens, including 174 reasoning tokens |
| Run cost | at most $0.058 |

- **Muse Spark is much faster than the third-party figure.** At `minimal` effort it took about 2.8 s, not the 15–26 s Roboflow reported at `low` effort. It can serve planning, verification and reading behind "one moment" feedback. It is still too slow to call on every frame.
- **SAM parsing is confirmed on real output:** 11 "rectangle" boxes at confidence about 0.89 on the shapes image, and 0 false "chair" detections.
- **Sample size:** each run was only 10 calls, so the 768 px vs 1008 px difference is not significant yet. Re-measure from the phone.
- **G5 shutter sound: pass.** iPhone 16e with Silent Mode on: no shutter click during the M1 search loop, which uses `takePictureAsync({shutterSound:false})` about once per second. The VisionCamera fallback is not needed.
- **G6 on-device speech recognition: pass (en-US).** iPhone 16e, Airplane Mode on and Wi-Fi off: the diagnostics screen's English recognition test transcribed a spoken sentence (reported by the tester; the Mac cannot see logs while the phone is offline). The app sets `requiresOnDeviceRecognition: true`.

**First live run of the M1 search loop, 2026-10-29.** iPhone 16e on home Wi-Fi to the backend on the Mac, then to `sam-3.1`. Two sessions, 30 frames, 0 failures. Medians per frame from the app's `[heynavi-metrics]` log:

| Stage | Median (p50) | 95th percentile (p95) |
|---|---|---|
| Capture (`takePictureAsync`, 1280×720 preset) | 394–425 ms | 665–936 ms |
| Resize and JPEG encode (768 px) | 53–55 ms | 57–117 ms |
| Round trip, phone → backend → SAM → phone | 610–850 ms | 1,541–1,763 ms |
| SAM 3.1 inside the backend | 451–704 ms | 1,383–1,633 ms |
| **Full cycle per frame** | **1,130–1,482 ms** | **2,103–2,324 ms** |

SAM confidence on the real chair: median 0.97–0.98. A "found" needs 2 of the last 3 frames to agree, so the chair is announced about 2.5–3 s after it enters the view.

**M2 on the iPhone 16e, 2026-10-29: voice commands and the VS-1 acceptance checks.** Dev build, loudspeaker (no earbuds), home Wi-Fi. Numbers come from the app's `[heynavi-metrics]` / `[heynavi-voice]` Metro log unless marked as reported by the tester.

| VS-1 check | Result |
|---|---|
| Finds a real chair 5 times out of 5 | **pass**: 6 of 6 searches in a row reached FOUND, 4.5–11.4 s after the start (the sweep began pointed away from the chair). Every later search in the session also found it |
| 30 s with no chair in view, 0 false "found" | **pass**: one run of about 40 s (29 frames, 0 failures) never reached CONFIRMING or FOUND |
| Stage timings logged | **pass**: per-frame medians matched M1 (full cycle about 0.9–1.5 s) |
| Stop within 500 ms | **pass**: button 16, 23, 26 ms; Magic Tap 11, 29 ms; voice barge-in 4–8 ms (6 samples) |

- **What the stop latency measures:** from the stop request to iOS reporting that the speech playing at that moment has stopped (`onStopped`). A voice sample starts when the recognizer's result reaches the app, so it does not include the recognizer's own delay, which the app cannot see.
- **Re-applying the audio session category was the slow part.** Before each utterance the speaker called `setCategoryIOS` with the same category the recognizer had already set. While the recognizer ran, that synchronous call blocked the JS thread for about 500 ms, and the button stop measured 531–559 ms (4 samples). Skipping the call when the session already matches brought it to 16–26 ms. With VoiceOver on, even *reading* the category blocked for 120–240 ms twice, so the speaker now checks it once and afterwards only re-activates the session.
- **The recognizer usually hears "cancel" as "cancer":** in one round, 10 final results contained "cancer" and 5 contained "cancel", even with "cancel" in `contextualStrings`. The grammar now accepts "cancer". "Search a chair" was not understood at first; "search" is now a find verb.
- **Barge-in over the loudspeaker works.** A "stop" said while HeyNavi talks usually arrives alone in an interim result and cuts the speech at once. Sometimes it arrives glued to HeyNavi's echoed words, before them ("cancer the largest is on the left") or after them ("the largest stop"); both are now matched against what HeyNavi said. iOS sometimes starts a new transcript segment between an interim "stop" and its final; the final then looked like a "stop" said in silence and ended the search, which was fixed.
- **The mic also hears VoiceOver** reading the screen ("status ready", "page one of two"). None of it parsed as a command. The echo gate only knows HeyNavi's own speech, so spoken labels and hints must keep avoiding command words (a unit test checks them).
- **Not verified yet:** auto-lock while idle on a release build (dev builds keep the screen awake), and recovery after a phone call or Siri interruption.

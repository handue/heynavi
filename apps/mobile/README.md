# HeyNavi app (Expo / React Native, iOS)

The iPhone app. Setup, running and testing are in the [root README](../../README.md); the design is in [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

- `src/app/`: screens (Expo Router): Home, onboarding, the camera session, Settings, diagnostics
- `src/scene/`: the scene loop: Muse Spark looks, SAM 3.1 checks, scene memory, and the attention policy that decides what is said
- `src/agent/`: the announcer (priority queue for speech), the object-search state machine and its 2-of-3 confirmation, phrases
- `src/voice/`: on-device voice commands: grammar, echo gate, barge-in, stop latency
- `src/perception/`: camera capture, phone orientation (left/right relative to the user) and the rotation history that keeps SAM boxes on their objects
- `src/session/`: the camera session: SAM box overlay, caption card, control bar, decision panel, metrics upload
- `src/api/`: the backend client; `src/navigation/`: walking navigation (a possible future direction, not part of the demo)
- `src/components/`: UI, including the HeyNavi orb (`orb-shader.ts`, a Skia runtime shader)
- `src/diagnostics/`, `src/settings/`, `src/feedback/`, `src/theme/`, `src/lib/`: the diagnostics screen, stored settings, haptics, design tokens and small helpers
- `modules/heynavi-maps/`: a local Expo module (Swift) for Apple MapKit, used by `src/navigation/`
- `scripts/build-ios-device.sh`: builds and installs the app on a cabled iPhone (`--release` bundles the JavaScript)

This app needs a development build (`npm run ios:device`); Expo Go cannot run it, because it uses its own native modules. It started from the `create-expo-app` template, whose MIT notice is in [LICENSE](LICENSE).

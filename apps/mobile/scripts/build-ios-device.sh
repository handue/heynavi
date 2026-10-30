#!/usr/bin/env bash
# Build the HeyNavi dev client and install it on a connected iPhone.
#
# Why not `npx expo run:ios --device`? Expo CLI hardcodes
# COCOAPODS_PARALLEL_CODE_SIGN=true, and on this Mac the parallel codesign
# calls fail with errSecInternalComponent, leaving frameworks unsigned
# (install then fails with ApplicationVerificationFailed). Signing
# sequentially works.
#
# Usage: scripts/build-ios-device.sh [--release] [DEVICE_UDID]
#   --release  bundles the JavaScript into the app (no Metro needed: outdoors, demos) and builds
#              the Release configuration, as users get it (auto-lock, no dev menu).
# Free Apple ID profiles expire after 7 days: re-run this to re-sign.
set -euo pipefail

configuration=Debug
if [[ "${1:-}" == "--release" ]]; then
  configuration=Release
  shift
fi

export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8   # CocoaPods needs a UTF-8 locale
cd "$(dirname "$0")/.."

udid="${1:-${HEYNAVI_DEVICE_ID:-}}"
if [[ -z "$udid" ]]; then
  json="$(mktemp)"
  xcrun devicectl list devices --json-output "$json" >/dev/null
  udid="$(python3 - "$json" <<'EOF'
import json, sys
devices = json.load(open(sys.argv[1]))["result"]["devices"]
for d in devices:
    hw, conn = d.get("hardwareProperties", {}), d.get("connectionProperties", {})
    if hw.get("platform") == "iOS" and hw.get("reality") == "physical" and conn.get("pairingState") == "paired":
        print(hw["udid"]); break
EOF
)"
  rm -f "$json"
fi
[[ -n "$udid" ]] || { echo "No paired iPhone found. Connect it by cable and unlock it." >&2; exit 1; }

[[ -d ios ]] || npx expo prebuild --platform ios
[[ -d ios/Pods ]] || (cd ios && pod install)

echo "Building $configuration for device $udid ..."
xcodebuild \
  -workspace ios/HeyNavi.xcworkspace \
  -scheme HeyNavi \
  -configuration "$configuration" \
  -destination "id=$udid" \
  -allowProvisioningUpdates \
  COCOAPODS_PARALLEL_CODE_SIGN=false \
  COMPILER_INDEX_STORE_ENABLE=NO \
  build | tail -n 5

app_path="$(xcodebuild -workspace ios/HeyNavi.xcworkspace -scheme HeyNavi -configuration "$configuration" \
  -destination "id=$udid" -showBuildSettings 2>/dev/null \
  | awk -F' = ' '/ TARGET_BUILD_DIR = /{dir=$2} / WRAPPER_NAME = /{name=$2} END{print dir "/" name}')"

echo "Installing $app_path ..."
xcrun devicectl device install app --device "$udid" "$app_path"
if [[ "$configuration" == Debug ]]; then
  echo "Installed. Start Metro with: npx expo start --dev-client"
else
  echo "Installed a Release build: it runs without Metro."
fi

#!/usr/bin/env bash
# Builds the Montra iOS app for the iOS Simulator on a Mac, installs it and starts it (docs/runbooks/ios.md).
# With MONTRA_IOS_TEAM_ID it builds for a cable-connected iPhone instead (see below).
# Run it from the repository root, on the Mac:
#
#   MONTRA_API_URL=http://192.168.1.20:4040 MONTRA_WEB_URL=http://192.168.1.20:3030 scripts/ios-sim-build.sh
#
# Settings (environment):
#   MONTRA_API_URL       required: the API as the app sees it (the simulator uses the Mac's network: localhost is the Mac)
#   MONTRA_WEB_URL       the web app, for links (default http://localhost:3000)
#   MONTRA_AUTH_MODE     dev (default) or kratos
#   MONTRA_KRATOS_URL    the auth gateway; required with MONTRA_AUTH_MODE=kratos
#   IOS_SIMULATOR        simulator udid or name (default: the booted one)
#   IOS_CONFIGURATION    Release (default; the JavaScript is bundled in) or Debug (needs `expo start`)
#   IOS_DERIVED_DATA     Xcode build folder (default ~/Library/Developer/Xcode/DerivedData/montra-ios)
#   IOS_SKIP_PREBUILD=1  reuse apps/mobile/ios from the last run (only when app.config.ts and the settings are the same)
#
# For your own iPhone on a cable instead (not tried yet; docs/runbooks/ios.md "On your iPhone"):
#   MONTRA_IOS_TEAM_ID   your team's ID, with Xcode signed in to that Apple ID. Never commit it. Setting it builds for a
#                        device, signed automatically, with MONTRA_IOS_SHARE_EXTENSION and MONTRA_IOS_PUSH off unless
#                        you set them (a free Personal Team has neither App Groups nor push)
#   MONTRA_IOS_BUNDLE_ID another bundle identifier, when app.montra.mobile is taken
#   IOS_DEVICE           the iPhone's identifier (`xcrun devicectl list devices`); without it the app is only built
set -euo pipefail

: "${MONTRA_API_URL:?Set MONTRA_API_URL, for example http://192.168.1.20:4040}"
export MONTRA_API_URL
export MONTRA_WEB_URL="${MONTRA_WEB_URL:-http://localhost:3000}"
export MONTRA_AUTH_MODE="${MONTRA_AUTH_MODE:-dev}"
if [ "$MONTRA_AUTH_MODE" = kratos ]; then
  : "${MONTRA_KRATOS_URL:?MONTRA_AUTH_MODE=kratos needs MONTRA_KRATOS_URL}"
  export MONTRA_KRATOS_URL
fi
CONFIGURATION="${IOS_CONFIGURATION:-Release}"
DERIVED_DATA="${IOS_DERIVED_DATA:-$HOME/Library/Developer/Xcode/DerivedData/montra-ios}"
SIMULATOR="${IOS_SIMULATOR:-booted}"
TEAM_ID="${MONTRA_IOS_TEAM_ID:-}"
if [ -n "$TEAM_ID" ]; then
  target=device
  export MONTRA_IOS_SHARE_EXTENSION="${MONTRA_IOS_SHARE_EXTENSION:-off}"
  export MONTRA_IOS_PUSH="${MONTRA_IOS_PUSH:-off}"
else
  target=simulator
fi

[ -f pnpm-workspace.yaml ] && [ -d apps/mobile ] || { echo "Run this from the Montra repository root." >&2; exit 1; }
[ "$(uname)" = Darwin ] || { echo "iOS builds need a Mac with Xcode." >&2; exit 1; }

echo "== Montra iOS $target build: API $MONTRA_API_URL, web $MONTRA_WEB_URL, sign-in $MONTRA_AUTH_MODE${MONTRA_KRATOS_URL:+ ($MONTRA_KRATOS_URL)}"

export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
pnpm install --frozen-lockfile

cd apps/mobile
if [ "${IOS_SKIP_PREBUILD:-}" != 1 ] || [ ! -d ios ]; then
  # Generates apps/mobile/ios from app.config.ts (not committed) and runs `pod install`. The settings above are read
  # here (Info.plist) and again by Xcode's build phases (the app config the JavaScript reads), so both see them.
  EXPO_NO_GIT_STATUS=1 pnpm exec expo prebuild --platform ios --clean
fi
workspace="$(ls -d ios/*.xcworkspace 2>/dev/null | head -n 1)"
if [ -z "$workspace" ] || [ ! -d ios/Pods ]; then
  (cd ios && pod install)
  workspace="$(ls -d ios/*.xcworkspace | head -n 1)"
fi
scheme="$(basename "$workspace" .xcworkspace)"

if [ "$target" = device ]; then
  # Signed by Xcode with the team's own development certificate and profile (Xcode must be signed in to the Apple ID).
  xcodebuild \
    -workspace "$workspace" \
    -scheme "$scheme" \
    -configuration "$CONFIGURATION" \
    -sdk iphoneos \
    -destination generic/platform=iOS \
    -derivedDataPath "$DERIVED_DATA" \
    -allowProvisioningUpdates \
    CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM="$TEAM_ID" \
    build
  app="$DERIVED_DATA/Build/Products/$CONFIGURATION-iphoneos/$scheme.app"
  bundle_id="$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$app/Info.plist")"
  if [ -z "${IOS_DEVICE:-}" ]; then
    echo "== Built $app. Set IOS_DEVICE (from xcrun devicectl list devices) to install it on the iPhone."
    exit 0
  fi
  xcrun devicectl device install app --device "$IOS_DEVICE" "$app"
  xcrun devicectl device process launch --device "$IOS_DEVICE" "$bundle_id" ||
    echo "== Installed. If the iPhone won't open it, trust it: Settings > General > VPN & Device Management."
  exit 0
fi

# Signed ad hoc ("-"), not unsigned: CODE_SIGNING_ALLOWED=NO leaves the app without its Keychain entitlement, and then
# expo-secure-store fails and sign-in silently does nothing.
xcodebuild \
  -workspace "$workspace" \
  -scheme "$scheme" \
  -configuration "$CONFIGURATION" \
  -sdk iphonesimulator \
  -derivedDataPath "$DERIVED_DATA" \
  CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= \
  build

app="$DERIVED_DATA/Build/Products/$CONFIGURATION-iphonesimulator/$scheme.app"
bundle_id="$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$app/Info.plist")"

if [ "$SIMULATOR" != booted ]; then
  xcrun simctl boot "$SIMULATOR" 2>/dev/null || true # already booted is fine
fi
xcrun simctl install "$SIMULATOR" "$app"
xcrun simctl launch "$SIMULATOR" "$bundle_id"
echo "== Installed and started $bundle_id ($app)"

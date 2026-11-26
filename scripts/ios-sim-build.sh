#!/usr/bin/env bash
# Builds the Montra iOS app for the iOS Simulator on a Mac, installs it and starts it (docs/runbooks/ios.md).
# Run it from the repository root, on the Mac:
#
#   MONTRA_API_URL=http://192.168.1.20:4040 MONTRA_WEB_URL=http://192.168.1.20:3030 scripts/ios-sim-build.sh
#
# Settings (environment):
#   MONTRA_API_URL       required: the API as the simulator sees it (the Mac's own network, so localhost is the Mac)
#   MONTRA_WEB_URL       the web app, for links (default http://localhost:3000)
#   MONTRA_AUTH_MODE     dev (default) or kratos
#   MONTRA_KRATOS_URL    the auth gateway; required with MONTRA_AUTH_MODE=kratos
#   IOS_SIMULATOR        simulator udid or name (default: the booted one)
#   IOS_CONFIGURATION    Release (default; the JavaScript is bundled in) or Debug (needs `expo start`)
#   IOS_DERIVED_DATA     Xcode build folder (default ~/Library/Developer/Xcode/DerivedData/montra-ios-sim)
#   IOS_SKIP_PREBUILD=1  reuse apps/mobile/ios from the last run (only when app.config.ts and the settings are the same)
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
DERIVED_DATA="${IOS_DERIVED_DATA:-$HOME/Library/Developer/Xcode/DerivedData/montra-ios-sim}"
SIMULATOR="${IOS_SIMULATOR:-booted}"

[ -f pnpm-workspace.yaml ] && [ -d apps/mobile ] || { echo "Run this from the Montra repository root." >&2; exit 1; }
[ "$(uname)" = Darwin ] || { echo "iOS builds need a Mac with Xcode." >&2; exit 1; }

echo "== Montra iOS simulator build: API $MONTRA_API_URL, web $MONTRA_WEB_URL, sign-in $MONTRA_AUTH_MODE${MONTRA_KRATOS_URL:+ ($MONTRA_KRATOS_URL)}"

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

# iOS app on a Mac

The iOS app built on your own Mac with Xcode, without an Expo account: first in the iOS Simulator, then on your own
iPhone over a cable. Both talk to Montra on a computer on the same network. A store build goes through EAS
(`eas.json`, the Mobile workflow). For Android see [Android app for a local network](android-apk.md).

## What the Mac needs

- Xcode (tested with Xcode 27.2 on macOS 27.2) with an iOS Simulator runtime, and CocoaPods.
- Node 22 with corepack, so `pnpm` is the version in `package.json` (`COREPACK_ENABLE_DOWNLOAD_PROMPT=0` skips its
  question). Set a UTF-8 locale (`LANG=en_US.UTF-8`), or CocoaPods fails.
- About 10 GB free: the clone with `node_modules` and the Pods (2.5 GB) and Xcode's build folder (7 GB).

Expo SDK 58's iOS template already uses the UIScene life cycle that Xcode 27 asks for, so `expo-build-properties` needs
no `ios.enableSceneSupport` (that switch is for SDK 57).

## The computer it talks to

Montra running somewhere the Mac can reach: the local containers (web 3030, API 4040, see `CLAUDE.md`) or the dev
servers. The simulator uses the Mac's network, so give it the computer's address on the network, or `localhost` when
Montra runs on the Mac itself. With dev sign-in, anyone with the app on the network can sign in as anyone: use a network
you trust, with test data.

## In the Simulator

1. Clone the repository on the Mac and check out the branch to build (`develop` for the latest).
2. Start a simulator (Xcode's Simulator, or `xcrun simctl boot "iPhone 18 Pro"`).
3. From the repository root:

   ```bash
   MONTRA_API_URL=http://192.168.1.20:4040 \
   MONTRA_WEB_URL=http://192.168.1.20:3030 \
   MONTRA_AUTH_MODE=dev \
   scripts/ios-sim-build.sh
   ```

   For Kratos sign-in, set `MONTRA_AUTH_MODE=kratos` and `MONTRA_KRATOS_URL=http://192.168.1.20:4455` (the gateway)
   instead. The script runs `pnpm install`, `expo prebuild` (which writes `apps/mobile/ios` and runs `pod install`),
   a Release `xcodebuild` for the simulator, then installs and starts the app. A build takes about 8 minutes on an
   Apple silicon Mac; the header of the script lists the other settings (which simulator, the build folder).

4. Unlock the app. Its lock (PLT-07) is on whenever the phone has a passcode, and a simulator says it has one, so it
   asks for the "iPhone passcode" at once. Cancel that, turn on Face ID for the simulator (the simulator app's Face ID
   menu: **Enrolled**), tap **Unlock** and choose **Matching Face**. From a terminal, the same is
   `xcrun simctl spawn booted notifyutil -s com.apple.BiometricKit.enrollmentChanged 1`, then
   `xcrun simctl spawn booted notifyutil -p com.apple.BiometricKit.enrollmentChanged`, and after the prompt
   `xcrun simctl spawn booted notifyutil -p com.apple.BiometricKit_Sim.pearl.match` (not tried yet: Face ID
   enrollment is shared by every app on that simulator). Settings → "Require Face ID / fingerprint" turns the lock off.
5. Sign in. Dev sign-in takes any email; use a test account.

To build again, for a new `develop` or another address, pull and run the script again. The addresses are baked into the
app at build time, so a new address needs a new build.

Things to know:

- **Signed ad hoc, not unsigned.** The script signs with `CODE_SIGN_IDENTITY=-`. Building with
  `CODE_SIGNING_ALLOWED=NO` gives an app without its Keychain entitlement: `expo-secure-store` then fails and sign-in
  silently does nothing.
- **Why `http://` works.** iOS App Transport Security refuses plain http, and its local-networking exception doesn't
  cover an IP address. `app.config.ts` allows http (`NSAllowsArbitraryLoads`) and adds the local-network question
  only when `MONTRA_API_URL` starts with `http://`, so an `https://` build is unchanged (`test/app-config.test.ts`).
- **Typing in the simulator** works from the Mac's keyboard. Scripts can only open links and take screenshots
  (`xcrun simctl openurl booted montra://…`, `xcrun simctl io booted screenshot shot.png`).
- **Did it reach the API?** The API doesn't log requests; the simulator does:
  `xcrun simctl spawn booted log show --last 5m --predicate 'process == "Montra"' | grep 4040` shows the first call,
  `GET /v1/app/requirements`, and its status.
- `apps/mobile/ios` is generated and not committed; `--clean` remakes it on every run.

## On your iPhone, with a free Apple account

Not tried yet. A free Apple ID gives a "Personal Team": enough to put the app on your own iPhone over a cable, with
these limits:

- **The app stops opening after 7 days.** Build and install again to renew it.
- **At most 3 apps** from a Personal Team on the phone at once, and a few new app IDs a week.
- **No App Groups and no push.** The share extension (sharing a statement file into Montra) needs an App Group, and
  push needs a paid team. A device build leaves both out (`MONTRA_IOS_SHARE_EXTENSION=off`, `MONTRA_IOS_PUSH=off`)
  unless you set them. Push needs an EAS project anyway, so nothing else is lost.
- **The bundle ID must be free.** If Xcode says `app.montra.mobile` isn't available, build with
  `MONTRA_IOS_BUNDLE_ID` set to one of your own, for example `com.<yourname>.montra`.

What you do by hand, once:

1. In Xcode, Settings → Accounts, sign in with your Apple ID. Your Personal Team appears. Its Team ID is in
   `defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier` (or the Keychain's "Apple Development"
   certificate). It isn't secret, but keep it out of the repository: pass it in the environment.
2. Connect the iPhone with a cable, unlock it and tap **Trust This Computer**.
3. On the iPhone, turn on Settings → Privacy & Security → **Developer Mode**, and restart when asked.
4. Build, install and start it. The same script builds for a device when it's given your Team ID:

   ```bash
   xcrun devicectl list devices          # the iPhone's identifier
   MONTRA_API_URL=http://192.168.1.20:4040 MONTRA_WEB_URL=http://192.168.1.20:3030 \
   MONTRA_IOS_TEAM_ID=<your Team ID> IOS_DEVICE=<the identifier> \
   scripts/ios-sim-build.sh
   ```

   Add `MONTRA_IOS_BUNDLE_ID=com.<yourname>.montra` if the bundle ID is taken. If the command line can't sign, open
   `apps/mobile/ios/Montra.xcworkspace` in Xcode, pick your team under Signing & Capabilities with "Automatically
   manage signing", choose the iPhone and Run.
5. The first time, the iPhone refuses to open it: Settings → General → VPN & Device Management → your Apple ID →
   **Trust**.
6. When the app asks to find devices on your local network, allow it, or it can't reach the computer. Windows Firewall
   on that computer must let the API's port in.

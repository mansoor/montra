# Android app for a local network

A standalone APK that talks to the API on a computer on the same network, built on GitHub without an Expo account. It's
signed with Android's debug key: fine to install on your own phone, never for a store or other people. A store build goes
through EAS (`eas.json`, the Mobile workflow).

## Build it

1. Make a branch under `android-apk/` from `develop`, for example `android-apk/lan`.
2. Add `.github/android-apk.env` on that branch only. Use the computer's address on the network, not `localhost`:

   ```
   MONTRA_API_URL=http://192.168.1.20:4000
   MONTRA_WEB_URL=http://192.168.1.20:3000
   MONTRA_AUTH_MODE=dev
   ```

   For real sign-in against the Docker app (`MONTRA_AUTH_MODE=kratos` there), use `MONTRA_AUTH_MODE=kratos` and add
   the auth gateway: `MONTRA_KRATOS_URL=http://192.168.1.20:4455`.

3. Push the branch. The "Android APK" workflow builds for about 20 minutes and attaches `montra-android-<commit>` to
   the run. Download it, unzip it, and copy the `.apk` to the phone.
4. On the phone, allow installing from that source when asked, and install it.

To build again, for a new `develop` or another address, merge `develop` into the branch or change the file, and push.

## Publish it as a release

Add `MONTRA_PUBLISH_RELEASE=true` to `.github/android-apk.env` and each build also publishes the APK as the repository's
**latest** GitHub release, which is where the app's "Get the update" button points (`MOBILE_UPDATE_URL`, OPS-04). The
release is named `android-<branch>-<app version>-dev.N` after the `develop` tag the branch was built from, and its notes
give the APK's SHA-256 and the PRs merged since the last release. The repository is public, so so is the release: turn
this on only for one branch at a time, and only for a build that's fine for anyone to download.

## The computer it talks to

- **The API must listen on the network,** not only on `localhost`. The local servers do.
- **Windows Firewall must allow port 4000** in on the private network. Ports 3000 for links to the web app.
- **Dev sign-in accepts any email,** so anyone on the network who has the app can sign in as anyone. Use it on a network
  you trust, with test data.

## Why `http://` works

Android refuses plain `http://` unless the app allows it. `app.config.ts` allows it only when `MONTRA_API_URL` starts
with `http://`, so a build pointed at an `https://` address is unchanged.

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

3. Push the branch. The "Android APK" workflow builds for about 20 minutes and attaches `montra-android-<commit>` to
   the run. Download it, unzip it, and copy the `.apk` to the phone.
4. On the phone, allow installing from that source when asked, and install it.

To build again, for a new `develop` or another address, merge `develop` into the branch or change the file, and push.

## The computer it talks to

- **The API must listen on the network,** not only on `localhost`. The local servers do.
- **Windows Firewall must allow port 4000** in on the private network. Ports 3000 for links to the web app.
- **Dev sign-in accepts any email,** so anyone on the network who has the app can sign in as anyone. Use it on a network
  you trust, with test data.

## Why `http://` works

Android refuses plain `http://` unless the app allows it. `app.config.ts` allows it only when `MONTRA_API_URL` starts
with `http://`, so a build pointed at an `https://` address is unchanged.

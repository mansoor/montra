# ADR-0009: React Native with Expo for iOS and Android

- Status: accepted (2026-11-03: Expo confirmed; camera library `expo-camera`, see the amendment below)
- Date: 2026-10-30

## Context
PLT-02/03 require parity on iOS 17+ and Android 11+ with one small team; TXN-08 requires
camera capture with edge detection and blur/glare checks.

## Decision
Expo (dev client, config plugins, EAS) with `react-native-vision-camera` and native
document scanners via a small module. Shares `domain`, `schemas`, `api-client`, `i18n`.

## Consequences
One codebase. Native work is limited to the scanner module and widgets.

## Amendment (2026-11-03, Phase 5): `expo-camera` for receipt capture
The product owner chose `expo-camera` for Phase 5, before the on-device spike results
(`docs/design/spikes/phase4-camera.md`).

- **What it covers.** It builds with the current Expo SDK without extra native setup, and the spike
  harness already uses it.
- **Capture.** Receipt capture (`apps/mobile/app/receipt-capture.tsx`) takes full-resolution stills.
  After each shot it checks sharpness (variance of the Laplacian) and glare on a 256-px copy, using
  `features/camera-metrics.ts`, and offers a retake.
- **What it lacks.** There is no live edge detection, because that needs frame processors
  (`react-native-vision-camera` plus ML Kit or VisionKit). TXN-08's "auto edge detection" stays
  open.
- **Revisiting.** Revisit if the spike's go/no-go criteria fail on a reference device, or when edge
  detection becomes a priority. The capture screen is one file, and the rest of the pipeline (offline
  queue, upload, extraction) doesn't depend on the camera library.

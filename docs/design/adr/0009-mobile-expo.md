# ADR-0009: React Native with Expo for iOS and Android

- Status: proposed (confirmed after the Phase 4 camera/OCR spike)
- Date: 2026-10-30

## Context
PLT-02/03 require parity on iOS 17+ and Android 11+ with one small team; TXN-08 requires
camera capture with edge detection and blur/glare checks.

## Decision
Expo (dev client, config plugins, EAS) with `react-native-vision-camera` and native
document scanners via a small module. Shares `domain`, `schemas`, `api-client`, `i18n`.

## Consequences
One codebase. Native work is limited to the scanner module and widgets.

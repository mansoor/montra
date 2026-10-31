# Phase 4 spike: camera capture on Expo (go/no-go for ADR-0009)

- Status: **ready to run on devices; not yet run.** ADR-0009 stays *proposed* until the results table below is
  filled in.
- Question (requirements §14.3): Is React Native with Expo fast and good enough for receipt and statement capture
  (TXN-08), or do we need native screens?
- Harness: Settings → Developer: camera spike in the mobile app (`apps/mobile/app/developer/camera.tsx`). It uses
  `expo-camera` with metrics in `src/features/camera-metrics.ts`.

## What the harness measures

| Metric | How | Target |
| --- | --- | --- |
| Capture → preview latency | Shutter press to the captured image rendering on screen (`Image.onLoad`) | p95 < 1.5 s |
| Sharpness | Variance of the 4-neighbour Laplacian on a 256-px grayscale copy | ≥ 100 on ≥ 90% of frames |
| Glare | Share of pixels with luma ≥ 250 | ≤ 5% |
| Usable | Operator judgement per capture (button) | ≥ 95% usable |

The thresholds (100, 5%) are starting values. Tune them from the first device runs, and record any change here.

## Protocol

1. Install a **preview** EAS build (release mode, Hermes) — not a dev build, so the timings are representative.
2. Run it on three devices:
   - iPhone 12 or newer (iOS 17+);
   - Pixel 6 or newer (Android 14+);
   - a low-end Android 11 device (for example a Galaxy A12 or Moto G10).
3. On each device, capture 30 receipts:
   - 10 short ones (under 15 cm);
   - 10 long ones (over 30 cm, which need multi-shot later);
   - 10 crumpled or thermal-faded ones.
4. Then capture 10 statement pages under office light and 5 near a window (glare).
5. Mark each capture *usable* or *not usable*.
6. Export the JSON with *Share results*, attach it to the spike PR, and fill in the table below.

## Pass criteria (go)

- p95 latency under 1.5 s on the iPhone and the Pixel, and under 2.5 s on the low-end device.
- At least 90% of frames sharp, and at least 95% judged usable, across all devices.
- No crashes or out-of-memory failures in 45 captures per device.

If the low-end device fails on latency only, it's still a **go**, with downscaled capture as a follow-up. If the
iPhone or Pixel fails, evaluate `react-native-vision-camera` with a frame processor, and the platform document
scanners (VisionKit / ML Kit) through a small native module, before deciding (08 §3).

## Results

| Device | OS | Samples | p50 ms | p95 ms | Sharp % | Usable % | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | |
| | | | | | | | |
| | | | | | | | |

Decision: _pending_ (go / no-go, date, decided by).

## Notes

- `expo-camera` was chosen for the harness because it builds with the current Expo SDK without extra native
  configuration. `react-native-vision-camera` (frame processors, real-time edge detection) is the planned
  production path for TXN-08 in Phase 5, if the spike shows it's needed.
- Paper statements scanned in the import flow are combined into a PDF on the device (`expo-print`). The server
  reads them with OCR (ADR-0012 §9).

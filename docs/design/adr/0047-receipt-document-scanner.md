# ADR-0047: The phone's document scanner for receipts

- Status: accepted (refines ADR-0009 for receipts)
- Date: 2026-11-13

## Context

ADR-0009 chose `expo-camera` for receipt capture, knowing it has no live edge detection. In use, a receipt photo
keeps the table around it, often at an angle. The owner asked for scans cropped to just the receipt.

Both phone platforms ship a document scanner that does this well: Google's ML Kit document scanner on Android (part of
Google Play services) and Apple's VisionKit on iPhone. Each finds the document's edges as you aim, crops and
straightens it, takes several pages, and lets the person retake one. Building that ourselves would need
vision-camera frame processors and an edge model.

## Decision

- **Receipt capture opens the platform scanner** through `react-native-document-scanner-plugin` 2.0.4 (a TurboModule;
  an Expo config plugin sets the iOS camera text). Up to 10 pages, JPEG quality 85.
- **Its pages go into the same upload queue** as before (`keepPages`, `receipts.enqueue`), so offline capture and
  upload are unchanged. They skip the app's own blur and glare check, since the scanner has its own and lets the
  person retake.
- **The app's camera stays as the fallback:**
  - automatically where the scanner can't run (Expo Go, a build without the module, an Android phone without Google
    Play services), with a note saying why;
  - or when chosen ("Use the camera instead"), keeping the blur and glare check.

  Picking a photo or PDF is unchanged.
- **The module loads lazily** (`src/features/scanner.ts`), so a missing native module is a fallback, not a crash.

## Consequences

- Scanned receipts arrive cropped and straightened, which also helps OCR and the AI read them.
- The scanner's interface is the platform's own, not Montra's.
- A new native dependency. The phone needs a new build (the APK workflow runs `expo prebuild`), and Android needs
  Google Play services for the scanner (it downloads the ML Kit module on first use).

## Alternatives considered

- **Cropping after the photo** by finding the paper against the background: no straightening, and it fails on a light
  table.
- **Corner handles to adjust by hand:** the most control, but an extra step on every receipt.
- **vision-camera with a frame processor and an edge model:** the most work, to rebuild what both platforms provide.

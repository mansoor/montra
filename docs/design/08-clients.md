# 08 — Web and Mobile Clients

## 1. Shared foundations

- `packages/domain` handles money math and formatting, dates and budget math. Clients
  compute nothing on their own.
- `packages/schemas` + `packages/api-client` provide the typed API. TanStack Query
  handles caching on both platforms, with query keys derived from resource and filter
  objects so `changes` events invalidate precisely.
- `packages/i18n` holds ICU messages (English at launch, TZ-06), the `Intl`-based
  money/date formatters with user overrides, and accounting-style negatives in ledger
  views (CUR-10).
- `packages/ui` holds design tokens (color, spacing, type scale). It is consumed by
  Tailwind on web and by a RN style layer on mobile, with light/dark themes and colors
  checked for contrast.

## 2. Web (Next.js App Router)

| Area | Routes | Notes |
| --- | --- | --- |
| Onboarding | `/welcome`, `/setup/*` | Template choice (household / freelancer / landlord / hybrid), entities, accounts, first import → AI category proposals (UP-03). Target: first dashboard within 10 min (NFR-11). |
| Home | `/` | FLOW-01 cards, upcoming bills, net-worth sparkline, review-queue count, recommendations. Filters by entity and member (FAM-09). |
| Transactions | `/transactions`, `/transactions/[id]` | Virtualized table (TanStack Table + react-virtual) for 50k rows, inline edit, multi-select bulk edit, a quick-add bar with the NL parser, and a split editor. |
| Review | `/review` | Keyboard-first: `j/k` move, `a` accept, `c` category picker, `e` entity, `m` member, `s` split, `shift+a` accept all ≥ threshold (AI-04, PLT-10). |
| Import | `/import`, `/import/[batchId]` | Drag-and-drop multi-file, mapping wizard, preview grid with duplicate and error states, summary with balance check, undo. |
| Receipts | `/receipts` (inbox), `/receipts/[id]` | Image beside the extracted lines, editable lines, gap indicator, match candidates. |
| Accounts | `/accounts`, `/accounts/[id]` | Register (ledger/simple toggle, DE-06), reconcile mode, journal drawer (DE-07). |
| Budget | `/budget/[entity]/[period]` | Left to assign / over-assigned banner, groups, inline assign, moves, pace bars, goals and sinking funds. |
| Flow | `/flow`, `/forecast`, `/calendar` | ECharts Sankey with clickable nodes → filtered transactions; forecast chart with low-balance markers; a table alternative for every chart (NFR-10). |
| Business | `/business/[id]/…` | P&L, invoices, bills, mileage, tax estimate, customers/vendors. |
| Rentals | `/rentals/…` | Portfolio, property, units, leases, rent roll, arrears, maintenance, Schedule E. |
| Members | `/members/…` | Family members, payslips, per-member reports. |
| Reports | `/reports/[type]` | Filters bar (RPT-02), save, export, drill-down. |
| Settings | `/settings/*` | Covers everything in OPS-13. |

- **BFF**: Next.js route handlers proxy `/api/*` to the API and hold the session in an
  HttpOnly, SameSite=Lax cookie. A CSRF double-submit token protects mutations.
- Rendering: dashboard and reports are server components with streaming; interactive
  grids are client components.
- Accessibility: WCAG 2.2 AA. Radix primitives via shadcn/ui, visible focus, every
  workflow reachable by keyboard, `aria-live` for import progress, chart table
  alternatives, and axe checks in Playwright CI.
- Responsive from 360 px to 4K (PLT-01): grids collapse to card lists below 768 px.

## 3. Mobile (Expo / React Native)

| Tab | Content |
| --- | --- |
| Home | Left to spend, upcoming bills, review count, alerts |
| Transactions | List, search, swipe actions, detail with splits |
| Capture (centre button) | Camera receipt capture, quick add (3 taps: amount → payee → confirm with AI-suggested category, TXN-01), voice later (TXN-07) |
| Budget | Period view, assign, move money |
| More | Accounts, import, rentals (log rent), business, members, reports, settings |

- **Review**: a swipe card stack (right = accept, left = edit) (AI-04).
- **Camera** (TXN-08): `react-native-vision-camera` with a frame processor for edge
  detection (ML Kit document scanner on Android, VisionKit `VNDocumentCamera` on iOS
  through a small native module), blur score (variance of Laplacian) and glare check, and
  a multi-shot mode for long receipts. Phase 4 starts with a **spike** to confirm Expo is
  fast enough (open question §14.3).
- **Import on mobile** (IMP-02, PLT-04): a share-sheet and "Open in" extension
  (`expo-share-intent`), a document picker, and camera scanning of paper statements
  (multi-page → PDF).
- **Offline** (PLT-05, TXN-09): encrypted expo-sqlite store fed by `/sync/changes`, a
  mutation outbox, and an image upload queue (background upload where the OS allows).
  Conflicts surface as a toast and in an activity view.
- **Security**: biometric unlock (`expo-local-authentication`), an app-lock timeout,
  the token in SecureStore, a screenshot-blur overlay in the app switcher, and data
  wiped on sign-out (PLT-07, BAK-10).
- **Push**: Expo Push → APNs/FCM; tokens stored per device; notification categories
  map to NOT-01 types.
- **Widgets** (PLT-08, S): iOS WidgetKit and Android Glance through `expo-widgets` /
  a config plugin; data from an app-group cache.
- **Releases**: EAS Build + EAS Submit, OTA updates (EAS Update) for JS-only fixes, and
  a minimum supported version check (OPS-04).
- Targets: iOS 17+, Android 11+ (API 30+).

## 4. Parity matrix (PLT-03)

Every R1 function is available on mobile. These are simplified there: creating a new
CSV column mapping (a guided step-by-step version), the custom report builder (choose
from saved reports and simple filters), manual journal entries (form only), and bulk
edit (multi-select up to 200 rows).

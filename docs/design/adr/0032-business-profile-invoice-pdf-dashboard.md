# ADR-0032: A business's logo and domain, invoice PDFs in any script, and the business landing page

- Status: accepted
- Date: 2026-11-10

## Context

A business (BIZ-01) had a name, legal name, address and email, and its invoices (BIZ-05) printed those in the standard
PDF fonts, which cover Latin text only: anything else printed as "?" (ADR-0017). Owners asked for their logo and
website on invoices, for customer names in other scripts to print, for the PDF on the phone, and for a business page
that reads like the personal Home (`GET /dashboard/charts` and its period dropdown): money in and out, revenue,
expenses and profit over 3, 6, 12 or 24 months, as charts and as a table.

## Decision

### Logo and domain

- **The logo is a file like a receipt.** `PUT /businesses/:entityId/logo` takes one multipart image, stored through
  `StoragePort` under its own file kind `logo` (migration 0030). It's checked by its content, never its name or
  declared type: a PNG or JPEG whose header parses, at most 1 MB and 4096 pixels a side. WebP, GIF and SVG are refused:
  `pdf-lib` can't draw the first two, and an SVG is a document that can carry scripts.
- **One logo per business.** `business_profile.logo_file_id` points at it. A new upload replaces it, and the old file is
  marked deleted (logos aren't paperwork, so they don't get the seven-year retention). `DELETE …/logo` removes it.
  `GET …/logo` serves it with its stored type, `nosniff` and a private cache; the file id in the profile changes with
  each upload, so clients add it to the URL to refresh.
- **The domain is a bare host name.** People paste `https://www.example.com/about` or `sales@example.com`;
  `normalizeDomain` in `@montra/schemas` turns those into `www.example.com` and `example.com`, and refuses what isn't a
  domain. It's pure (no `URL`, which Hermes lacks in full), so web and phone check it the same way before saving.
  Letters of any script are kept as typed.
- **Where they show:** business settings on web and phone, the invoice page on the web, and the PDF's header.

### Invoice PDF in any script

- **A chain of embedded fonts.** Each run of text takes the first font that has its characters: Noto Sans (Latin,
  Greek, Cyrillic, Vietnamese and Devanagari), then Arabic, Hebrew, Thai and Simplified Chinese (which also covers
  Japanese kana). A character none of them has still prints as "?" rather than failing the send.
- **Subset with HarfBuzz, not pdf-lib.** pdf-lib's own subsetter (`subset: true`) drops most glyphs of these fonts:
  a PDF it made showed "ve S d o" for "Rivera Studio". So each font is cut down with HarfBuzz (`subset-font`, layout
  tables kept) to the document's characters, and the small result is embedded whole. A Latin invoice carries about
  30 KB of fonts; one with Chinese, about 100 KB.
- **Laid out with fontkit, drawn by position.** Arabic joins and Indic conjuncts come from fontkit's OpenType layout.
  pdf-lib draws a string by the plain widths of its glyphs and only lists widths for glyphs the character map
  reaches, so substituted glyphs (joining forms, half forms) took a whole em and fell apart. Each run is drawn instead
  as a `TJ` array that puts every glyph where the layout put it; Latin keeps its kerning too. Checked by rendering
  with MuPDF and pdf.js.
- **Directions.** A run in a right-to-left script is laid out right to left; a line that mixes directions keeps its
  runs in reading order, which is right for names and short notes but isn't the full Unicode bidi algorithm.
- **Fonts come from npm** (`@expo-google-fonts/noto-sans*`, OFL-1.1), resolved from `node_modules` at first use and
  cached for the process. The Chinese font is the large one (about 10 MB a weight; the package holds nine).
- The invoice PDF that was sent stays as it was sent (ADR-0017); only new renders use the fonts and the logo.

### The PDF on the phone

- The invoice list on the phone opens an invoice; its PDF downloads with the file system (the token in the header,
  like backups) into the cache and opens the share sheet through `expo-sharing`, from which it can be saved, printed,
  mailed or opened.

### The business landing page

- **One endpoint:** `GET /businesses/:entityId/dashboard?months=3|6|12|24&month=YYYY-MM-01`. The month is the
  dropdown's choice (this month by default); tiles show it, and the charts and the table show the N months ending with
  it. The dropdown offers this month back to the business's first activity, 60 at most.
- **Revenue and expenses are the P&L's.** The monthly P&L query is shared by `reports/pnl` and the dashboard, so a
  month on the dashboard matches the P&L for that month to the cent. Profit is revenue less expenses; the margin is
  `marginBps` from `@montra/domain`, and the totals over the period come from `summarizeBusinessMonths`.
- **Money in and out is cash through the business's own accounts:** its checking, savings, cash, card and credit line
  accounts. Per journal entry the movement on those accounts is netted, so a transfer between two of them (or paying
  the business card from its checking) is neither in nor out. A card purchase is money out when it's made.
- **Cash on hand** is the business's checking, savings and cash balances at each month's end (today for this month).
- **Open invoices and bills** are as of today, with how many are overdue, whatever month is chosen.
- The old overview's P&L table, customers and vendors stay, under the new charts and table.

## Consequences

- Invoices print the logo, the domain and names in most of the world's scripts. Mixed-direction lines can read oddly;
  Korean, Tamil, Bengali and other scripts beyond the list still print "?" until a font is added to the chain.
- The API install grows by about 110 MB of font packages, mostly the Chinese one; the image keeps only the weights it
  uses (about 25 MB).
- The phone app gains `expo-sharing`, a native module: the next APK must be rebuilt (it is on each push to
  `android-apk/lan`).
- The dashboard and the P&L can't drift apart: they run the same query.

## Alternatives considered

- **Only Noto Sans (Latin, Greek, Cyrillic):** small, but leaves Arabic, Hebrew, Hindi, Thai and Chinese names as "?".
- **Rendering the PDF in a headless browser:** full shaping and bidi for free, but a browser in the API image and a
  much slower render.
- **Fonts committed to the repository:** no install cost at run time, but tens of megabytes of binaries in git.
- **Logos as any image, converted on the server:** needs an image library with a history of parser bugs; owners can
  export a PNG.
- **Computing the dashboard on the client from `reports/pnl`:** the phone would need several calls per month and money
  in and out isn't in any existing report.

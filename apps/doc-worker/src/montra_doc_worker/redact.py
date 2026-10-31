"""Redaction of OCR'd statement text before it leaves our infrastructure (AIA-03, ADR-0012 §9).

The text goes to the AI gateway's `extract_statement_table` task, so anything that identifies the account
holder is masked first:

- digit runs of 6 or more that are not money amounts or dates (account, card and routing numbers),
  including spaced or dashed groups such as ``1234 5678 9012 3456``;
- email addresses and phone numbers;
- in the header block of the first page (before the first transaction line): postal-address lines and the
  personal-name line next to them, and any line with a title such as "Mr" or "Ms". The same lines are
  masked when they repeat on later pages (running page headers).

Transaction lines keep their date, description and amounts; only identifiers inside them are masked.
"""

from __future__ import annotations

import re
from datetime import date

MASK = "••••"
REDACTED = "[redacted]"

EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
# (555) 123-4567 · 555-123-4567 · 555.123.4567 · +1 555 123 4567 · 1-800-555-0199 · +44 20 7946 0958
PHONE_RE = re.compile(
    r"(?<![\w/.,-])(?:\+\d{1,3}[\s.-]?)?(?:1[\s.-])?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?![\w/.,-]*\d)"
    r"|(?<![\w/.,-])\+\d{2}\s\d{2,4}\s\d{3,4}\s\d{3,4}(?![\w/.,-]*\d)"
)
# Contiguous digits, possibly in space- or dash-separated groups of 3-4 (card and IBAN styles).
DIGITS_RE = re.compile(r"(?<![\d.,])(?<!\d[-/])\d+(?:[ -]\d{3,4}(?![\d.,]\d))*(?![\d]|[.,]\d)")
DATE_LIKE_RE = re.compile(
    r"^(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2}-\d{2,4}|\d{8})$",
)

_STREET_WORDS = (
    r"street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way|place|pl|terrace|ter|"
    r"circle|cir|parkway|pkwy|highway|hwy|square|sq|crescent|close|suite|ste|apt|apartment|unit|floor|fl"
)
STREET_RE = re.compile(rf"\b\d{{1,6}}[A-Z]?\s+(?:[A-Za-z0-9.'#-]+\s+){{0,5}}(?:{_STREET_WORDS})\b\.?", re.I)
# Hauptstraße 5 · Lindenweg 12a · Rue de Rivoli 10 · Via Roma 3
EU_STREET_RE = re.compile(
    r"\b[A-ZÄÖÜ][\wäöüß-]*(?:straße|strasse|str\.|weg|platz|gasse|allee|ring|damm|laan|straat|gade|vej)\s+\d{1,4}[a-z]?\b"
    r"|\b(?:rue|avenue|boulevard|via|viale|calle|avenida|rua)\s+[\w' -]{2,40}?\d{1,4}\b",
    re.I,
)
PO_BOX_RE = re.compile(r"\bP\.?\s?O\.?\s+Box\s+\d+", re.I)
US_CITY_ZIP_RE = re.compile(r"\b[A-Za-z .'-]+,?\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?\b")
UK_POSTCODE_RE = re.compile(r"\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b")
CA_POSTCODE_RE = re.compile(r"\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b")
EU_POSTCODE_CITY_RE = re.compile(
    r"^\s*(?:[A-Z]{1,2}-)?\d{4,5}\s+[A-ZÄÖÜ][a-zäöüß]+(?:[\s-][A-Za-zäöüß]+)*\s*$"
)
TITLE_RE = re.compile(r"^\s*(?:mr|mrs|ms|miss|mx|dr)\.?\s+[A-Za-z]", re.I)
NAME_RE = re.compile(r"^\s*[A-Za-z][A-Za-z.'-]*(?:\s+(?:&\s+)?[A-Za-z][A-Za-z.'-]*){1,4}\s*$")
NOT_A_NAME = re.compile(
    r"(?:bank|kasse)\b|\b(statement|account|acct|period|balance|page|summary|checking|savings|card|credit|debit|"
    r"member|fdic|customer|service|date|description|amount|total|transactions?|deposits?|withdrawals?|"
    r"activity|online|www|com|visa|mastercard|amex|federal|union|trust|financial|branch|of|to|from)\b",
    re.I,
)
TXN_START_RE = re.compile(
    r"^\s*(?:\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?|\d{4}-\d{2}-\d{2}|"
    r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|"
    r"\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b)",
    re.I,
)


def redact_pages(pages: list[str]) -> list[str]:
    """Redacts every page; header-block rules use the first page and carry over to repeated lines."""
    if not pages:
        return []
    first_lines = pages[0].splitlines()
    sensitive = _sensitive_header_lines(first_lines)
    sensitive_texts = {_norm(first_lines[i]) for i in sensitive if _norm(first_lines[i])}
    out: list[str] = []
    for page_no, page in enumerate(pages):
        lines = page.splitlines()
        redacted: list[str] = []
        for i, line in enumerate(lines):
            if (page_no == 0 and i in sensitive) or (page_no > 0 and _norm(line) in sensitive_texts):
                redacted.append(REDACTED)
            else:
                redacted.append(redact_line(line))
        out.append("\n".join(redacted))
    return out


def redact_line(line: str) -> str:
    line = EMAIL_RE.sub(REDACTED, line)
    line = PHONE_RE.sub(REDACTED, line)
    return DIGITS_RE.sub(_mask_digits, line)


def _mask_digits(m: re.Match[str]) -> str:
    token = m.group(0)
    digits = re.sub(r"\D", "", token)
    if len(digits) < 6 or _is_date(token):
        return token
    return MASK


def _is_date(token: str) -> bool:
    if not DATE_LIKE_RE.match(token):
        return False
    if re.fullmatch(r"\d{8}", token):  # YYYYMMDD
        try:
            date(int(token[:4]), int(token[4:6]), int(token[6:]))
        except ValueError:
            return False
        return token[:2] in ("19", "20")
    return True


def _sensitive_header_lines(lines: list[str]) -> set[int]:
    """Indexes of address and name lines in the header block (before the first transaction line)."""
    end = next((i for i, line in enumerate(lines) if TXN_START_RE.match(line)), len(lines))
    address = {i for i in range(end) if _is_address(lines[i])}
    titles = {i for i in range(end) if TITLE_RE.match(lines[i])}
    hits = address | titles
    # The name sits just above the address block ("JANE Q DOE / 12 Elm St / Springfield, IL 62704"):
    # up to two name lines (joint holders) above each run of address lines; title lines are already in.
    for i in sorted(address):
        if i - 1 in address:
            continue
        j, names = i - 1, 0
        while j >= 0 and names < 2 and (j in titles or _is_name(lines[j])):
            if j not in titles:
                hits.add(j)
                names += 1
            j -= 1
    return hits


def _is_address(line: str) -> bool:
    text = line.strip()
    if not text:
        return False
    return bool(
        STREET_RE.search(text)
        or EU_STREET_RE.search(text)
        or PO_BOX_RE.search(text)
        or US_CITY_ZIP_RE.search(text)
        or UK_POSTCODE_RE.search(text)
        or CA_POSTCODE_RE.search(text)
        or EU_POSTCODE_CITY_RE.match(text)
    )


def _is_name(line: str) -> bool:
    text = line.strip()
    return bool(text) and bool(NAME_RE.match(text)) and not NOT_A_NAME.search(text)


def _norm(line: str) -> str:
    return " ".join(line.lower().split())

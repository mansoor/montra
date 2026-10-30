"""Digital PDF bank/card statements → one grid of transaction rows plus statement facts (IMP-05).

Strategy:
1. Scanned PDFs (no text layer) go to OCR (`ocr.py`), which returns redacted text instead of a grid.
2. Ruled tables: pdfplumber's line-based `extract_tables` on every page.
3. Otherwise rebuild the table from word positions: find the header line (Date / Description / Amount …),
   use its words as column anchors, assign each word on later lines to the nearest column.
4. Rows start with a date. A following line with no date and no amount continues the previous row's
   description. Header lines repeated on later pages, page footers and any line repeated on several pages
   are dropped. Balance lines ("Beginning balance", "Ending balance") feed `statement`, not the grid.

Cells keep the exact text printed on the statement; parsing numbers and dates is the importer's job.
"""

from __future__ import annotations

import io
import re
from collections import Counter
from dataclasses import dataclass
from datetime import date
from typing import Any

import pdfplumber

from .errors import PermanentJobError
from .ocr import ocr_pdf
from .result import GridResult, OcrTextResult, Statement

MIN_CHARS_PER_PAGE = 20
_MAX_PAGES = 500

HEADER_WORDS = {
    "date", "posted", "posting", "transaction", "trans", "description", "details", "payee", "memo",
    "amount", "debit", "debits", "credit", "credits", "withdrawals", "withdrawal", "deposits", "deposit",
    "balance", "reference", "ref", "type", "value",
}  # fmt: skip
AMOUNT_RE = re.compile(
    r"^\(?[-−+]?[$€£¥]?\s?\d{1,3}(?:[,.\s]?\d{3})*(?:[.,]\d{2})\)?(?:-|\s?CR|\s?DR)?$", re.I
)
DATE_RES = [
    re.compile(r"^\d{1,2}/\d{1,2}(?:/\d{2,4})?$"),
    re.compile(r"^\d{4}-\d{2}-\d{2}$"),
    re.compile(r"^\d{1,2}\.\d{1,2}\.\d{2,4}$"),
    re.compile(r"^\d{1,2}-\d{1,2}-\d{2,4}$"),
]
AMOUNT_HEADERS = {"amount", "debit", "debits", "credit", "credits", "withdrawals", "deposits", "balance"}
MONTHS = {m: i + 1 for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
)}  # fmt: skip
MONTH_WORD_RE = re.compile(r"^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?$", re.I)
FOOTER_RE = re.compile(r"^(page\s+\d+(\s+of\s+\d+)?|\d+\s*/\s*\d+|continued.*)$", re.I)
OPENING_RE = re.compile(r"\b(beginning|opening|previous|starting)\s+balance\b", re.I)
CLOSING_RE = re.compile(r"\b(ending|closing|new)\s+balance\b", re.I)
MONEY_IN_TEXT_RE = re.compile(r"\(?[-−]?[$€£]?\s?\d{1,3}(?:,\d{3})*\.\d{2}\)?|\(?[-−]?[$€£]?\s?\d+\.\d{2}\)?")
LAST4_RE = re.compile(
    r"\b(?:account|acct|card)\b[^\n]{0,40}?(?:ending(?:\s+in)?|number|no\.?|#|[x*•]{2,})\s*[x*•\-\s]*(\d{4})\b",
    re.I,
)


@dataclass
class Line:
    page: int
    top: float
    bottom: float
    words: list[dict[str, Any]]

    @property
    def text(self) -> str:
        return " ".join(w["text"] for w in self.words)


def extract_pdf(data: bytes) -> GridResult | OcrTextResult:
    try:
        pdf = pdfplumber.open(io.BytesIO(data))
    except Exception as exc:
        raise PermanentJobError("doc.corrupt", f"unreadable PDF: {exc}") from exc
    with pdf:
        pages = pdf.pages
        if len(pages) > _MAX_PAGES:
            raise PermanentJobError("doc.too_large", f"more than {_MAX_PAGES} pages")
        try:
            texts = [page.extract_text() or "" for page in pages]
        except Exception as exc:
            raise PermanentJobError("doc.corrupt", f"unreadable PDF content: {exc}") from exc
        chars = sum(len(re.sub(r"\s", "", t)) for t in texts)
        if not pages or chars < MIN_CHARS_PER_PAGE * len(pages):
            return ocr_pdf(pages)
        full_text = "\n".join(texts)
        rows = _ruled_tables(pages) or _positional_table(pages)
    statement = statement_facts(full_text)
    return {
        "kind": "grid",
        "sheets": [{"name": "Statement", "rows": rows}],
        "pages": len(pages),
        "textLayer": True,
        "statement": statement,
    }


# ----------------------------------------------------------------------------------------------------------
# Token classification
# ----------------------------------------------------------------------------------------------------------


def is_amount(token: str) -> bool:
    return bool(AMOUNT_RE.match(token.strip()))


def is_date(token: str) -> bool:
    t = token.strip()
    return any(r.match(t) for r in DATE_RES)


def _starts_with_date(cells: list[str]) -> bool:
    first = cells[0].strip() if cells else ""
    if not first:
        return False
    parts = first.split()
    if is_date(parts[0]):
        return True
    # "Oct 05", "05 Oct", "05 Oct 2026"
    return len(parts) >= 2 and bool(
        (MONTH_WORD_RE.match(parts[0]) and parts[1].rstrip(",").isdigit())
        or (parts[0].isdigit() and MONTH_WORD_RE.match(parts[1]))
    )


def _is_header(cells: list[str]) -> bool:
    words = [w.lower().strip(":") for c in cells for w in c.split()]
    if not words:
        return False
    hits = sum(1 for w in words if w in HEADER_WORDS)
    has_amountish = any(w in AMOUNT_HEADERS for w in words)
    return hits >= 2 and has_amountish and hits >= len(words) * 0.6


def _is_balance_line(text: str) -> bool:
    return bool(OPENING_RE.search(text) or CLOSING_RE.search(text))


# ----------------------------------------------------------------------------------------------------------
# Ruled tables
# ----------------------------------------------------------------------------------------------------------


def _ruled_tables(pages: list[Any]) -> list[list[str]]:
    header: list[str] | None = None
    rows: list[list[str]] = []
    for page in pages:
        try:
            tables = page.extract_tables()
        except Exception:  # noqa: S112 — a page that can't be table-parsed falls back to positional parsing
            continue
        for table in tables:
            for raw in table:
                cells = [" ".join((c or "").split()) for c in raw]
                if not any(cells):
                    continue
                if _is_header(cells):
                    if header is None:
                        header = cells
                    continue  # repeated header on later pages
                if header is None:
                    continue  # tables before the transaction table (summary boxes)
                if _is_balance_line(" ".join(cells)) and not _starts_with_date(cells):
                    continue
                if _starts_with_date(cells):
                    rows.append(_fit(cells, len(header)))
                elif rows and not any(is_amount(c) for c in cells if c):
                    _append_description(rows[-1], header, " ".join(c for c in cells if c))
    if header is None or not rows:
        return []
    return [header, *rows]


def _fit(cells: list[str], width: int) -> list[str]:
    return (cells + [""] * width)[:width]


def _description_index(header: list[str]) -> int:
    for i, h in enumerate(header):
        label = h.lower()
        if "date" not in label and any(
            k in label for k in ("description", "details", "payee", "memo", "transaction")
        ):
            return i
    return 1 if len(header) > 1 else 0


def _append_description(row: list[str], header: list[str], text: str) -> None:
    i = _description_index(header)
    row[i] = f"{row[i]} {text}".strip()


# ----------------------------------------------------------------------------------------------------------
# Positional reconstruction (whitespace-aligned statements)
# ----------------------------------------------------------------------------------------------------------


def _lines(page: Any, page_no: int) -> list[Line]:
    words = page.extract_words(x_tolerance=1.5, y_tolerance=2.5, keep_blank_chars=False, use_text_flow=False)
    lines: list[Line] = []
    for w in sorted(words, key=lambda w: (round(w["top"]), w["x0"])):
        if lines and abs(lines[-1].top - w["top"]) <= 2.5:
            lines[-1].words.append(w)
            lines[-1].bottom = max(lines[-1].bottom, w["bottom"])
        else:
            lines.append(Line(page_no, w["top"], w["bottom"], [w]))
    for line in lines:
        line.words.sort(key=lambda w: w["x0"])
    return lines


@dataclass
class Column:
    label: str
    x0: float
    x1: float


def _header_columns(line: Line) -> list[Column]:
    """Groups header words into columns; words closer than 6pt belong to one label ("Transaction Date")."""
    cols: list[Column] = []
    for w in line.words:
        if cols and w["x0"] - cols[-1].x1 < 6:
            cols[-1].label += " " + w["text"]
            cols[-1].x1 = w["x1"]
        else:
            cols.append(Column(w["text"], w["x0"], w["x1"]))
    return cols


def _assign(words: list[dict[str, Any]], cols: list[Column]) -> list[str]:
    cells: list[list[str]] = [[] for _ in cols]
    for w in words:
        best, best_d = 0, float("inf")
        for i, c in enumerate(cols):
            if w["x1"] < c.x0:
                d = c.x0 - w["x1"]
            elif w["x0"] > c.x1:
                d = w["x0"] - c.x1
            else:
                d = 0.0
            # Numbers are right-aligned under their headers: prefer the column whose right edge is closest.
            if is_amount(w["text"]):
                d = min(d, abs(w["x1"] - c.x1)) - 0.01
            if d < best_d:
                best, best_d = i, d
        cells[best].append(w["text"])
    return [" ".join(c) for c in cells]


def _positional_table(pages: list[Any]) -> list[list[str]]:
    all_lines = [line for n, page in enumerate(pages) for line in _lines(page, n)]
    # Lines printed on several pages (bank name, address, legal footer) are page furniture.
    counts = Counter(_norm(line.text) for line in all_lines)
    repeated = {t for t, n in counts.items() if n > 1 and len(pages) > 1}

    cols: list[Column] | None = None
    header_labels: list[str] | None = None
    rows: list[list[str]] = []
    last: Line | None = None
    for line in all_lines:
        cells_text = [w["text"] for w in line.words]
        if _is_header(cells_text):
            if cols is None:
                cols = _header_columns(line)
                header_labels = [c.label for c in cols]
            last = None
            continue
        if cols is None or header_labels is None:
            continue
        text = line.text
        if FOOTER_RE.match(text.strip()) or (_norm(text) in repeated and not _starts_with_date([text])):
            last = None
            continue
        cells = _assign(line.words, cols)
        if _is_balance_line(text):
            last = None
            continue
        if _starts_with_date(cells) or _starts_with_date([text]):
            rows.append(cells)
            last = line
            continue
        has_amount = any(is_amount(w["text"]) for w in line.words)
        close = (
            last is not None
            and last.page == line.page
            and line.top - last.bottom < (last.bottom - last.top) * 1.8
        )
        if rows and not has_amount and close:
            _append_description(rows[-1], header_labels, text)
            last = line
        else:
            last = None
    if header_labels is None or not rows:
        return []
    return [header_labels, *rows]


def _norm(text: str) -> str:
    return re.sub(r"\d", "#", " ".join(text.lower().split()))


# ----------------------------------------------------------------------------------------------------------
# Statement facts
# ----------------------------------------------------------------------------------------------------------


def statement_facts(text: str) -> Statement:
    opening = closing = None
    for line in text.splitlines():
        if opening is None and OPENING_RE.search(line):
            opening = _last_money(line)
        if CLOSING_RE.search(line):
            closing = _last_money(line) or closing
    start, end = _period(text)
    last4 = LAST4_RE.search(text)
    return {
        "openingBalance": opening,
        "closingBalance": closing,
        "periodStart": start,
        "periodEnd": end,
        "accountLast4": last4.group(1) if last4 else None,
        "currency": _currency(text),
    }


def _last_money(line: str) -> str | None:
    found = MONEY_IN_TEXT_RE.findall(line)
    return found[-1].strip() if found else None


def _currency(text: str) -> str | None:
    for symbol, code in (("$", "USD"), ("€", "EUR"), ("£", "GBP")):
        if symbol in text:
            return code
    m = re.search(r"\b(USD|EUR|GBP|CAD|AUD|CHF|JPY|INR)\b", text)
    return m.group(1) if m else None


_NUM_DATE = r"\d{1,2}/\d{1,2}/\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{4}"
_MON = r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?"
_WORD_DATE = rf"{_MON}\s+\d{{1,2}},?\s+\d{{4}}|\d{{1,2}}\s+{_MON}\s+\d{{4}}"
PERIOD_RE = re.compile(
    rf"({_NUM_DATE}|{_WORD_DATE})\s*(?:-|–|—|to|through|thru|until)\s*({_NUM_DATE}|{_WORD_DATE})", re.I
)


def _period(text: str) -> tuple[str | None, str | None]:
    candidates = list(PERIOD_RE.finditer(text))
    # Prefer a range on a line mentioning the statement period.
    for m in candidates:
        line_start = text.rfind("\n", 0, m.start()) + 1
        line = text[line_start : text.find("\n", m.end()) if "\n" in text[m.end() :] else len(text)]
        if re.search(r"period|statement|from|cycle|through", line, re.I):
            return _iso(m.group(1)), _iso(m.group(2))
    if candidates:
        return _iso(candidates[0].group(1)), _iso(candidates[0].group(2))
    return None, None


def _iso(token: str) -> str | None:
    t = token.strip().rstrip(",")
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", t):
            return date.fromisoformat(t).isoformat()
        if m := re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{2,4})", t):
            a, b, y = int(m.group(1)), int(m.group(2)), _year(m.group(3))
            month, day = (b, a) if a > 12 else (a, b)  # US order unless the first part can't be a month
            return date(y, month, day).isoformat()
        if m := re.fullmatch(r"(\d{1,2})\.(\d{1,2})\.(\d{4})", t):
            return date(int(m.group(3)), int(m.group(2)), int(m.group(1))).isoformat()
        parts = t.replace(",", " ").replace(".", " ").split()
        if len(parts) == 3:
            if parts[0].isdigit():
                day, mon, year = int(parts[0]), parts[1], int(parts[2])
            else:
                mon, day, year = parts[0], int(parts[1]), int(parts[2])
            month_no = MONTHS.get(mon[:3].lower())
            if month_no:
                return date(year, month_no, day).isoformat()
    except ValueError:
        return None
    return None


def _year(y: str) -> int:
    n = int(y)
    return n + 2000 if n < 100 else n

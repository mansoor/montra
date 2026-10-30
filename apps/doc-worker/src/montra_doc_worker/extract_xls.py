"""Legacy Excel (.xls, BIFF) → grid of display strings, one sheet per worksheet.

Cells are rendered the way a user sees them: numbers follow the cell's number format (decimals, grouping,
percent) without float noise, and date cells become ISO dates. Formulas are never evaluated; xlrd only reads
the cached values, so nothing embedded in the workbook runs.
"""

from __future__ import annotations

import re
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

import xlrd

from .errors import PermanentJobError
from .result import GridResult, Sheet

_MAX_ROWS = 200_000


def extract_xls(data: bytes) -> GridResult:
    try:
        book = xlrd.open_workbook(file_contents=data, formatting_info=True, on_demand=True)
    except Exception as exc:
        raise PermanentJobError("doc.corrupt", f"unreadable XLS workbook: {exc}") from exc
    sheets: list[Sheet] = []
    try:
        for index in range(book.nsheets):
            sheet = book.sheet_by_index(index)
            if sheet.nrows > _MAX_ROWS:
                raise PermanentJobError(
                    "doc.too_large", f"sheet {sheet.name!r} has more than {_MAX_ROWS} rows"
                )
            rows: list[list[str]] = []
            for r in range(sheet.nrows):
                rows.append([_cell_text(book, sheet, r, c) for c in range(sheet.ncols)])
            sheets.append({"name": sheet.name, "rows": _trim(rows)})
    finally:
        book.release_resources()
    return {"kind": "grid", "sheets": sheets, "pages": None, "textLayer": True, "statement": None}


def _trim(rows: list[list[str]]) -> list[list[str]]:
    """Drops trailing empty rows and trailing empty cells on every row."""
    out = [row[: _last_non_empty(row) + 1] for row in rows]
    while out and not any(out[-1]):
        out.pop()
    return out


def _last_non_empty(row: list[str]) -> int:
    for i in range(len(row) - 1, -1, -1):
        if row[i] != "":
            return i
    return -1


def _cell_text(book: Any, sheet: Any, r: int, c: int) -> str:
    cell = sheet.cell(r, c)
    ctype = cell.ctype
    if ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK):
        return ""
    if ctype == xlrd.XL_CELL_TEXT:
        return str(cell.value).strip()
    if ctype == xlrd.XL_CELL_BOOLEAN:
        return "TRUE" if cell.value else "FALSE"
    if ctype == xlrd.XL_CELL_ERROR:
        return str(xlrd.error_text_from_code.get(cell.value, "#ERR"))
    if ctype == xlrd.XL_CELL_DATE:
        try:
            dt = xlrd.xldate.xldate_as_datetime(cell.value, book.datemode)
        except Exception:
            return format_number(float(cell.value), None)
        return str(dt.date().isoformat())
    if ctype == xlrd.XL_CELL_NUMBER:
        fmt = _format_string(book, sheet, r, c)
        return format_number(float(cell.value), fmt)
    return str(cell.value)


def _format_string(book: Any, sheet: Any, r: int, c: int) -> str | None:
    try:
        xf = book.xf_list[sheet.cell_xf_index(r, c)]
        fmt = book.format_map.get(xf.format_key)
        return str(fmt.format_str) if fmt is not None else None
    except Exception:
        return None


_SECTION_QUOTED = re.compile(r'"[^"]*"|\\.')


def format_number(value: float, fmt: str | None) -> str:
    """Renders a number like Excel would for common formats ('0.00', '#,##0.00', '0%', General)."""
    section = (fmt or "General").split(";")[0]
    plain = _SECTION_QUOTED.sub("", section)
    if plain.strip().lower() in ("general", "@", ""):
        return _general(value)
    percent = "%" in plain
    shown = Decimal(repr(value)) * (100 if percent else 1)
    decimals = 0
    if "." in plain:
        decimals = len(re.match(r"[0#?]*", plain.split(".", 1)[1]).group(0))  # type: ignore[union-attr]
    quantum = Decimal(1).scaleb(-decimals)
    rounded = shown.quantize(quantum, rounding=ROUND_HALF_UP)
    grouped = "," in plain.split(".")[0]
    text = f"{rounded:,.{decimals}f}" if grouped else f"{rounded:.{decimals}f}"
    if text in ("-0", "-0.0") or re.fullmatch(r"-0\.0+", text):
        text = text[1:]
    return text + ("%" if percent else "")


def _general(value: float) -> str:
    if value == int(value) and abs(value) < 1e15:
        return str(int(value))
    # Excel shows at most 15 significant digits, which hides binary float noise (0.1 + 0.2 → 0.3).
    return format(Decimal(format(value, ".15g")).normalize(), "f")

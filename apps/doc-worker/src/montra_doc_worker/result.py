"""The `doc.extract` result contract shared with the Node import pipeline (ADR-0011)."""

from __future__ import annotations

from typing import Literal, TypedDict

from .errors import PermanentJobError


class Sheet(TypedDict):
    name: str
    rows: list[list[str]]


class Statement(TypedDict):
    openingBalance: str | None
    closingBalance: str | None
    periodStart: str | None
    periodEnd: str | None
    accountLast4: str | None
    currency: str | None


class GridResult(TypedDict):
    kind: Literal["grid"]
    sheets: list[Sheet]
    pages: int | None
    textLayer: bool
    statement: Statement | None


FileType = Literal["xls", "pdf"]

_OLE2 = bytes.fromhex("D0CF11E0A1B11AE1")


def check_magic(data: bytes, file_type: str) -> FileType:
    """Confirms the bytes match the declared type. The extension is never trusted on its own."""
    if file_type == "xls":
        if not data.startswith(_OLE2):
            raise PermanentJobError("doc.type_mismatch", "not a legacy Excel (OLE2) workbook")
        return "xls"
    if file_type == "pdf":
        # The PDF header may follow a few junk bytes; the spec allows it within the first 1024 bytes.
        if b"%PDF-" not in data[:1024]:
            raise PermanentJobError("doc.type_mismatch", "not a PDF file")
        return "pdf"
    raise PermanentJobError("doc.unsupported_type", f"unsupported fileType {file_type!r}")

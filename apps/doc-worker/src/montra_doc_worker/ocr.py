"""OCR for scanned PDF statements (IMP-05, ADR-0012 §9).

Pages are rendered at 300 dpi and read with Tesseract in block mode (``--psm 6``), which keeps each printed
line on one text line. Statement facts (balances, period, account last-4) are read from the raw text; the
pages are then redacted (``redact.py``) before they leave the worker. The Node import job turns the text into
rows with the AI gateway's ``extract_statement_table`` task.
"""

from __future__ import annotations

import re
import shutil
from typing import Any

from .errors import PermanentJobError
from .redact import redact_pages
from .result import OcrTextResult

MAX_OCR_PAGES = 50
RESOLUTION = 300
PAGE_TIMEOUT_SECONDS = 120
TESSERACT_CONFIG = "--psm 6"


def tesseract_available() -> bool:
    return shutil.which("tesseract") is not None


def ocr_pdf(pages: list[Any]) -> OcrTextResult:
    """Reads pdfplumber pages with Tesseract and returns redacted text per page."""
    if not tesseract_available():
        raise PermanentJobError(
            "pdf.ocr_unavailable", "Scanned PDFs need OCR, which isn't installed on this server"
        )
    if len(pages) > MAX_OCR_PAGES:
        raise PermanentJobError(
            "pdf.too_many_pages", f"scanned statements are limited to {MAX_OCR_PAGES} pages"
        )
    import pytesseract

    texts: list[str] = []
    for page in pages:
        try:
            image = page.to_image(resolution=RESOLUTION).original.convert("L")
        except Exception as exc:
            raise PermanentJobError("doc.corrupt", f"could not render a PDF page: {exc}") from exc
        try:
            text = pytesseract.image_to_string(image, config=TESSERACT_CONFIG, timeout=PAGE_TIMEOUT_SECONDS)
        except RuntimeError as exc:  # pytesseract raises RuntimeError on timeout
            raise PermanentJobError("pdf.ocr_failed", f"OCR timed out on a page: {exc}") from exc
        except pytesseract.TesseractError as exc:
            raise PermanentJobError("pdf.ocr_failed", f"OCR failed: {exc}") from exc
        texts.append(_tidy(text))

    if sum(len(re.sub(r"\s", "", t)) for t in texts) == 0:
        raise PermanentJobError("pdf.ocr_empty", "no text could be read from this scan")

    # Late import: extract_pdf imports this module.
    from .extract_pdf import statement_facts

    return {
        "kind": "ocr_text",
        "pages": redact_pages(texts),
        "pageCount": len(pages),
        "textLayer": False,
        "ocrEngine": "tesseract",
        "statement": statement_facts("\n".join(texts)),
    }


def _tidy(text: str) -> str:
    """Drops blank lines and trailing spaces; keeps the line structure Tesseract produced."""
    lines = [line.rstrip() for line in text.replace("\x0c", "").splitlines()]
    return "\n".join(line for line in lines if line.strip())

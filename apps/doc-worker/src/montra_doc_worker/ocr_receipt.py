"""OCR for receipt photos and PDF invoices: the local-mode path of receipt extraction (RCP-01, ADR-0014 §3).

Photos are straightened from their EXIF orientation, converted to greyscale and upscaled when small, then read
with Tesseract in single-column mode (``--psm 4``), which suits narrow till rolls. PDF invoices use their text
layer when they have one and OCR otherwise. Every line is redacted (long digit runs, emails, phone numbers)
before the text leaves the worker; card endings such as ``**** 1234`` survive. The Node job turns the text
into a receipt with the AI gateway's ``extract_receipt`` task.
"""

from __future__ import annotations

import io
import re
from typing import Literal, TypedDict

from .errors import PermanentJobError
from .ocr import tesseract_available
from .redact import redact_line

MAX_RECEIPT_PAGES = 20
RESOLUTION = 300
MIN_WIDTH = 1000
PAGE_TIMEOUT_SECONDS = 60
RECEIPT_TESSERACT_CONFIG = "--psm 4"

ReceiptFileType = Literal["jpeg", "png", "webp", "pdf"]


class ReceiptTextResult(TypedDict):
    """Redacted text per page (photo or PDF page), in the order the pages were captured."""

    kind: Literal["receipt_text"]
    pages: list[str]
    pageCount: int
    textLayer: bool
    ocrEngine: Literal["tesseract"] | None


def detect_receipt_type(data: bytes) -> ReceiptFileType:
    """Sniffs the bytes; the file name and declared type are never trusted."""
    if data.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if b"%PDF-" in data[:1024]:
        return "pdf"
    raise PermanentJobError("receipt.unsupported_type", "receipts must be JPEG, PNG, WebP or PDF files")


def ocr_receipt(files: list[bytes]) -> ReceiptTextResult:
    """Reads every file (pages in order) and returns redacted text per page."""
    if not files:
        raise PermanentJobError("receipt.no_files", "a receipt needs at least one image or PDF")
    texts: list[str] = []
    used_ocr = False
    text_layer = False
    for data in files:
        kind = detect_receipt_type(data)
        if kind == "pdf":
            pages, ocr_used = _pdf_pages(data)
            used_ocr |= ocr_used
            text_layer |= not ocr_used
            texts.extend(pages)
        else:
            texts.append(_ocr_image(data))
            used_ocr = True
        if len(texts) > MAX_RECEIPT_PAGES:
            raise PermanentJobError(
                "receipt.too_many_pages", f"receipts are limited to {MAX_RECEIPT_PAGES} pages"
            )
    if sum(len(re.sub(r"\s", "", t)) for t in texts) == 0:
        raise PermanentJobError("receipt.ocr_empty", "no text could be read from this receipt")
    return {
        "kind": "receipt_text",
        "pages": ["\n".join(redact_line(line) for line in page.splitlines()) for page in texts],
        "pageCount": len(texts),
        "textLayer": text_layer and not used_ocr,
        "ocrEngine": "tesseract" if used_ocr else None,
    }


def _require_tesseract() -> None:
    if not tesseract_available():
        raise PermanentJobError(
            "receipt.ocr_unavailable",
            "Reading receipt photos needs OCR, which isn't installed on this server",
        )


def _ocr_image(data: bytes) -> str:
    _require_tesseract()
    from PIL import Image, ImageOps, UnidentifiedImageError

    try:
        image = ImageOps.exif_transpose(Image.open(io.BytesIO(data)))
    except (UnidentifiedImageError, OSError) as exc:
        raise PermanentJobError("doc.corrupt", f"could not open the image: {exc}") from exc
    image = image.convert("L")
    if image.width < MIN_WIDTH:
        scale = MIN_WIDTH / image.width
        image = image.resize((MIN_WIDTH, max(1, int(image.height * scale))), Image.Resampling.LANCZOS)
    return _tesseract(image)


def _pdf_pages(data: bytes) -> tuple[list[str], bool]:
    """Text per page from the PDF's text layer, or OCR when it has none. Returns (pages, ocr_used)."""
    import pdfplumber

    try:
        pdf = pdfplumber.open(io.BytesIO(data))
    except Exception as exc:
        raise PermanentJobError("doc.corrupt", f"could not open the PDF: {exc}") from exc
    with pdf:
        if len(pdf.pages) > MAX_RECEIPT_PAGES:
            raise PermanentJobError(
                "receipt.too_many_pages", f"receipts are limited to {MAX_RECEIPT_PAGES} pages"
            )
        layer = [_tidy(page.extract_text() or "") for page in pdf.pages]
        if any(re.sub(r"\s", "", t) for t in layer):
            return layer, False
        _require_tesseract()
        texts: list[str] = []
        for page in pdf.pages:
            try:
                image = page.to_image(resolution=RESOLUTION).original.convert("L")
            except Exception as exc:
                raise PermanentJobError("doc.corrupt", f"could not render a PDF page: {exc}") from exc
            texts.append(_tesseract(image))
        return texts, True


def _tesseract(image: object) -> str:
    import pytesseract

    try:
        text = pytesseract.image_to_string(
            image, config=RECEIPT_TESSERACT_CONFIG, timeout=PAGE_TIMEOUT_SECONDS
        )
    except RuntimeError as exc:  # pytesseract raises RuntimeError on timeout
        raise PermanentJobError("receipt.ocr_failed", f"OCR timed out: {exc}") from exc
    except pytesseract.TesseractError as exc:
        raise PermanentJobError("receipt.ocr_failed", f"OCR failed: {exc}") from exc
    return _tidy(text)


def _tidy(text: str) -> str:
    lines = [line.rstrip() for line in text.replace("\x0c", "").splitlines()]
    return "\n".join(line for line in lines if line.strip())

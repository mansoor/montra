from __future__ import annotations

import io
import os
import shutil
from typing import Any

import pytest
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import A6
from reportlab.pdfgen import canvas

from montra_doc_worker import ocr, ocr_receipt
from montra_doc_worker.errors import PermanentJobError
from montra_doc_worker.ocr_receipt import detect_receipt_type
from montra_doc_worker.ocr_receipt import ocr_receipt as read_receipt
from montra_doc_worker.queue import handle_receipt_ocr
from montra_doc_worker.redact import MASK

HAVE_TESSERACT = shutil.which("tesseract") is not None
needs_tesseract = pytest.mark.skipif(
    not HAVE_TESSERACT and not os.environ.get("REQUIRE_TESSERACT"),
    reason="tesseract binary not installed (apt-get install tesseract-ocr)",
)

RECEIPT_LINES = [
    "WALMART SUPERCENTER",
    "10/05/2026 14:32",
    "GV 2% MLK GAL      3.48 N",
    "ONN USB-C CHRGR   12.88 T",
    "TAX                1.75",
    "TOTAL             18.11",
    "CARD **** 1234",
    "REF 4111111111111111",
    "help@example.com",
]


def receipt_png(lines: list[str] = RECEIPT_LINES, width: int = 600) -> bytes:
    """A white till-roll image with black monospace text, large enough for Tesseract."""
    font = ImageFont.load_default(size=28)
    image = Image.new("L", (width, 60 + 44 * len(lines)), 255)
    draw = ImageDraw.Draw(image)
    for i, line in enumerate(lines):
        draw.text((20, 30 + 44 * i), line, fill=0, font=font)
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def receipt_pdf(lines: list[str] | None) -> bytes:
    """A PDF invoice with a text layer (lines), or a blank page (no text layer) when lines is None."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A6)
    for i, line in enumerate(lines or []):
        c.drawString(20, 380 - 14 * i, line)
    c.showPage()
    c.save()
    return buf.getvalue()


# ----- Real OCR -------------------------------------------------------------------------------------------


@needs_tesseract
def test_reads_a_receipt_photo_and_redacts_it() -> None:
    result = read_receipt([receipt_png()])
    assert result["kind"] == "receipt_text"
    assert result["ocrEngine"] == "tesseract"
    text = result["pages"][0]
    assert "TOTAL" in text
    assert "18.11" in text
    assert "4111111111111111" not in text


# ----- Without Tesseract ----------------------------------------------------------------------------------


def test_sniffs_receipt_types() -> None:
    assert detect_receipt_type(b"\xff\xd8\xff\xe0rest") == "jpeg"
    assert detect_receipt_type(receipt_png()) == "png"
    assert detect_receipt_type(b"RIFF\x00\x00\x00\x00WEBPVP8 ") == "webp"
    assert detect_receipt_type(receipt_pdf(["x"])) == "pdf"
    with pytest.raises(PermanentJobError) as err:
        detect_receipt_type(b"GIF89a")
    assert err.value.code == "receipt.unsupported_type"


def test_pdf_invoices_use_their_text_layer_without_ocr(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ocr_receipt, "tesseract_available", lambda: False)
    result = read_receipt([receipt_pdf(["AMAZON.COM", "USB HUB   24.99", "ACCOUNT 123456789012"])])
    assert result["textLayer"] is True
    assert result["ocrEngine"] is None
    assert result["pages"][0].splitlines() == ["AMAZON.COM", "USB HUB 24.99", f"ACCOUNT {MASK}"]


def test_photos_are_greyscale_upscaled_and_read_in_column_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    pytesseract = pytest.importorskip("pytesseract")
    seen: list[tuple[str, str, int]] = []

    def fake(image: Any, config: str = "", timeout: int = 0) -> str:
        seen.append((config, image.mode, image.width))
        return "\n".join(RECEIPT_LINES) + "\n\n\x0c"

    monkeypatch.setattr(ocr_receipt, "tesseract_available", lambda: True)
    monkeypatch.setattr(pytesseract, "image_to_string", fake)
    storage = _Storage([receipt_png(width=400), receipt_png()])
    result = handle_receipt_ocr({"storageKeys": ["a", "b"]}, storage)  # type: ignore[arg-type]
    assert seen == [("--psm 4", "L", ocr_receipt.MIN_WIDTH), ("--psm 4", "L", ocr_receipt.MIN_WIDTH)]
    assert result["pageCount"] == 2
    assert result["textLayer"] is False
    lines = result["pages"][0].splitlines()
    assert "CARD **** 1234" in lines
    assert f"REF {MASK}" in lines
    assert "help@example.com" not in result["pages"][0]


def test_missing_tesseract_empty_text_and_page_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ocr_receipt, "tesseract_available", lambda: False)
    with pytest.raises(PermanentJobError) as err:
        read_receipt([receipt_png()])
    assert err.value.code == "receipt.ocr_unavailable"

    pytesseract = pytest.importorskip("pytesseract")
    monkeypatch.setattr(ocr_receipt, "tesseract_available", lambda: True)
    monkeypatch.setattr(pytesseract, "image_to_string", lambda *a, **k: "  \n\x0c")
    with pytest.raises(PermanentJobError) as err:
        read_receipt([receipt_png()])
    assert err.value.code == "receipt.ocr_empty"

    monkeypatch.setattr(pytesseract, "image_to_string", lambda *a, **k: "TOTAL 1.00")
    with pytest.raises(PermanentJobError) as err:
        read_receipt([receipt_png()] * (ocr_receipt.MAX_RECEIPT_PAGES + 1))
    assert err.value.code == "receipt.too_many_pages"


def test_bad_payloads_and_files_fail_permanently() -> None:
    with pytest.raises(PermanentJobError) as err:
        handle_receipt_ocr({"storageKeys": []}, _Storage([]))
    assert err.value.code == "doc.bad_payload"
    with pytest.raises(PermanentJobError) as err:
        read_receipt([b"\xff\xd8\xff not really a jpeg"])
    assert err.value.code in ("doc.corrupt", "receipt.ocr_unavailable")
    assert ocr.tesseract_available() == HAVE_TESSERACT


class _Storage:
    def __init__(self, files: list[bytes]) -> None:
        self.files = files
        self.n = 0

    def read(self, key: str) -> bytes:
        data = self.files[self.n]
        self.n += 1
        return data

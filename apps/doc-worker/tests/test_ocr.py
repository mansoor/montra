from __future__ import annotations

import os
import shutil
from typing import Any

import pytest

from montra_doc_worker import ocr
from montra_doc_worker.errors import PermanentJobError
from montra_doc_worker.extract_pdf import extract_pdf
from montra_doc_worker.queue import handle_doc_extract
from montra_doc_worker.redact import MASK, REDACTED, redact_line, redact_pages

from . import fixtures

HAVE_TESSERACT = shutil.which("tesseract") is not None
# CI installs Tesseract and sets REQUIRE_TESSERACT=1, so the real OCR tests can't be skipped there.
needs_tesseract = pytest.mark.skipif(
    not HAVE_TESSERACT and not os.environ.get("REQUIRE_TESSERACT"),
    reason="tesseract binary not installed (apt-get install tesseract-ocr)",
)


# ----- Real OCR -------------------------------------------------------------------------------------------


@needs_tesseract
def test_scanned_statement_is_read_and_redacted() -> None:
    result = extract_pdf(fixtures.make_scanned_statement_pdf())
    assert result["kind"] == "ocr_text"
    assert set(result) == {"kind", "pages", "pageCount", "textLayer", "ocrEngine", "statement"}
    assert result["pageCount"] == 1
    assert result["textLayer"] is False
    assert result["ocrEngine"] == "tesseract"
    assert result["statement"] == {
        "openingBalance": "$1,000.00",
        "closingBalance": "$1,234.56",
        "periodStart": "2026-10-01",
        "periodEnd": "2026-10-31",
        "accountLast4": "6789",
        "currency": "USD",
    }
    text = "\n".join(result["pages"])
    # Transaction lines survive intact …
    for expected in ("10/02/2026", "COFFEE SHOP", "-4.50", "PAYROLL DEPOSIT", "2,000.00", "GROCERY MART"):
        assert expected in text
    assert "-1,640.69" in text
    # … identifying details don't.
    for secret in ("JANE", "Elm", "62704", "000123456789", "555-0199", "help@examplebank"):
        assert secret not in text


@needs_tesseract
def test_blank_scan_fails_permanently() -> None:
    with pytest.raises(PermanentJobError) as err:
        extract_pdf(fixtures.make_scanned_like_pdf())
    assert err.value.code == "pdf.ocr_empty"


@needs_tesseract
def test_queue_handler_returns_ocr_text(tmp_path: Any) -> None:
    from montra_doc_worker.storage import LocalStorage

    (tmp_path / "scan.pdf").write_bytes(fixtures.make_scanned_statement_pdf())
    result = handle_doc_extract({"storageKey": "scan.pdf", "fileType": "pdf"}, LocalStorage(tmp_path))
    assert result["kind"] == "ocr_text"


# ----- OCR plumbing without the binary ---------------------------------------------------------------------


def test_missing_tesseract_is_a_permanent_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ocr.shutil, "which", lambda _name: None)
    with pytest.raises(PermanentJobError) as err:
        extract_pdf(fixtures.make_scanned_like_pdf())
    assert err.value.code == "pdf.ocr_unavailable"


def test_page_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ocr, "tesseract_available", lambda: True)
    monkeypatch.setattr(ocr, "MAX_OCR_PAGES", 0)
    with pytest.raises(PermanentJobError) as err:
        extract_pdf(fixtures.make_scanned_like_pdf())
    assert err.value.code == "pdf.too_many_pages"


def test_ocr_result_shape_with_stubbed_engine(monkeypatch: pytest.MonkeyPatch) -> None:
    pytesseract = pytest.importorskip("pytesseract")
    calls: list[str] = []

    def fake_image_to_string(image: Any, config: str = "", timeout: int = 0) -> str:
        calls.append(config)
        assert image.mode == "L"
        return "\n".join(fixtures.SCANNED_STATEMENT_LINES) + "\n\n\x0c"

    monkeypatch.setattr(ocr, "tesseract_available", lambda: True)
    monkeypatch.setattr(pytesseract, "image_to_string", fake_image_to_string)
    result = extract_pdf(fixtures.make_scanned_like_pdf())
    assert calls == ["--psm 6"]
    assert result["kind"] == "ocr_text"
    assert result["statement"] is not None
    assert result["statement"]["accountLast4"] == "6789"  # read before redaction
    lines = result["pages"][0].splitlines()
    assert lines[0] == "First Example Bank"
    assert lines[1:4] == [REDACTED, REDACTED, REDACTED]
    assert lines[5] == f"Account number {MASK}"
    assert lines[6] == f"Customer service {REDACTED} or {REDACTED}"
    assert "" not in lines  # blank lines dropped
    assert lines[-1] == "10/15/2026  GROCERY MART        -1,640.69     1,234.56"


def test_ocr_timeout_is_permanent(monkeypatch: pytest.MonkeyPatch) -> None:
    pytesseract = pytest.importorskip("pytesseract")

    def boom(*_a: Any, **_k: Any) -> str:
        raise RuntimeError("Tesseract process timeout")

    monkeypatch.setattr(ocr, "tesseract_available", lambda: True)
    monkeypatch.setattr(pytesseract, "image_to_string", boom)
    with pytest.raises(PermanentJobError) as err:
        extract_pdf(fixtures.make_scanned_like_pdf())
    assert err.value.code == "pdf.ocr_failed"


# ----- Redaction ------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        ("Account number 000123456789", f"Account number {MASK}"),
        ("Card 1234 5678 9012 3456 exp 09/28", f"Card {MASK} exp 09/28"),
        ("Card 1234-5678-9012-3456", f"Card {MASK}"),
        ("Routing 021000021", f"Routing {MASK}"),
        ("IBAN DE89 3704 0044 0532 0130 00", f"IBAN DE{MASK} 00"),
        ("Call (555) 123-4567 today", f"Call {REDACTED} today"),
        ("Call 555-123-4567", f"Call {REDACTED}"),
        ("Call +1 555 123 4567", f"Call {REDACTED}"),
        ("Call 1-800-555-0199", f"Call {REDACTED}"),
        ("Write to jane.doe+bank@example.co.uk", f"Write to {REDACTED}"),
        ("ACH ONLINE TRANSFER REF 9912345678", f"ACH ONLINE TRANSFER REF {MASK}"),
        # Kept: amounts, dates, short numbers, last-4 references
        ("10/02/2026 COFFEE SHOP -4.50 995.50", "10/02/2026 COFFEE SHOP -4.50 995.50"),
        ("10/05/2026 PAYROLL 1,234,567.89 2,000.00", "10/05/2026 PAYROLL 1,234,567.89 2,000.00"),
        ("2026-10-05 WIRE 1234567.89", "2026-10-05 WIRE 1234567.89"),
        ("05.10.2026 MIETE 1.234.567,00", "05.10.2026 MIETE 1.234.567,00"),
        ("05.10.2026 LOHN 1 234,56", "05.10.2026 LOHN 1 234,56"),
        ("20261005 POS PURCHASE 12.00", "20261005 POS PURCHASE 12.00"),
        ("Card ending in 1005", "Card ending in 1005"),
        ("CHECK 1043 250.00", "CHECK 1043 250.00"),
        ("10-05-2026 SQ *BLUE BOTTLE 0423 -4.75", "10-05-2026 SQ *BLUE BOTTLE 0423 -4.75"),
    ],
)
def test_redact_line(line: str, expected: str) -> None:
    assert redact_line(line) == expected


def test_header_block_names_and_addresses() -> None:
    page = "\n".join(
        [
            "Second Example Credit Union",
            "PO Box 4400, Columbus, OH 43216",
            "Statement period Oct 1, 2026 - Oct 31, 2026",
            "MR JOHN A SMITH",
            "JANE SMITH",
            "4567 N Oak Avenue Apt 2B",
            "Columbus, OH 43215-1234",
            "Beginning balance 812.40",
            "Oct 02 COFFEE ON 123 MAIN ST -4.50",
            "Oct 03 PAYROLL 1,500.00",
        ]
    )
    lines = redact_pages([page])[0].splitlines()
    assert lines == [
        "Second Example Credit Union",  # bank name is not a personal name
        REDACTED,  # bank PO box: an address, harmless to drop
        "Statement period Oct 1, 2026 - Oct 31, 2026",
        REDACTED,  # title line
        REDACTED,  # name just above the address
        REDACTED,
        REDACTED,
        "Beginning balance 812.40",
        # Transaction lines are never address-redacted, even when they mention a street.
        "Oct 02 COFFEE ON 123 MAIN ST -4.50",
        "Oct 03 PAYROLL 1,500.00",
    ]


def test_uk_and_eu_addresses() -> None:
    uk = "\n".join(
        [
            "Example Bank plc",
            "Ms Alice Brown",
            "10 Downing Street",
            "London SW1A 2AA",
            "01/10/2026 TESCO 12.00",
        ]
    )
    assert redact_pages([uk])[0].splitlines() == [
        "Example Bank plc",
        REDACTED,
        REDACTED,
        REDACTED,
        "01/10/2026 TESCO 12.00",
    ]
    de = "\n".join(
        ["Beispielbank AG", "Max Mustermann", "Hauptstraße 5", "10115 Berlin", "01.10.2026 REWE 12,00"]
    )
    out = redact_pages([de])[0].splitlines()
    assert out[0] == "Beispielbank AG"
    assert out[2:4] == [REDACTED, REDACTED]
    assert out[1] == REDACTED
    assert out[-1] == "01.10.2026 REWE 12,00"


def test_joint_holders() -> None:
    page = "\n".join(
        [
            "Example Bank",
            "JOHN A SMITH",
            "JANE B SMITH",
            "77 Pine Rd",
            "Austin, TX 78701",
            "10/01/2026 A 1.00",
        ]
    )
    assert redact_pages([page])[0].splitlines() == ["Example Bank", *[REDACTED] * 4, "10/01/2026 A 1.00"]


def test_repeated_header_lines_on_later_pages_are_redacted() -> None:
    page1 = "\n".join(
        ["Example Bank", "JANE Q DOE", "123 Elm Street", "Springfield, IL 62704", "10/01/2026 A 1.00"]
    )
    page2 = "\n".join(["JANE Q DOE", "123 Elm Street", "10/20/2026 B 2.00", "Page 2 of 2"])
    _, second = redact_pages([page1, page2])
    assert second.splitlines() == [REDACTED, REDACTED, "10/20/2026 B 2.00", "Page 2 of 2"]


def test_lines_without_an_address_keep_names() -> None:
    # A name-looking line with no address nearby is kept (e.g. a merchant on a summary line).
    page = "\n".join(["Example Bank", "Summary of Activity", "Blue Bottle Coffee", "10/01/2026 X 1.00"])
    assert redact_pages([page])[0].splitlines()[:3] == [
        "Example Bank",
        "Summary of Activity",
        "Blue Bottle Coffee",
    ]


def test_empty_input() -> None:
    assert redact_pages([]) == []
    assert redact_pages([""]) == [""]

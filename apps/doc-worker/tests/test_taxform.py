"""taxform.read (ADR-0052 §6, TAX-08): synthetic forms in, masked text and identifiers out.

Every name, SSN, EIN and address below is made up. The central promise is checked on every result: no
SSN-shaped string, no nine-digit TIN, no person's name and no address survives in what leaves the worker; the
identifiers come back as last four digits (and the issuer's EIN), separately from the text.
"""

from __future__ import annotations

import io
import json
import os
import re
import shutil
from typing import Any

import pytest
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

from montra_doc_worker import taxform
from montra_doc_worker.queue import HANDLERS, handle_taxform_read
from montra_doc_worker.redact import MASK, REDACTED
from montra_doc_worker.taxform import (
    COPY_NOTE,
    TaxFormTextResult,
    extract_identifiers,
    mask_lines,
    members_from,
    read_pages,
    read_tax_form,
)

HAVE_TESSERACT = shutil.which("tesseract") is not None
needs_tesseract = pytest.mark.skipif(
    not HAVE_TESSERACT and not os.environ.get("REQUIRE_TESSERACT"),
    reason="tesseract binary not installed (apt-get install tesseract-ocr)",
)

MEMBERS = [{"name": "Sam Example", "token": "MEMBER_1"}, {"name": "Alex Example", "token": "MEMBER_2"}]
SSN = "123-45-6789"
EIN = "12-3456789"


def w2_copy(copy: str, ssn: str = SSN) -> list[str]:
    return [
        "Form W-2 Wage and Tax Statement 2025",
        f"Copy {copy}",
        f"a Employee's social security number {ssn}",
        f"b Employer identification number (EIN) {EIN}",
        "c Employer's name, address, and ZIP code",
        "Acme Widgets Inc",
        "100 Industrial Way",
        "Springfield, CA 90210",
        "d Control number 0004471234",
        "e Employee's first name and initial Last name",
        "Sam Example",
        "12 Elm Street Apt 4",
        "Springfield, CA 90211",
        "1 Wages, tips, other compensation 85,120.34",
        "2 Federal income tax withheld 9,876.00",
        "3 Social security wages 104,620.34",
        "4 Social security tax withheld 6,486.46",
        "5 Medicare wages and tips 104,620.34",
        "6 Medicare tax withheld 1,517.00",
        "12a D 19,500.00",
        "X Retirement plan",
        "14 Other CASDI 1,150.82",
        "15 State CA Employer's state ID number 123-4567-8",
        "16 State wages, tips, etc. CA 85,120.34",
        "17 State income tax 4,210.00",
    ]


INT_LINES = [
    "Form 1099-INT Interest Income 2025",
    "PAYER'S name, street address, city or town, state, ZIP code, and telephone no.",
    "First Example Bank",
    "500 Market St",
    "Springfield, IL 62701",
    "(555) 123-4567",
    f"PAYER'S TIN {EIN}",
    "RECIPIENT'S TIN XXX-XX-6789",
    "RECIPIENT'S name",
    "Jordan Doe",
    "77 Oak Avenue",
    "Springfield, IL 62702",
    "Account number (see instructions) 000077314471",
    "1 Interest income 412.07",
    "3 Interest on U.S. Savings Bonds and Treasury obligations 25.00",
    "4 Federal income tax withheld 41.20",
    "Questions? help@firstexample.test",
]

MORTGAGE_LINES = [
    "Form 1098 Mortgage Interest Statement 2025",
    "RECIPIENT'S/LENDER'S name, street address, city or town, state, ZIP code",
    "Example Home Loans",
    "1 Lender Plaza",
    "Dallas, TX 75201",
    "RECIPIENT'S/LENDER'S TIN 98-7654321",
    "PAYER'S/BORROWER'S TIN 987-65-4320",
    "PAYER'S/BORROWER'S name",
    "Alex Example",
    "1 Mortgage interest received from payer(s)/borrower(s) 11,840.22",
    "2 Outstanding mortgage principal 312,450.00",
    "3 Mortgage origination date 06/14/2019",
    "10 Other Property tax 3,250.00",
    "Account number (see instructions) LN-55512340",
]


def pdf(pages: list[list[str]], size: float = 10) -> bytes:
    """One PDF page per list of lines (small type, so three W-2 copies fit on one page)."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    for lines in pages:
        assert len(lines) * (size + 2) < 720, "the lines must fit on one page"
        c.setFont("Helvetica", size)
        y = 760.0
        for line in lines:
            c.drawString(40, y, line)
            y -= size + 2
        c.showPage()
    c.save()
    return buf.getvalue()


def png(lines: list[str]) -> bytes:
    font = ImageFont.load_default(size=30)
    image = Image.new("L", (1700, 80 + 46 * len(lines)), 255)
    draw = ImageDraw.Draw(image)
    for i, line in enumerate(lines):
        draw.text((30, 40 + 46 * i), line, fill=0, font=font)
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def scanned_pdf(lines: list[str]) -> bytes:
    """A PDF holding only a picture of the page: no text layer."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    c.drawImage(ImageReader(io.BytesIO(png(lines))), 20, 100, width=570, height=650)
    c.showPage()
    c.save()
    return buf.getvalue()


def assert_minimized(result: TaxFormTextResult, *names: str) -> None:
    """What leaves the worker: no TIN, no SSN digits, no person's name, no address."""
    text = "\n".join(p["text"] for p in result["pages"])
    # Everything but the identifiers, which are kept apart as last four digits and the issuer's EIN.
    whole = json.dumps([{k: v for k, v in p.items() if k != "identifiers"} for p in result["pages"]])
    assert not re.search(r"\d{3}-\d{2}-\d{4}", whole)
    assert not re.search(r"(?<!\d)\d{9}(?!\d)", whole)
    assert not re.search(r"\d{2}-\d{7}", whole)
    assert "6789" not in text and "4320" not in text
    for name in ("Sam Example", "Alex Example", "Jordan Doe", *names):
        assert name.lower() not in whole.lower()
    for address in ("Elm Street", "Oak Avenue", "Industrial Way", "Market St", "90210", "62702"):
        assert address not in text
    assert "@" not in text and "123-4567" not in text


# ----- Text layers ------------------------------------------------------------------------------------------


def test_a_w2_page_with_three_copies_is_read_once_and_minimized() -> None:
    result = read_tax_form(pdf([w2_copy("B") + w2_copy("C") + w2_copy("2")], size=7), MEMBERS)
    assert result["error"] is None
    assert result["textLayer"] is True and result["ocrEngine"] is None
    page = result["pages"][0]
    assert page["forms"] == [{"kind": "w2", "corrected": False, "taxYear": 2025}]
    assert page["copiesDropped"] == 2
    assert page["text"].count(COPY_NOTE) == 2
    assert page["identifiers"] == {
        "personTinLast4": "6789",
        "issuerEin": "123456789",
        "issuerTinLast4": None,
        "accountLast4": None,
    }
    lines = page["text"].splitlines()
    # The issuer stays; the person is their token; amounts and box labels stay.
    assert "Acme Widgets Inc" in lines
    assert "MEMBER_1" in lines
    assert "1 Wages, tips, other compensation 85,120.34" in lines
    assert "12a D 19,500.00" in lines
    assert "X Retirement plan" in lines
    assert REDACTED in lines
    assert_minimized(result)


def test_1099_int_identifiers_and_masking() -> None:
    result = read_tax_form(pdf([INT_LINES]), MEMBERS)
    page = result["pages"][0]
    assert page["forms"] == [{"kind": "1099_int", "corrected": False, "taxYear": 2025}]
    assert page["identifiers"] == {
        "personTinLast4": "6789",
        "issuerEin": "123456789",
        "issuerTinLast4": None,
        "accountLast4": "4471",
    }
    lines = page["text"].splitlines()
    assert "First Example Bank" in lines
    assert "1 Interest income 412.07" in lines
    assert f"PAYER'S TIN {MASK}" in lines
    assert f"Account number (see instructions) {MASK}" in lines
    assert "000077314471" not in page["text"]
    assert_minimized(result)


def test_1098_labels_say_whose_tin_is_whose() -> None:
    result = read_tax_form(pdf([MORTGAGE_LINES]), MEMBERS)
    page = result["pages"][0]
    assert page["forms"][0]["kind"] == "1098"
    # The lender is RECIPIENT'S/LENDER'S; the borrower PAYER'S/BORROWER'S.
    assert page["identifiers"] == {
        "personTinLast4": "4320",
        "issuerEin": "987654321",
        "issuerTinLast4": None,
        "accountLast4": "2340",
    }
    lines = page["text"].splitlines()
    assert "Example Home Loans" in lines
    assert "MEMBER_2" in lines
    assert "3 Mortgage origination date 06/14/2019" in lines
    assert "98-7654321" not in page["text"]
    assert_minimized(result)


def test_a_sole_proprietor_payer_keeps_only_the_last_four() -> None:
    ids = extract_identifiers(["PAYER'S TIN 555-12-3456", "RECIPIENT'S TIN ***-**-6789"])
    assert ids["issuerTinLast4"] == "3456"
    assert ids["issuerEin"] is None
    assert ids["personTinLast4"] == "6789"


def test_a_row_of_labels_over_a_row_of_values_pairs_them_by_position() -> None:
    ids = extract_identifiers(
        [
            "a Employee's social security number    b Employer identification number (EIN)",
            f"XXX-XX-6789    {EIN}",
        ]
    )
    assert ids["personTinLast4"] == "6789"
    assert ids["issuerEin"] == "123456789"


def test_a_consolidated_1099_names_each_section_on_its_page() -> None:
    page1 = [
        "Sample Brokerage LLC 2025 Consolidated Form 1099",
        f"PAYER'S TIN {EIN}",
        "RECIPIENT'S name: Sam Example",
        "Account 7731-4471",
        "Form 1099-DIV Dividends and Distributions 2025",
        "1a Total ordinary dividends 2,104.55",
        "1b Qualified dividends 1,800.00",
        "Form 1099-INT Interest Income 2025",
        "1 Interest income 18.42",
    ]
    page2 = [
        "Form 1099-B Proceeds From Broker and Barter Exchange Transactions 2025",
        "1d Proceeds 10,000.00",
    ]
    result = read_tax_form(pdf([page1, page2]), MEMBERS)
    assert [f["kind"] for f in result["pages"][0]["forms"]] == ["1099_div", "1099_int"]
    assert [f["kind"] for f in result["pages"][1]["forms"]] == ["other"]
    assert result["pages"][0]["identifiers"]["accountLast4"] == "4471"
    assert "RECIPIENT'S name: MEMBER_1" in result["pages"][0]["text"].splitlines()
    assert result["pageCount"] == 2
    assert_minimized(result)


def test_two_forms_with_the_same_amounts_from_different_payers_are_both_kept() -> None:
    first = ["Form 1099-INT Interest Income 2025", f"PAYER'S TIN {EIN}", "1 Interest income 12.00"]
    second = ["Form 1099-INT Interest Income 2025", "PAYER'S TIN 34-5678901", "1 Interest income 12.00"]
    result = read_tax_form(pdf([first, second]), MEMBERS)
    assert [p["copiesDropped"] for p in result["pages"]] == [0, 0]
    assert [len(p["forms"]) for p in result["pages"]] == [1, 1]


def test_a_copy_on_a_later_page_is_dropped() -> None:
    result = read_tax_form(pdf([w2_copy("B"), w2_copy("C")]), MEMBERS)
    assert [len(p["forms"]) for p in result["pages"]] == [1, 0]
    assert result["pages"][1]["copiesDropped"] == 1


def test_corrected_forms() -> None:
    w2c = ["Form W-2c Corrected Wage and Tax Statement 2025", "1 Wages, tips, other compensation 86,000.00"]
    marked = ["Form 1099-INT Interest Income 2025", "X CORRECTED", "1 Interest income 437.07"]
    above = ["CORRECTED", "Form 1098 Mortgage Interest Statement 2025", "1 Mortgage interest 100.00"]
    unmarked = [
        "VOID CORRECTED (if checked)",
        "Form 1099-DIV Dividends 2025",
        "1a Total ordinary dividends 5.00",
    ]
    result = read_tax_form(pdf([w2c, marked, above, unmarked]), MEMBERS)
    assert [p["forms"][0]["corrected"] for p in result["pages"]] == [True, True, True, False]


def test_names_with_a_title_and_names_above_an_address_are_masked() -> None:
    out = mask_lines(
        [
            "RECIPIENT'S name",
            "Ms Jordan Doe",
            "Form 1099-INT",
            "Casey Q Public",
            "9 Birch Road",
            "Austin, TX 78701",
        ],
        [],
    )
    assert out[1] == REDACTED
    assert out[3] == REDACTED
    assert out[4:] == [REDACTED, REDACTED]


def test_a_member_named_by_first_name_keeps_only_the_token() -> None:
    out = mask_lines(
        ["e Employee's first name and initial Last name", "SAM RIVERA"],
        [{"name": "Sam", "token": "MEMBER_3"}],
    )
    assert out[1] == "MEMBER_3"


def test_members_payload_is_checked() -> None:
    assert members_from([{"name": "Sam", "token": "MEMBER_1"}, {"name": "x", "token": "nope"}, "junk"]) == [
        {"name": "Sam", "token": "MEMBER_1"}
    ]
    assert members_from(None) == []


# ----- Problems come back as results ------------------------------------------------------------------------


def test_files_that_cannot_be_read_are_errors_not_failed_jobs() -> None:
    assert read_tax_form(b"GIF89a....")["error"] == {
        "code": "taxform.unsupported_type",
        "message": "tax forms must be PDF, JPEG, PNG or WebP files",
    }
    corrupt = read_tax_form(b"%PDF-1.4 not really")
    assert corrupt["error"] is not None and corrupt["error"]["code"] == "doc.corrupt"
    assert corrupt["pages"] == []


def test_scans_without_ocr_are_an_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(taxform, "tesseract_available", lambda: False)
    result = read_tax_form(png(["Form W-2"]))
    assert result["error"] is not None and result["error"]["code"] == "taxform.ocr_unavailable"


def test_too_many_pages(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(taxform, "MAX_PAGES", 1)
    result = read_tax_form(pdf([INT_LINES, INT_LINES]))
    assert result["error"] is not None and result["error"]["code"] == "taxform.too_many_pages"


# ----- OCR --------------------------------------------------------------------------------------------------


def test_photos_and_scanned_pdfs_go_through_ocr_and_are_masked(monkeypatch: pytest.MonkeyPatch) -> None:
    pytesseract = pytest.importorskip("pytesseract")
    seen: list[tuple[str, str, int]] = []

    def fake(image: Any, config: str = "", timeout: int = 0) -> str:
        seen.append((config, image.mode, image.width))
        return "\n".join(w2_copy("B")) + "\n\x0c"

    monkeypatch.setattr(taxform, "tesseract_available", lambda: True)
    monkeypatch.setattr(pytesseract, "image_to_string", fake)
    photo = read_tax_form(png(["anything"]), MEMBERS)
    scan = read_tax_form(scanned_pdf(["anything"]), MEMBERS)
    for result in (photo, scan):
        assert result["textLayer"] is False and result["ocrEngine"] == "tesseract"
        assert result["pages"][0]["forms"][0]["kind"] == "w2"
        assert result["pages"][0]["identifiers"]["personTinLast4"] == "6789"
        assert_minimized(result)
    assert all(
        config == "--psm 6" and mode == "L" and width >= taxform.MIN_WIDTH for config, mode, width in seen
    )


@needs_tesseract
def test_a_rendered_w2_photo_is_read_by_tesseract_and_minimized() -> None:
    result = read_tax_form(png(w2_copy("B")), MEMBERS)
    assert result["error"] is None
    page = result["pages"][0]
    assert any(f["kind"] == "w2" for f in page["forms"])
    assert "Wages" in page["text"]
    assert "85,120.34" in page["text"]
    assert_minimized(result)


@needs_tesseract
def test_a_rendered_1099_scan_is_read_by_tesseract_and_minimized() -> None:
    result = read_tax_form(scanned_pdf(INT_LINES), MEMBERS)
    assert result["error"] is None
    assert any(f["kind"] == "1099_int" for f in result["pages"][0]["forms"])
    assert "412.07" in result["pages"][0]["text"]
    assert_minimized(result)


# ----- The queue handler ------------------------------------------------------------------------------------


class _Storage:
    def __init__(self, data: bytes) -> None:
        self.data = data

    def read(self, key: str) -> bytes:
        assert key == "ws/other/form-1"
        return self.data


def test_queue_handler_reads_the_stored_file() -> None:
    assert HANDLERS["taxform.read"] is handle_taxform_read
    result = handle_taxform_read(
        {"storageKey": "ws/other/form-1", "members": MEMBERS},
        _Storage(pdf([INT_LINES])),  # type: ignore[arg-type]
    )
    assert result["kind"] == "taxform_text"
    assert result["pages"][0]["identifiers"]["accountLast4"] == "4471"
    assert_minimized(result)


def test_read_pages_keeps_page_numbers() -> None:
    pages = read_pages(["Form 1099-INT 2025\n1 Interest income 1.00", ""], [])
    assert [p["page"] for p in pages] == [1, 2]
    assert pages[1]["forms"] == []

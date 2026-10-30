from __future__ import annotations

import pytest

from montra_doc_worker.errors import PermanentJobError
from montra_doc_worker.extract_pdf import extract_pdf, is_amount, is_date
from montra_doc_worker.extract_xls import extract_xls, format_number
from montra_doc_worker.result import check_magic

from . import fixtures


def test_xls_cells_are_display_strings() -> None:
    result = extract_xls(fixtures.make_xls())
    assert result["kind"] == "grid"
    assert [s["name"] for s in result["sheets"]] == ["Transactions", "Notes"]
    rows = result["sheets"][0]["rows"]
    assert rows[0] == ["Date", "Description", "Amount", "Balance", "Count"]
    assert rows[1] == ["2026-10-01", "PAYROLL ACME", "3,200.00", "4200.50", "1"]
    assert rows[2] == ["2026-10-03", "SQ *BLUE BOTTLE 0423", "-4.75", "4195.75", "2"]
    assert rows[3] == ["2026-10-05", "AMAZON MKTPLACE", "-1,234.10", "2961.65", "3"]
    assert result["sheets"][1]["rows"] == [["Exported 2026-10-31"]]


@pytest.mark.parametrize(
    ("value", "fmt", "expected"),
    [
        (0.1 + 0.2, None, "0.3"),
        (1234.5, "#,##0.00", "1,234.50"),
        (-0.004, "0.00", "0.00"),
        (0.125, "0%", "13%"),
        (12.0, "General", "12"),
        (2.675, "0.00", "2.68"),
        (1e-7, None, "0.0000001"),
    ],
)
def test_number_formatting_has_no_float_noise(value: float, fmt: str | None, expected: str) -> None:
    assert format_number(value, fmt) == expected


def test_ruled_table_pdf() -> None:
    result = extract_pdf(fixtures.make_ruled_pdf())
    rows = result["sheets"][0]["rows"]
    assert rows[0] == ["Date", "Description", "Amount", "Balance"]
    assert rows[1:] == [
        ["10/02/2026", "COFFEE SHOP", "-4.50", "995.50"],
        ["10/05/2026", "PAYROLL DEPOSIT", "2,000.00", "2,995.50"],
        ["10/09/2026", "ELECTRIC COMPANY AUTOPAY REF 991", "-120.25", "2,875.25"],
        ["10/15/2026", "GROCERY MART", "-1,640.69", "1,234.56"],
    ]
    assert result["statement"] == {
        "openingBalance": "$1,000.00",
        "closingBalance": "$1,234.56",
        "periodStart": "2026-10-01",
        "periodEnd": "2026-10-31",
        "accountLast4": "1234",
        "currency": "USD",
    }
    assert result["pages"] == 1 and result["textLayer"] is True


def test_whitespace_aligned_pdf_with_continuation_and_page_break() -> None:
    result = extract_pdf(fixtures.make_aligned_pdf())
    rows = result["sheets"][0]["rows"]
    assert rows[0] == ["Date", "Description", "Amount", "Balance"]
    assert rows[1:] == [
        ["Oct 03", "SQ *BLUE BOTTLE COFFEE", "-6.25", "493.75"],
        ["Oct 04", "AMAZON MKTPLACE PMTS AMZN.COM/BILL WA", "-58.10", "435.65"],
        ["Oct 07", "SALARY ACME INC", "1,200.00", "1,635.65"],
        ["Oct 21", "CITY WATER UTILITY", "-45.00", "1,590.65"],
        ["Oct 28", "REFUND STORE 22", "10.00", "1,600.65"],
    ]
    st = result["statement"]
    assert st is not None
    assert (st["periodStart"], st["periodEnd"], st["accountLast4"]) == ("2026-10-01", "2026-10-31", "9876")
    assert result["pages"] == 2


def test_debit_credit_pdf_with_balance_lines() -> None:
    result = extract_pdf(fixtures.make_debit_credit_pdf())
    rows = result["sheets"][0]["rows"]
    assert rows[0] == ["Date", "Details", "Debit", "Credit", "Balance"]
    assert rows[1:] == [
        ["01/09/2026", "RENT SEPTEMBER", "1,500.00", "", "500.00"],
        ["15/09/2026", "CLIENT INVOICE 1042", "", "1,400.25", "1,900.25"],
        ["28/09/2026", "BANK FEE", "50.00", "", "1,850.25"],
    ]
    st = result["statement"]
    assert st is not None
    assert (st["openingBalance"], st["closingBalance"]) == ("2,000.00", "1,850.25")
    assert (st["periodStart"], st["periodEnd"], st["accountLast4"]) == ("2026-09-01", "2026-09-30", "4321")


def test_corrupt_inputs_fail_permanently() -> None:
    with pytest.raises(PermanentJobError) as err:
        extract_pdf(b"%PDF-1.7\nthis is not really a pdf")
    assert err.value.code == "doc.corrupt"
    with pytest.raises(PermanentJobError) as err:
        extract_xls(bytes.fromhex("D0CF11E0A1B11AE1") + b"\x00" * 64)
    assert err.value.code == "doc.corrupt"


def test_magic_bytes_must_match_the_declared_type() -> None:
    assert check_magic(fixtures.make_ruled_pdf(), "pdf") == "pdf"
    assert check_magic(fixtures.make_xls(), "xls") == "xls"
    for data, kind in ((fixtures.make_xls(), "pdf"), (fixtures.make_ruled_pdf(), "xls"), (b"x", "csv")):
        with pytest.raises(PermanentJobError):
            check_magic(data, kind)


@pytest.mark.parametrize(
    "token", ["1,234.56", "-4.50", "(12.00)", "$1,000.00", "12.34-", "1.234,56", "45.00 CR"]
)
def test_amount_tokens(token: str) -> None:
    assert is_amount(token)


@pytest.mark.parametrize("token", ["10/02/2026", "10/02", "2026-10-02", "02.10.2026"])
def test_date_tokens(token: str) -> None:
    assert is_date(token)
    assert not is_amount(token)

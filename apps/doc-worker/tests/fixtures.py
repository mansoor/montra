"""Generates statement fixtures at test time (no binaries in the repo)."""

from __future__ import annotations

import datetime as dt
import io

import pdfplumber
import xlwt
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.pdfgen import canvas
from reportlab.platypus import SimpleDocTemplate, Spacer, Table, TableStyle
from reportlab.platypus.para import Paragraph


def make_xls() -> bytes:
    book = xlwt.Workbook()
    sheet = book.add_sheet("Transactions")
    money = xlwt.easyxf(num_format_str="#,##0.00")
    plain = xlwt.easyxf(num_format_str="0.00")
    datefmt = xlwt.easyxf(num_format_str="YYYY-MM-DD")
    sheet.write(0, 0, "Date")
    sheet.write(0, 1, "Description")
    sheet.write(0, 2, "Amount")
    sheet.write(0, 3, "Balance")
    sheet.write(0, 4, "Count")
    rows = [
        (dt.date(2026, 10, 1), "PAYROLL ACME", 3200.0, 4200.5, 1),
        (dt.date(2026, 10, 3), "SQ *BLUE BOTTLE 0423", -4.75, 4195.75, 2),
        (dt.date(2026, 10, 5), "AMAZON MKTPLACE", -1234.1, 2961.65, 3),
    ]
    for i, (d, desc, amt, bal, n) in enumerate(rows, start=1):
        sheet.write(i, 0, d, datefmt)
        sheet.write(i, 1, desc)
        sheet.write(i, 2, amt, money)
        sheet.write(i, 3, bal, plain)
        sheet.write(i, 4, n)
    second = book.add_sheet("Notes")
    second.write(0, 0, "Exported 2026-10-31")
    buf = io.BytesIO()
    book.save(buf)
    return buf.getvalue()


def _header_block(c: canvas.Canvas, lines: list[str], top: float = 750) -> float:
    y = top
    for line in lines:
        c.drawString(50, y, line)
        y -= 14
    return y


def make_ruled_pdf() -> bytes:
    """Layout 1: a ruled table (grid lines), summary text above it."""
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=letter)
    styles = getSampleStyleSheet()
    data = [
        ["Date", "Description", "Amount", "Balance"],
        ["10/02/2026", "COFFEE SHOP", "-4.50", "995.50"],
        ["10/05/2026", "PAYROLL DEPOSIT", "2,000.00", "2,995.50"],
        ["10/09/2026", "ELECTRIC COMPANY", "-120.25", "2,875.25"],
        ["", "AUTOPAY REF 991", "", ""],
        ["10/15/2026", "GROCERY MART", "-1,640.69", "1,234.56"],
    ]
    table = Table(data)
    table.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black)]))
    story = [
        Paragraph("First Example Bank — Checking account ending in 1234", styles["Normal"]),
        Paragraph("Statement period: 10/01/2026 to 10/31/2026", styles["Normal"]),
        Paragraph("Beginning balance $1,000.00", styles["Normal"]),
        Paragraph("Ending balance $1,234.56", styles["Normal"]),
        Spacer(1, 12),
        table,
    ]
    doc.build(story)
    return buf.getvalue()


def make_aligned_pdf() -> bytes:
    """Layout 2: aligned columns, a multi-line description and a page break with a repeated header."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)

    def header(y: float) -> None:
        c.drawString(50, y, "Date")
        c.drawString(120, y, "Description")
        c.drawRightString(450, y, "Amount")
        c.drawRightString(540, y, "Balance")

    def row(y: float, d: str, desc: str, amt: str, bal: str) -> None:
        c.drawString(50, y, d)
        c.drawString(120, y, desc)
        c.drawRightString(450, y, amt)
        c.drawRightString(540, y, bal)

    def furniture(page: int) -> None:
        c.drawString(50, 770, "Second Example Credit Union")
        c.drawString(50, 30, f"Page {page} of 2")

    furniture(1)
    y = _header_block(c, ["Card account ending in 9876", "October 1, 2026 through October 31, 2026"], top=740)
    y -= 10
    header(y)
    y -= 18
    row(y, "Oct 03", "SQ *BLUE BOTTLE COFFEE", "-6.25", "493.75")
    y -= 14
    row(y, "Oct 04", "AMAZON MKTPLACE PMTS", "-58.10", "435.65")
    y -= 14
    c.drawString(120, y, "AMZN.COM/BILL WA")  # continuation line: no date, no amount
    y -= 14
    row(y, "Oct 07", "SALARY ACME INC", "1,200.00", "1,635.65")
    c.showPage()
    furniture(2)
    y = 720
    header(y)
    y -= 18
    row(y, "Oct 21", "CITY WATER UTILITY", "-45.00", "1,590.65")
    y -= 14
    row(y, "Oct 28", "REFUND STORE 22", "10.00", "1,600.65")
    c.showPage()
    c.save()
    return buf.getvalue()


def make_debit_credit_pdf() -> bytes:
    """Layout 3: separate Debit and Credit columns with Beginning/Ending balance lines."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    y = _header_block(c, ["Third Bank plc", "Account number ****4321", "Period: 2026-09-01 - 2026-09-30"])
    y -= 10
    cols = [
        (50, "Date", False),
        (130, "Details", False),
        (420, "Debit", True),
        (490, "Credit", True),
        (560, "Balance", True),
    ]
    for x, label, right in cols:
        (c.drawRightString if right else c.drawString)(x, y, label)
    y -= 18

    def line(values: list[str]) -> None:
        nonlocal y
        for (x, _, right), v in zip(cols, values, strict=True):
            if v:
                (c.drawRightString if right else c.drawString)(x, y, v)
        y -= 14

    c.drawString(130, y, "Beginning balance")
    c.drawRightString(560, y, "2,000.00")
    y -= 14
    line(["01/09/2026", "RENT SEPTEMBER", "1,500.00", "", "500.00"])
    line(["15/09/2026", "CLIENT INVOICE 1042", "", "1,400.25", "1,900.25"])
    line(["28/09/2026", "BANK FEE", "50.00", "", "1,850.25"])
    c.drawString(130, y, "Ending balance")
    c.drawRightString(560, y, "1,850.25")
    c.showPage()
    c.save()
    return buf.getvalue()


def make_scanned_like_pdf() -> bytes:
    """A PDF with no text layer (only drawn shapes), standing in for a scan."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    c.rect(50, 50, 500, 700)
    c.line(60, 700, 540, 700)
    c.showPage()
    c.save()
    return buf.getvalue()


# Layout 4 (synthetic; every name and number is invented): DATE | DESCRIPTION | AMOUNT | BALANCE, dates
# printed without a year, amounts right-aligned under their headers, and descriptions long enough to end just
# left of the Amount column. The period runs from December into January.
YEARLESS_ROWS = [
    ("12/28", "So Cal Power CO Directpay PPD ID: 0012345678", "-207.92", "8,461.51"),
    ("12/28", "Example Card Autopay Payment 271234567 ID: Examplecap", "-130.00", "8,331.51"),
    (
        "12/29",
        "ATM Withdrawal 12/28 12345 Sample Canyon Rd 4321 R Springfield CA Card",
        "-260.00",
        "8,071.51",
    ),
    ("01/02", "Zelle Payment To Sample Person Jpm99abc123", "-3,198.04", "4,873.47"),
    ("01/03", "Zelle Payment From Another Person", "3,300.00", "8,173.47"),
]


def make_yearless_pdf() -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    c.setFont("Helvetica", 9)
    y = _header_block(
        c,
        [
            "Example National Bank",
            "December 15, 2026 through January 14, 2027",
            "Primary Account: 000000005678",
            "Beginning Balance $8,669.43",
            "Ending Balance $8,173.47",
        ],
    )
    y -= 10
    c.drawString(50, y, "TRANSACTION DETAIL")
    y -= 16
    c.drawString(50, y, "DATE")
    c.drawString(90, y, "DESCRIPTION")
    c.drawRightString(470, y, "AMOUNT")
    c.drawRightString(560, y, "BALANCE")
    y -= 14
    c.drawString(90, y, "Beginning Balance")
    c.drawRightString(560, y, "$8,669.43")
    for d, desc, amt, bal in YEARLESS_ROWS:
        y -= 12
        c.drawString(50, y, d)
        c.drawString(90, y, desc)
        c.drawRightString(470, y, amt)
        c.drawRightString(560, y, bal)
    y -= 12
    c.drawString(90, y, "Ending Balance")
    c.drawRightString(560, y, "$8,173.47")
    c.showPage()
    c.save()
    return buf.getvalue()


SCANNED_STATEMENT_LINES = [
    "First Example Bank",
    "JANE Q DOE",
    "123 Elm Street",
    "Springfield, IL 62704",
    "Checking account ending in 6789",
    "Account number 000123456789",
    "Customer service 1-800-555-0199 or help@examplebank.com",
    "Statement period: 10/01/2026 to 10/31/2026",
    "Beginning balance $1,000.00",
    "Ending balance $1,234.56",
    "",
    "Date        Description            Amount      Balance",
    "10/02/2026  COFFEE SHOP             -4.50       995.50",
    "10/05/2026  PAYROLL DEPOSIT      2,000.00     2,995.50",
    "10/09/2026  ELECTRIC COMPANY      -120.25     2,875.25",
    "10/15/2026  GROCERY MART        -1,640.69     1,234.56",
]


def make_scanned_statement_pdf(dpi: int = 200) -> bytes:
    """A statement rendered to an image and wrapped in a PDF: no text layer, like a scan."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    c.setFont("Courier", 11)
    y = 740.0
    for line in SCANNED_STATEMENT_LINES:
        c.drawString(50, y, line)
        y -= 18
    c.showPage()
    c.save()
    with pdfplumber.open(io.BytesIO(buf.getvalue())) as pdf:
        image = pdf.pages[0].to_image(resolution=dpi).original.convert("L")
    out = io.BytesIO()
    image.save(out, "PDF", resolution=float(dpi))
    return out.getvalue()

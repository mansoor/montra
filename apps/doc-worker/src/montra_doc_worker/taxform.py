"""Tax forms received (ADR-0052 §6, TAX-08): `taxform.read` reads a W-2, 1099 or 1098 file into masked text.

The text comes from the PDF's text layer, else OCR (Tesseract in block mode, as scanned statements are read).
In this process, before any text leaves it:

- the form titles are found per page ("Form W-2", "W-2c", "1099-INT", "1099-DIV", "Form 1098", other 1099
  sections), with their year and whether the form is CORRECTED;
- copies of the same form (a W-2 page often carries copies B, C and 2) are dropped, so each is read once;
- the identifiers are extracted: the person's SSN (full or truncated) to its last four digits, the issuer's
  EIN, an SSN-shaped issuer TIN to its last four, and the account number to its last four. Labels decide whose
  TIN is whose (``Employee's social security number``, ``PAYER'S TIN``, ``RECIPIENT'S/LENDER'S TIN`` …);
  without one, an EIN shape is the issuer's and an SSN shape the person's;
- the text is masked: family members' names become their ``MEMBER_n`` tokens, every TIN and account number
  is masked, then digit runs, emails and phones (``redact_line``), address lines, and the person's name lines
  (after the person's label, or above an address).

It returns the masked text and the identifiers per page, never the raw text: the full SSN never leaves this
process and isn't stored in the job's result. A file that can't be read (corrupt, no text, OCR missing) is a
result with an ``error``, so the Node job that follows still runs and puts the form in Review to be typed in.
"""

from __future__ import annotations

import io
import re
from collections.abc import Sequence
from typing import Any, Literal, TypedDict

from .errors import PermanentJobError
from .ocr import tesseract_available
from .redact import (
    CA_POSTCODE_RE,
    EU_POSTCODE_CITY_RE,
    EU_STREET_RE,
    MASK,
    PO_BOX_RE,
    REDACTED,
    STREET_RE,
    TITLE_RE,
    UK_POSTCODE_RE,
    US_CITY_ZIP_RE,
    redact_line,
)

MAX_PAGES = 40
RESOLUTION = 300
MIN_WIDTH = 1600
PAGE_TIMEOUT_SECONDS = 120
TESSERACT_CONFIG = "--psm 6"
MIN_TEXT_CHARS = 40
COPY_NOTE = "[a copy of a form above, left out]"

Kind = Literal["w2", "1099_int", "1099_div", "1098", "other"]


class Member(TypedDict):
    name: str
    token: str


class TaxFormTitle(TypedDict):
    kind: Kind
    corrected: bool
    taxYear: int | None


class TaxFormIdentifiers(TypedDict):
    personTinLast4: str | None
    issuerEin: str | None
    issuerTinLast4: str | None
    accountLast4: str | None


class TaxFormPage(TypedDict):
    page: int
    text: str
    forms: list[TaxFormTitle]
    copiesDropped: int
    identifiers: TaxFormIdentifiers


class TaxFormError(TypedDict):
    code: str
    message: str


class TaxFormTextResult(TypedDict):
    kind: Literal["taxform_text"]
    pages: list[TaxFormPage]
    pageCount: int
    textLayer: bool
    ocrEngine: Literal["tesseract"] | None
    error: TaxFormError | None


# ----- Titles -----------------------------------------------------------------------------------------------

TITLES: list[tuple[re.Pattern[str], Kind, bool]] = [
    (re.compile(r"\bW-2c\b", re.I), "w2", True),
    (re.compile(r"\bForm\s+W-2\b|\bW-2\s+Wage\s+and\s+Tax\s+Statement\b", re.I), "w2", False),
    (re.compile(r"\b1099-INT\b", re.I), "1099_int", False),
    (re.compile(r"\b1099-DIV\b", re.I), "1099_div", False),
    (re.compile(r"\b1099-(?:B|MISC|NEC|R|K|OID|G)\b", re.I), "other", False),
    (re.compile(r"\bForm\s+1098(?![-\w])", re.I), "1098", False),
]
YEAR_RE = re.compile(r"(?<![\d-])(20\d{2})(?![\d-])")
CORRECTED_RE = re.compile(r"^\s*(?:(?:X|☒|\[x\])\s*)?CORRECTED\s*$|^\s*(?:X|☒|\[x\])\s+CORRECTED\b", re.I)
AMOUNT_RE = re.compile(r"\d[\d,]*\.\d{2}\b")


def title_of(line: str) -> tuple[Kind, bool] | None:
    for pattern, kind, corrected in TITLES:
        if pattern.search(line):
            return kind, corrected
    return None


# ----- Identifiers ------------------------------------------------------------------------------------------

SSN_FULL_RE = re.compile(r"(?<![\d-])(\d{3})[- ](\d{2})[- ](\d{4})(?![\d-])")
SSN_TRUNCATED_RE = re.compile(r"(?<![\w*•])(?:[X*•]{3}[- ]?[X*•]{2}[- ]?|[X*•]{5})(\d{4})(?!\d)", re.I)
EIN_RE = re.compile(r"(?<![\d-])(\d{2})-(\d{7})(?![\d-])")
NINE_DIGITS_RE = re.compile(r"(?<![\d-])\d{9}(?![\d-])")

# One TIN label each; the combined 1098 labels first ("PAYER'S/BORROWER'S TIN" is the borrower's).
_Q = r"[’'`]?"
TIN_LABEL_RE = re.compile(
    rf"(?:payer|recipient){_Q}s?\s*/\s*(?:lender|borrower){_Q}s?\s+(?:tin|federal\s+identification|identification)"
    rf"|(?:payer|recipient|lender|borrower|filer){_Q}s?\s+(?:federal\s+)?(?:tin|identification\s+(?:number|no))"
    rf"|employer\s+identification\s+number|\bEIN\b"
    rf"|employee{_Q}s?\s+social\s+security\s+(?:number|no)|\bSSN\b",
    re.I,
)
ACCOUNT_LABEL_RE = re.compile(
    r"\b(?:account|acct)\s*(?:number|no\.?|#)?(?:\s*\(see\s+instructions\))?\s*[:#]?", re.I
)
BOX_LINE_RE = re.compile(r"^\s*\d{1,2}[a-f]?\s+[A-Za-z]")


def _role(label: str) -> Literal["person", "issuer"] | None:
    """Whose TIN a label names."""
    t = label.lower().replace("’", "'")
    if "borrower" in t:
        return "person"
    if "lender" in t or "employer identification" in t or re.search(r"\bein\b", t) or "filer" in t:
        return "issuer"
    if "employee" in t or "social security" in t or re.search(r"\bssn\b", t) or "recipient" in t:
        return "person"
    if "payer" in t:
        return "issuer"
    return None


class _Tin:
    def __init__(
        self, start: int, end: int, shape: Literal["ssn", "ein", "nine"], last4: str, ein: str | None
    ):
        self.start, self.end, self.shape, self.last4, self.ein = start, end, shape, last4, ein


def _tins(line: str) -> list[_Tin]:
    found: list[_Tin] = []
    for m in SSN_FULL_RE.finditer(line):
        found.append(_Tin(m.start(), m.end(), "ssn", m.group(3), None))
    for m in SSN_TRUNCATED_RE.finditer(line):
        found.append(_Tin(m.start(), m.end(), "ssn", m.group(1), None))
    for m in EIN_RE.finditer(line):
        found.append(_Tin(m.start(), m.end(), "ein", m.group(2)[-4:], m.group(1) + m.group(2)))
    for m in NINE_DIGITS_RE.finditer(line):
        found.append(_Tin(m.start(), m.end(), "nine", m.group(0)[-4:], None))
    found.sort(key=lambda t: t.start)
    out: list[_Tin] = []
    for t in found:  # overlapping shapes: the first one wins
        if not out or t.start >= out[-1].end:
            out.append(t)
    return out


def extract_identifiers(lines: Sequence[str]) -> TaxFormIdentifiers:
    """The person's last four, the issuer's EIN (or last four), and the account's last four, from one page."""
    ids: TaxFormIdentifiers = {
        "personTinLast4": None,
        "issuerEin": None,
        "issuerTinLast4": None,
        "accountLast4": None,
    }
    for i, line in enumerate(lines):
        tins = _tins(line)
        if tins:
            here = list(TIN_LABEL_RE.finditer(line))
            above = list(TIN_LABEL_RE.finditer(lines[i - 1])) if i > 0 else []
            for k, tin in enumerate(tins):
                before = [m for m in here if m.end() <= tin.start]
                if before:
                    role = _role(before[-1].group(0))
                elif len(above) == len(tins):  # a row of labels over a row of values: by position
                    role = _role(above[k].group(0))
                elif len(above) == 1:
                    role = _role(above[0].group(0))
                else:
                    role = None
                if role is None:
                    role = "issuer" if tin.shape == "ein" else "person" if tin.shape == "ssn" else None
                if role == "person" and tin.shape != "ein" and ids["personTinLast4"] is None:
                    ids["personTinLast4"] = tin.last4
                elif role == "issuer" and ids["issuerEin"] is None and ids["issuerTinLast4"] is None:
                    if tin.shape == "ein":
                        ids["issuerEin"] = tin.ein
                    elif tin.shape == "ssn":
                        ids["issuerTinLast4"] = tin.last4
        if ids["accountLast4"] is None:
            ids["accountLast4"] = _account_last4(lines, i)
    return ids


def _account_last4(lines: Sequence[str], i: int) -> str | None:
    m = ACCOUNT_LABEL_RE.search(lines[i])
    if not m or BOX_LINE_RE.match(lines[i]):
        return None
    value = lines[i][m.end() :].strip()
    if not value and i + 1 < len(lines):
        nxt = lines[i + 1].strip()
        if not BOX_LINE_RE.match(nxt) and not AMOUNT_RE.search(nxt):
            value = nxt
    token = value.split()[0] if value.split() else ""
    if any(t.shape != "nine" for t in _tins(token)):  # a TIN printed next to the label is not the account
        return None
    digits = re.sub(r"\D", "", token)
    return digits[-4:] if len(digits) >= 4 else None


# ----- Masking ----------------------------------------------------------------------------------------------

PERSON_LABEL_RE = re.compile(
    rf"employee{_Q}s?\s+(?:first\s+)?name|recipient{_Q}s?\s+name|borrower{_Q}s?\s+name|payer{_Q}s?/borrower",
    re.I,
)
ISSUER_LABEL_RE = re.compile(rf"(?:employer|payer|lender){_Q}s?\s+name", re.I)
TOKEN_RE = re.compile(r"\bMEMBER_\d{1,3}\b")
NAME_LINE_RE = re.compile(r"^\s*[A-Za-z][A-Za-z.'’-]*(?:\s+(?:&\s+)?[A-Za-z][A-Za-z.'’-]*){0,4}\s*$")
# Words that make a line a business, a label or a heading, not a person's name.
NOT_A_PERSON = re.compile(
    r"\b(?:inc|corp|corporation|co|company|llc|llp|lp|ltd|bank|n\.?a|trust|credit|union|financial|mortgage|loans?|"
    r"securities|brokerage|investments?|capital|services|savings|federal|treasury|payroll|group|holdings|"
    r"form|copy|statement|wage|wages|tax|interest|dividends?|income|corrected|void|omb|department|internal|revenue|"
    r"service|instructions|employee|employer|recipient|payer|lender|borrower|account|number|name|address|box|"
    r"state|local|city|zip|total|other|page|summary|consolidated)\b",
    re.I,
)


def pseudonymize(line: str, members: Sequence[Member]) -> str:
    """Family members' names (whole words, any case) as their tokens; longer names first."""
    for m in sorted(members, key=lambda x: len(x["name"]), reverse=True):
        name = m["name"].strip()
        if name:
            line = re.sub(rf"(?<!\w){re.escape(name)}(?!\w)", m["token"], line, flags=re.I)
    return line


def mask_identifiers(line: str) -> str:
    """Every TIN shape, and an account number after its label."""
    for t in reversed(_tins(line)):
        line = line[: t.start] + MASK + line[t.end :]
    m = ACCOUNT_LABEL_RE.search(line)
    if m and not BOX_LINE_RE.match(line):
        rest = line[m.end() :]
        value = re.match(r"\s*(\S+)", rest)
        if value and re.search(r"\d", value.group(1)):
            line = line[: m.end()] + rest[: value.start(1)] + MASK + rest[value.end(1) :]
    return line


def _is_address(line: str) -> bool:
    text = line.strip()
    if not text or AMOUNT_RE.search(text):
        return False
    return bool(
        STREET_RE.search(text)
        or EU_STREET_RE.search(text)
        or PO_BOX_RE.search(text)
        or US_CITY_ZIP_RE.search(text)
        or UK_POSTCODE_RE.search(text)
        or CA_POSTCODE_RE.search(text)
        or EU_POSTCODE_CITY_RE.match(text)
    )


def _looks_like_person(line: str) -> bool:
    text = line.strip()
    return bool(text) and bool(NAME_LINE_RE.match(text)) and not NOT_A_PERSON.search(text)


def _person_line(line: str) -> str:
    """A person's name line: only its tokens survive."""
    tokens = TOKEN_RE.findall(line)
    return " ".join(dict.fromkeys(tokens)) if tokens else REDACTED


def mask_lines(lines: Sequence[str], members: Sequence[Member]) -> list[str]:
    """Masks one page's kept lines (see the module's docstring)."""
    out = [redact_line(mask_identifiers(pseudonymize(line, members))) for line in lines]
    address = {i for i, line in enumerate(lines) if _is_address(line)}
    after_issuer = {i + 1 for i, line in enumerate(lines) if ISSUER_LABEL_RE.search(line) and ":" not in line}
    person: set[int] = set()
    for i, line in enumerate(lines):
        label = PERSON_LABEL_RE.search(line)
        if label:
            # "RECIPIENT'S name: Jane Doe" on one line, or the next line or two.
            head, colon, tail = out[i].partition(":")
            if colon and tail.strip() and PERSON_LABEL_RE.search(head):
                out[i] = f"{head}: {_person_line(tail)}"
            else:
                j, taken = i + 1, 0
                while j < len(lines) and taken < 2:
                    nxt = lines[j].strip()
                    if not nxt:
                        j += 1
                        continue
                    if BOX_LINE_RE.match(nxt) or AMOUNT_RE.search(nxt) or TIN_LABEL_RE.search(nxt):
                        break
                    if j in address or not (_looks_like_person(out[j]) or TOKEN_RE.search(out[j])):
                        break
                    person.add(j)
                    taken += 1
                    j += 1
        if TITLE_RE.match(line):
            person.add(i)
    # A name just above an address block ("JANE Q DOE / 12 Elm St / …"), unless it's the issuer's.
    for i in sorted(address):
        if i - 1 in address:
            continue
        j, names = i - 1, 0
        while j >= 0 and names < 2 and j not in after_issuer and _looks_like_person(out[j]):
            person.add(j)
            names += 1
            j -= 1
    for i in person:
        out[i] = _person_line(out[i])
    for i in address:
        out[i] = REDACTED
    return out


# ----- Copies -----------------------------------------------------------------------------------------------


class _Chunk:
    def __init__(self, lines: list[str], title: tuple[Kind, bool] | None, year: int | None) -> None:
        self.lines = lines
        self.title = title
        self.year = year

    def fingerprint(self) -> tuple[str, tuple[str, ...], tuple[str, ...]] | None:
        """The form's kind, amounts and TINs: copies B, C and 2 share them; forms from two issuers don't."""
        amounts = tuple(sorted(AMOUNT_RE.findall("\n".join(self.lines))))
        if self.title is None or not amounts:
            return None
        tins = tuple(sorted(t.last4 for line in self.lines for t in _tins(line)))
        return self.title[0], amounts, tins


def _chunks(lines: list[str]) -> list[_Chunk]:
    """A page split at its form titles; the lines before the first title are the page's header."""
    chunks = [_Chunk([], None, None)]
    for idx, line in enumerate(lines):
        title = title_of(line)
        current = chunks[-1]
        same_heading = (
            current.title is not None
            and title is not None
            and current.title[0] == title[0]
            and not any(BOX_LINE_RE.match(x) for x in current.lines)
        )
        if title and not same_heading:
            year = YEAR_RE.search(line) or (YEAR_RE.search(lines[idx + 1]) if idx + 1 < len(lines) else None)
            chunks.append(_Chunk([line], title, int(year.group(1)) if year else None))
        else:
            current.lines.append(line)
            if title and current.title and title[1]:
                current.title = (current.title[0], True)
    return chunks


def read_pages(texts: Sequence[str], members: Sequence[Member]) -> list[TaxFormPage]:
    """Titles, copies, identifiers and masking for each page's raw text."""
    seen: set[tuple[str, tuple[str, ...], tuple[str, ...]]] = set()
    pages: list[TaxFormPage] = []
    for n, text in enumerate(texts, start=1):
        lines = [line.rstrip() for line in text.splitlines() if line.strip()]
        identifiers = extract_identifiers(lines)
        kept: list[str] = []
        forms: list[TaxFormTitle] = []
        dropped = 0
        for chunk in _chunks(lines):
            fp = chunk.fingerprint()
            if fp is not None and fp in seen:
                dropped += 1
                kept.append(COPY_NOTE)
                continue
            if fp is not None:
                seen.add(fp)
            if chunk.title is not None:
                corrected = chunk.title[1] or any(CORRECTED_RE.match(x) for x in chunk.lines)
                forms.append({"kind": chunk.title[0], "corrected": corrected, "taxYear": chunk.year})
            kept.extend(chunk.lines)
        # A CORRECTED mark printed above the title belongs to the page's first form.
        if forms and any(CORRECTED_RE.match(x) for x in _chunks(lines)[0].lines):
            forms[0]["corrected"] = True
        pages.append(
            {
                "page": n,
                "text": "\n".join(mask_lines(kept, members)),
                "forms": forms,
                "copiesDropped": dropped,
                "identifiers": identifiers,
            }
        )
    return pages


# ----- Reading the file -------------------------------------------------------------------------------------


def _sniff(data: bytes) -> Literal["pdf", "image"]:
    if b"%PDF-" in data[:1024]:
        return "pdf"
    if data.startswith((b"\xff\xd8\xff", b"\x89PNG\r\n\x1a\n")) or (
        data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    ):
        return "image"
    raise PermanentJobError("taxform.unsupported_type", "tax forms must be PDF, JPEG, PNG or WebP files")


def _tesseract(image: Any) -> str:
    if not tesseract_available():
        raise PermanentJobError(
            "taxform.ocr_unavailable", "Reading scanned forms needs OCR, which isn't installed"
        )
    import pytesseract

    try:
        text = pytesseract.image_to_string(image, config=TESSERACT_CONFIG, timeout=PAGE_TIMEOUT_SECONDS)
    except RuntimeError as exc:  # pytesseract raises RuntimeError on timeout
        raise PermanentJobError("taxform.ocr_failed", f"OCR timed out: {exc}") from exc
    except pytesseract.TesseractError as exc:
        raise PermanentJobError("taxform.ocr_failed", f"OCR failed: {exc}") from exc
    return _tidy(str(text))


def _prepare(image: Any) -> Any:
    from PIL import Image

    image = image.convert("L")
    if image.width < MIN_WIDTH:
        scale = MIN_WIDTH / image.width
        image = image.resize((MIN_WIDTH, max(1, int(image.height * scale))), Image.Resampling.LANCZOS)
    return image


def _tidy(text: str) -> str:
    lines = [line.rstrip() for line in text.replace("\x0c", "").splitlines()]
    return "\n".join(line for line in lines if line.strip())


def raw_pages(data: bytes) -> tuple[list[str], bool]:
    """Text per page: the PDF's text layer, else OCR. Returns (pages, text_layer)."""
    if _sniff(data) == "image":
        from PIL import Image, ImageOps, UnidentifiedImageError

        try:
            image = ImageOps.exif_transpose(Image.open(io.BytesIO(data)))
        except (UnidentifiedImageError, OSError) as exc:
            raise PermanentJobError("doc.corrupt", f"could not open the image: {exc}") from exc
        return [_tesseract(_prepare(image))], False

    import pdfplumber

    try:
        pdf = pdfplumber.open(io.BytesIO(data))
    except Exception as exc:
        raise PermanentJobError("doc.corrupt", f"could not open the PDF: {exc}") from exc
    with pdf:
        if len(pdf.pages) > MAX_PAGES:
            raise PermanentJobError(
                "taxform.too_many_pages", f"tax form files are limited to {MAX_PAGES} pages"
            )
        layer = [_tidy(page.extract_text() or "") for page in pdf.pages]
        if sum(len(re.sub(r"\s", "", t)) for t in layer) >= MIN_TEXT_CHARS * max(1, len(layer)) // 2:
            return layer, True
        texts: list[str] = []
        for page in pdf.pages:
            try:
                image = page.to_image(resolution=RESOLUTION).original
            except Exception as exc:
                raise PermanentJobError("doc.corrupt", f"could not render a PDF page: {exc}") from exc
            texts.append(_tesseract(_prepare(image)))
        return texts, False


def read_tax_form(data: bytes, members: Sequence[Member] = ()) -> TaxFormTextResult:
    """Reads a tax form file. Problems with the file itself come back as `error`, with no pages."""
    try:
        texts, text_layer = raw_pages(data)
        if sum(len(re.sub(r"\s", "", t)) for t in texts) == 0:
            raise PermanentJobError("taxform.empty", "no text could be read from this file")
    except PermanentJobError as exc:
        return {
            "kind": "taxform_text",
            "pages": [],
            "pageCount": 0,
            "textLayer": False,
            "ocrEngine": None,
            "error": {"code": exc.code, "message": exc.detail or exc.code},
        }
    return {
        "kind": "taxform_text",
        "pages": read_pages(texts, members),
        "pageCount": len(texts),
        "textLayer": text_layer,
        "ocrEngine": None if text_layer else "tesseract",
        "error": None,
    }


def members_from(payload: object) -> list[Member]:
    """The job's member names and tokens; anything malformed is left out."""
    if not isinstance(payload, list):
        return []
    out: list[Member] = []
    for m in payload[:100]:
        if isinstance(m, dict):
            name, token = m.get("name"), m.get("token")
            if isinstance(name, str) and isinstance(token, str) and re.fullmatch(r"MEMBER_\d{1,3}", token):
                out.append({"name": name[:200], "token": token})
    return out

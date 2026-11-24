/**
 * The files attached inside a PDF (its EmbeddedFiles name tree), as a rendered statement carries its original
 * (ADR-0057 §2, §7). `FileBytes` reads an original back from the PDF the vault filed with it inside.
 */
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFString,
} from 'pdf-lib';

export interface PdfAttachment {
  name: string;
  bytes: Uint8Array;
  mime: string | null;
}

/** Every file attached inside `bytes`, in the order the PDF lists them. A PDF with none answers an empty list. */
export async function pdfAttachments(bytes: Uint8Array): Promise<PdfAttachment[]> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const names = pdf.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const tree = names?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
  const list = tree?.lookupMaybe(PDFName.of('Names'), PDFArray);
  const out: PdfAttachment[] = [];
  if (!list) return out;
  for (let i = 0; i + 1 < list.size(); i += 2) {
    const name = list.lookup(i) as PDFString | PDFHexString;
    const spec = list.lookup(i + 1, PDFDict);
    const ef = spec.lookup(PDFName.of('EF'), PDFDict);
    const stream = ef.lookup(PDFName.of('F'));
    if (!(stream instanceof PDFRawStream)) continue;
    const subtype = stream.dict.get(PDFName.of('Subtype'));
    out.push({
      name: name.decodeText(),
      bytes: decodePDFRawStream(stream).decode(),
      mime: subtype instanceof PDFName ? subtype.decodeText() : null,
    });
  }
  return out;
}

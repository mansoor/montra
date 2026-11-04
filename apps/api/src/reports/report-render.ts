/**
 * A report as a file (RPT-04): CSV, XLSX or PDF, from the one report shape. Pure: data in, bytes out. Text a spreadsheet would run as a
 * formula is neutralized, since payees come from bank statements. The standard PDF fonts cover Latin text, as with invoices.
 */
import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { asCurrencyCode, formatMoney, money, toDecimalString } from '@montra/domain';
import { catalogs } from '@montra/i18n';
import type { ReportColumnDto, ReportDto, ReportExportFormat } from '@montra/schemas';

const en = catalogs.en as Record<string, string>;
export const columnLabel = (key: string) => en[`reports.col.${key}`] ?? key;
export const reportTitle = (type: string) => en[`reports.type.${type}`] ?? type;
const noteText = (key: string) => en[`reports.note.${key}`] ?? key;

export interface RenderedFile {
  bytes: Uint8Array;
  mime: string;
  fileName: string;
}

const safeText = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);
const csvCell = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const words = (text: string) => en[`reports.section.${text}`] ?? text;

/** A cell as plain text. Machine formats keep plain decimals; `display` adds the separators a reader expects. */
function cellText(
  column: ReportColumnDto,
  value: string | null | undefined,
  currency: string,
  display: boolean,
): string {
  if (value === null || value === undefined) return '';
  switch (column.kind) {
    case 'money': {
      const m = money(BigInt(value), asCurrencyCode(currency));
      return display ? formatMoney(m, { locale: 'en-US' }) : toDecimalString(m);
    }
    case 'percent':
      return `${value}%`;
    case 'text':
      return safeText(words(value));
    default:
      return value;
  }
}

function table(report: ReportDto, display: boolean): string[][] {
  const out = report.rows.map((r) =>
    report.columns.map((c) => cellText(c, r.cells[c.key], report.currency, display)),
  );
  if (report.totals) {
    out.push(report.columns.map((c) => cellText(c, report.totals![c.key], report.currency, display)));
  }
  return out;
}

export function reportToCsv(report: ReportDto): string {
  const header = report.columns.map((c) => columnLabel(c.key));
  return [header, ...table(report, false)].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export async function reportToXlsx(report: ReportDto): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(reportTitle(report.type).slice(0, 31));
  sheet.addRow(report.columns.map((c) => columnLabel(c.key)));
  sheet.getRow(1).font = { bold: true };
  const moneyColumns = report.columns.map((c) => c.kind === 'money');
  const addRow = (cells: Record<string, string | null>, bold: boolean) => {
    const added = sheet.addRow(
      report.columns.map((c, i) => {
        const v = cells[c.key];
        if (v === null || v === undefined) return null;
        // Real numbers, so a spreadsheet can add them up. Display only: the exact minor units stay in the CSV.
        if (moneyColumns[i])
          return Number(toDecimalString(money(BigInt(v), asCurrencyCode(report.currency))));
        return cellText(c, v, report.currency, false);
      }),
    );
    if (bold) added.font = { bold: true };
  };
  for (const r of report.rows) addRow(r.cells, r.emphasis);
  if (report.totals) addRow(report.totals, true);
  report.columns.forEach((c, i) => {
    sheet.getColumn(i + 1).width = c.kind === 'text' ? 36 : 14;
    if (c.kind === 'money') sheet.getColumn(i + 1).numFmt = '#,##0.00';
  });
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/** Keeps what the standard fonts can print; anything else prints as "?" rather than failing the export. */
const printable = (s: string) => s.replace(/[^\x20-\x7e\xa0-\xff]/g, '?');

function fit(text: string, font: PDFFont, size: number, width: number): string {
  const clean = printable(text);
  if (font.widthOfTextAtSize(clean, size) <= width) return clean;
  let cut = clean;
  while (cut.length > 1 && font.widthOfTextAtSize(`${cut}...`, size) > width) cut = cut.slice(0, -1);
  return `${cut}...`;
}

export async function reportToPdf(report: ReportDto, subtitle: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const wide = report.columns.length > 4;
  const [W, H]: [number, number] = wide ? [792, 612] : [612, 792];
  const margin = 40;
  const size = 9;
  const lineHeight = 14;
  const textWeights = report.columns.map((c) => (c.kind === 'text' ? 3 : 1.3));
  const weightSum = textWeights.reduce((a, b) => a + b, 0);
  const widths = textWeights.map((w) => ((W - margin * 2) * w) / weightSum);
  const xs = widths.map((_, i) => margin + widths.slice(0, i).reduce((a, b) => a + b, 0));
  let page: PDFPage;
  let y = 0;
  const drawRow = (cells: string[], font: PDFFont) => {
    report.columns.forEach((c, i) => {
      const text = fit(cells[i] ?? '', font, size, widths[i]! - 6);
      const x =
        c.kind === 'text' || c.kind === 'date'
          ? xs[i]!
          : xs[i]! + widths[i]! - 6 - font.widthOfTextAtSize(text, size);
      page.drawText(text, { x, y, size, font, color: rgb(0.1, 0.1, 0.1) });
    });
    y -= lineHeight;
  };
  const newPage = (first: boolean) => {
    page = doc.addPage([W, H]);
    y = H - margin;
    if (first) {
      page.drawText(printable(reportTitle(report.type)), { x: margin, y, size: 16, font: bold });
      y -= 18;
      page.drawText(printable(subtitle), {
        x: margin,
        y,
        size: 9,
        font: regular,
        color: rgb(0.35, 0.35, 0.35),
      });
      y -= 22;
    }
    drawRow(
      report.columns.map((c) => columnLabel(c.key)),
      bold,
    );
    page.drawLine({
      start: { x: margin, y: y + 10 },
      end: { x: W - margin, y: y + 10 },
      thickness: 0.5,
      color: rgb(0.7, 0.7, 0.7),
    });
  };
  newPage(true);
  const rows = table(report, true);
  rows.forEach((cells, i) => {
    if (y < margin + lineHeight) newPage(false);
    const isTotal = report.totals !== null && i === rows.length - 1;
    drawRow(cells, isTotal || report.rows[i]?.emphasis ? bold : regular);
  });
  for (const note of report.notes) {
    if (y < margin + lineHeight) newPage(false);
    y -= 4;
    page!.drawText(fit(noteText(note), regular, 8, W - margin * 2), {
      x: margin,
      y,
      size: 8,
      font: regular,
      color: rgb(0.35, 0.35, 0.35),
    });
    y -= 10;
  }
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawText(`Montra - ${i + 1} / ${pages.length}`, {
      x: margin,
      y: 20,
      size: 8,
      font: regular,
      color: rgb(0.5, 0.5, 0.5),
    });
  });
  return doc.save();
}

export async function renderReport(
  report: ReportDto,
  format: ReportExportFormat,
  scopeName: string,
): Promise<RenderedFile> {
  const stem = `${report.type}-${report.from}-to-${report.to}`;
  if (format === 'csv') {
    return {
      bytes: new TextEncoder().encode(reportToCsv(report)),
      mime: 'text/csv; charset=utf-8',
      fileName: `${stem}.csv`,
    };
  }
  if (format === 'xlsx') {
    return {
      bytes: await reportToXlsx(report),
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileName: `${stem}.xlsx`,
    };
  }
  const span = report.from === report.to ? report.to : `${report.from} to ${report.to}`;
  return {
    bytes: await reportToPdf(report, `${scopeName} - ${span} - ${report.currency}`),
    mime: 'application/pdf',
    fileName: `${stem}.pdf`,
  };
}

import { describe, expect, it } from 'vitest';
import type { ReceiptDto } from '@montra/schemas';
import { ApiError, createApi } from '../src/api/client';
import { assessFrame } from '../src/features/camera-metrics';
import {
  classifyUploadError,
  frameVerdict,
  pageName,
  reviewEdits,
  uncategorizedLines,
} from '../src/features/receipt-capture';

// Receipt capture on the phone (TXN-08/09, RCP-06): the pure parts.
const frame = (w: number, h: number, px: (x: number, y: number) => number) => {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = px(x, y);
      rgba.set([v, v, v, 255], (y * w + x) * 4);
    }
  return rgba;
};

const receipt = (lines: Array<{ id: string; categoryId: string | null }>): ReceiptDto =>
  ({
    id: 'r1',
    version: '4',
    lines: lines.map((l, i) => ({
      id: l.id,
      lineNo: i + 1,
      rawText: `ITEM ${i}`,
      expandedName: null,
      qty: null,
      unitPrice: null,
      lineTotal: '100',
      discount: '0',
      taxable: true,
      isReturn: false,
      categoryId: l.categoryId,
      entityId: null,
      memberId: null,
      categorization: null,
    })),
  }) as unknown as ReceiptDto;

describe('frame verdict', () => {
  it('asks for a retake on blurry or glary photos', () => {
    const text = frame(64, 64, (x, y) => (((x >> 1) + (y >> 1)) % 2 ? 30 : 200));
    const blurry = frame(64, 64, (x) => 100 + x);
    const glare = frame(64, 64, (x, y) => (y < 20 ? 255 : ((x >> 1) + (y >> 1)) % 2 ? 30 : 200));
    expect(frameVerdict(assessFrame(text, 64, 64))).toBe('ok');
    expect(frameVerdict(assessFrame(blurry, 64, 64))).toBe('blurry');
    expect(frameVerdict(assessFrame(glare, 64, 64))).toBe('glare');
  });
});

describe('upload errors (TXN-09)', () => {
  it('waits when offline, retries server trouble and gives up on rejections', () => {
    expect(classifyUploadError(new ApiError(0, 'network', 'Network request failed'))).toBe('offline');
    expect(classifyUploadError(new ApiError(503, 'http_503', 'down'))).toBe('retry');
    expect(classifyUploadError(new ApiError(429, 'rate', 'slow down'))).toBe('retry');
    expect(classifyUploadError(new ApiError(415, 'receipt.unsupported_type', 'Upload a JPEG'))).toBe(
      'permanent',
    );
    expect(classifyUploadError(new Error('file missing'))).toBe('retry');
    expect(pageName(3)).toBe('page-03.jpg');
  });
});

describe('review on the phone (RCP-06)', () => {
  it('sends only the changed categories and keeps everything else', () => {
    const r = receipt([
      { id: 'a', categoryId: 'groceries' },
      { id: 'b', categoryId: null },
    ]);
    expect(uncategorizedLines(r).map((l) => l.id)).toEqual(['b']);
    const edits = reviewEdits(r, new Map([['b', 'electronics']]));
    expect(edits.version).toBe('4');
    expect(edits.lines.map((l) => [l.id, l.categoryId, l.lineTotal])).toEqual([
      ['a', 'groceries', '100'],
      ['b', 'electronics', '100'],
    ]);
  });
});

describe('receipt API calls', () => {
  it('uploads pages as multipart and creates the receipt with the client id', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const body = url.endsWith('/files') ? { fileId: 'f1' } : { id: 'r1', status: 'processing' };
      return new Response(JSON.stringify(body), { status: 201 });
    }) as unknown as typeof fetch;
    const api = createApi({ baseUrl: 'http://api', token: async () => 'dev:a@b.co', fetch: f });
    const up = await api.uploadReceiptFile('w1', { uri: 'file:///p.jpg', name: 'p.jpg', type: 'image/jpeg' });
    expect(up.fileId).toBe('f1');
    expect(calls[0]!.url).toBe('http://api/v1/workspaces/w1/receipts/files');
    expect(calls[0]!.init.body).toBeInstanceOf(FormData);
    await api.createReceipt('w1', { id: 'r1', fileIds: ['f1'], transactionId: 't1' });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      id: 'r1',
      fileIds: ['f1'],
      source: 'camera',
      transactionId: 't1',
    });
    expect(api.receiptFilePath('w1', 'r1', 'f1')).toBe('/v1/workspaces/w1/receipts/r1/files/f1');
  });
});

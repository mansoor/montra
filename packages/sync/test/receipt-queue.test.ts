import { describe, expect, it } from 'vitest';
import { MemoryStore, ReceiptUploadQueue, type ReceiptPage, type ReceiptUploader } from '../src/index.js';

// TXN-09: receipts captured offline upload when the device reconnects.
class Offline extends Error {}
class ServerError extends Error {}
class Rejected extends Error {}

const page = (n: number): ReceiptPage => ({
  uri: `file:///receipts/r/page-${n}.jpg`,
  name: `page-${n}.jpg`,
  type: 'image/jpeg',
});

/** A fake API: pages get ids; `failOn` makes the n-th upload throw. */
function fakeApi() {
  const uploaded: string[] = [];
  const created: Array<{ id: string; fileIds: string[]; transactionId: string | null }> = [];
  let failOn: { call: number; error: Error } | null = null;
  let calls = 0;
  const uploader: ReceiptUploader = {
    async uploadPage(p) {
      calls++;
      if (failOn && calls === failOn.call) throw failOn.error;
      uploaded.push(p.name);
      return `file-${p.name}`;
    },
    async createReceipt(input) {
      // Idempotent by id, like the API.
      if (!created.some((c) => c.id === input.id)) created.push(input);
    },
  };
  return { uploader, uploaded, created, failAt: (call: number, error: Error) => (failOn = { call, error }) };
}

const classify = (err: unknown) =>
  err instanceof Offline ? 'offline' : err instanceof Rejected ? 'permanent' : 'retry';

describe('ReceiptUploadQueue', () => {
  it('uploads the pages in order, creates the receipt and deletes the local files', async () => {
    const api = fakeApi();
    const removed: string[] = [];
    const q = new ReceiptUploadQueue({
      store: new MemoryStore(),
      uploader: api.uploader,
      classify,
      removeFile: async (uri) => void removed.push(uri),
    });
    await q.enqueue({ id: 'r1', pages: [page(1), page(2)], transactionId: 't1' });
    expect(await q.process()).toEqual({ sent: ['r1'], failed: [], offline: false });
    expect(api.created).toEqual([
      { id: 'r1', fileIds: ['file-page-1.jpg', 'file-page-2.jpg'], transactionId: 't1' },
    ]);
    expect(removed).toEqual([page(1).uri, page(2).uri]);
    expect(await q.list()).toEqual([]);
  });

  it('keeps uploaded pages when the network drops and resumes without re-uploading them', async () => {
    const api = fakeApi();
    const store = new MemoryStore();
    const q = new ReceiptUploadQueue({ store, uploader: api.uploader, classify });
    await q.enqueue({ id: 'r1', pages: [page(1), page(2), page(3)] });
    await q.enqueue({ id: 'r2', pages: [page(4)] });
    api.failAt(2, new Offline('network request failed'));
    expect(await q.process()).toEqual({ sent: [], failed: [], offline: true });
    const [waiting] = await q.list();
    expect(waiting!.pages.map((p) => p.fileId)).toEqual(['file-page-1.jpg', null, null]);
    expect(waiting!.attempts).toBe(0); // offline is not a failed attempt
    expect(waiting!.error).toBe('network request failed'); // but the screen can say why it waits

    // Back online, from a fresh queue over the same store (the app restarted).
    const again = new ReceiptUploadQueue({ store, uploader: api.uploader, classify });
    expect(await again.process()).toEqual({ sent: ['r1', 'r2'], failed: [], offline: false });
    expect(api.uploaded).toEqual(['page-1.jpg', 'page-2.jpg', 'page-3.jpg', 'page-4.jpg']);
  });

  it('backs off after server errors and gives up on rejected files', async () => {
    const api = fakeApi();
    let now = new Date('2026-11-03T10:00:00Z');
    const q = new ReceiptUploadQueue({
      store: new MemoryStore(),
      uploader: api.uploader,
      classify,
      now: () => now,
    });
    await q.enqueue({ id: 'r1', pages: [page(1)] });
    api.failAt(1, new ServerError('HTTP 503'));
    await q.process();
    const [item] = await q.list();
    expect(item).toMatchObject({
      state: 'queued',
      attempts: 1,
      error: 'HTTP 503',
      nextAttemptAt: '2026-11-03T10:00:30.000Z',
    });
    expect(await q.process()).toEqual({ sent: [], failed: [], offline: false }); // not due yet
    now = new Date('2026-11-03T10:01:00Z');
    expect((await q.process()).sent).toEqual(['r1']);

    await q.enqueue({ id: 'r2', pages: [page(2)] });
    api.failAt(3, new Rejected('Upload a JPEG, PNG or WebP photo, or a PDF invoice'));
    expect((await q.process()).failed).toEqual(['r2']);
    expect((await q.list())[0]).toMatchObject({ state: 'failed', error: expect.stringMatching(/JPEG/) });
    await q.retry('r2');
    expect((await q.process()).sent).toEqual(['r2']);
  });

  it('replays safely: an existing id is not queued twice, and creation is idempotent', async () => {
    const api = fakeApi();
    const q = new ReceiptUploadQueue({ store: new MemoryStore(), uploader: api.uploader, classify });
    await q.enqueue({ id: 'r1', pages: [page(1)] });
    await q.enqueue({ id: 'r1', pages: [page(9)] });
    expect((await q.list()).map((i) => i.pages.length)).toEqual([1]);
    await Promise.all([q.process(), q.process()]);
    expect(api.created).toHaveLength(1);
    expect(api.uploaded).toEqual(['page-1.jpg']);
  });

  it('discards a capture with its files', async () => {
    const removed: string[] = [];
    const q = new ReceiptUploadQueue({
      store: new MemoryStore(),
      uploader: fakeApi().uploader,
      removeFile: async (uri) => void removed.push(uri),
    });
    await q.enqueue({ id: 'r1', pages: [page(1)] });
    await q.discard('r1');
    expect(await q.list()).toEqual([]);
    expect(removed).toEqual([page(1).uri]);
    await expect(q.enqueue({ id: 'r2', pages: [] })).rejects.toThrow(/at least one page/);
  });
});

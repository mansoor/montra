/**
 * Offline receipt captures (TXN-09, ADR-0014): photos taken without a connection wait here and upload when the
 * device is back online. Each capture has a client-generated receipt id, so creating it is idempotent; pages
 * upload one by one and their file ids are kept, so an interrupted upload resumes where it stopped. Pure over
 * an injected uploader and the store's meta table, so it is testable without a device.
 */
import type { SyncStore } from './types.js';

export type ReceiptPageType = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';

export interface ReceiptPage {
  /** A file the app owns (copied out of the camera cache). */
  uri: string;
  name: string;
  type: ReceiptPageType;
  /** Set once the page is uploaded. */
  fileId?: string | null;
}

export interface QueuedReceipt {
  /** The receipt id the server will use (client-generated, TXN-09 replay safety). */
  id: string;
  pages: ReceiptPage[];
  /** Captured from a transaction's "Add receipt": link to it once read. */
  transactionId: string | null;
  createdAt: string;
  attempts: number;
  state: 'queued' | 'failed';
  error: string | null;
  /** Retry backoff after a server error; null = try now. */
  nextAttemptAt: string | null;
}

export interface ReceiptUploader {
  /** Uploads one page and returns its file id. */
  uploadPage(page: ReceiptPage): Promise<string>;
  /** Creates the receipt; must succeed when it already exists (same id). */
  createReceipt(input: { id: string; fileIds: string[]; transactionId: string | null }): Promise<void>;
}

/** How an upload error is handled: wait for the network, retry with backoff, or give up and show it. */
export type ErrorKind = 'offline' | 'retry' | 'permanent';

export interface ReceiptQueueOptions {
  store: Pick<SyncStore, 'getMeta' | 'setMeta'>;
  uploader: ReceiptUploader;
  classify?: (err: unknown) => ErrorKind;
  /** Deletes a page file once its receipt is created (or discarded). */
  removeFile?: (uri: string) => Promise<void>;
  now?: () => Date;
}

export interface ProcessResult {
  sent: string[];
  failed: string[];
  /** Stopped because the network is gone; the rest waits. */
  offline: boolean;
}

const KEY = 'receipts.queue.v1';
const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 60 * 60_000;

export class ReceiptUploadQueue {
  private running: Promise<ProcessResult> | null = null;
  private readonly now: () => Date;
  private readonly classify: (err: unknown) => ErrorKind;

  constructor(private readonly opts: ReceiptQueueOptions) {
    this.now = opts.now ?? (() => new Date());
    this.classify = opts.classify ?? (() => 'retry');
  }

  async list(): Promise<QueuedReceipt[]> {
    const raw = await this.opts.store.getMeta(KEY);
    return raw ? (JSON.parse(raw) as QueuedReceipt[]) : [];
  }

  private async save(items: QueuedReceipt[]): Promise<void> {
    await this.opts.store.setMeta(KEY, items.length ? JSON.stringify(items) : null);
  }

  private async patch(id: string, patch: Partial<QueuedReceipt>): Promise<void> {
    const items = await this.list();
    await this.save(items.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }

  async enqueue(input: {
    id: string;
    pages: ReceiptPage[];
    transactionId?: string | null;
  }): Promise<QueuedReceipt> {
    if (input.pages.length === 0) throw new Error('A receipt needs at least one page');
    const item: QueuedReceipt = {
      id: input.id,
      pages: input.pages.map((p) => ({ ...p, fileId: null })),
      transactionId: input.transactionId ?? null,
      createdAt: this.now().toISOString(),
      attempts: 0,
      state: 'queued',
      error: null,
      nextAttemptAt: null,
    };
    const items = await this.list();
    if (items.some((i) => i.id === item.id)) return items.find((i) => i.id === item.id)!;
    await this.save([...items, item]);
    return item;
  }

  /** Puts a failed capture back in line. */
  async retry(id: string): Promise<void> {
    await this.patch(id, { state: 'queued', error: null, nextAttemptAt: null });
  }

  /** Drops a capture and its files. */
  async discard(id: string): Promise<void> {
    const items = await this.list();
    const item = items.find((i) => i.id === id);
    await this.save(items.filter((i) => i.id !== id));
    if (item) await this.removeFiles(item);
  }

  /** Uploads what is due, oldest first. Concurrent calls share one run. */
  process(): Promise<ProcessResult> {
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async run(): Promise<ProcessResult> {
    const result: ProcessResult = { sent: [], failed: [], offline: false };
    const now = this.now();
    const due = (await this.list()).filter(
      (i) => i.state === 'queued' && (!i.nextAttemptAt || new Date(i.nextAttemptAt) <= now),
    );
    for (const item of due) {
      try {
        const pages = [...item.pages];
        for (let n = 0; n < pages.length; n++) {
          if (pages[n]!.fileId) continue;
          const fileId = await this.opts.uploader.uploadPage(pages[n]!);
          pages[n] = { ...pages[n]!, fileId };
          // Keep progress: a later run won't upload this page again.
          await this.patch(item.id, { pages });
        }
        await this.opts.uploader.createReceipt({
          id: item.id,
          fileIds: pages.map((p) => p.fileId!),
          transactionId: item.transactionId,
        });
        await this.save((await this.list()).filter((i) => i.id !== item.id));
        await this.removeFiles(item);
        result.sent.push(item.id);
      } catch (err) {
        const kind = this.classify(err);
        const message = err instanceof Error ? err.message : String(err);
        if (kind === 'offline') {
          result.offline = true;
          break;
        }
        const attempts = item.attempts + 1;
        if (kind === 'permanent') {
          await this.patch(item.id, { attempts, state: 'failed', error: message, nextAttemptAt: null });
          result.failed.push(item.id);
        } else {
          const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempts - 1));
          await this.patch(item.id, {
            attempts,
            error: message,
            nextAttemptAt: new Date(now.getTime() + delay).toISOString(),
          });
        }
      }
    }
    return result;
  }

  private async removeFiles(item: QueuedReceipt): Promise<void> {
    if (!this.opts.removeFile) return;
    for (const p of item.pages) await this.opts.removeFile(p.uri).catch(() => undefined);
  }
}

/**
 * WebSocket push from the API (PLT-06, 05 §3): `{ type: "subscribe", workspaceId, token }`, then `changes`
 * events trigger an incremental pull. Reconnects with backoff. Pure over an injected WebSocket constructor.
 */
export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface RealtimeOptions {
  url: string;
  workspaceId: string;
  token: () => Promise<string | null>;
  onChanges: () => void;
  createSocket?: (url: string) => SocketLike;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/** `http(s)://api` → `ws(s)://api/v1/ws`. */
export const wsUrl = (apiUrl: string): string => `${apiUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/v1/ws`;

export const reconnectDelay = (attempt: number): number => Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));

export class RealtimeClient {
  private socket: SocketLike | null = null;
  private attempt = 0;
  private timer: unknown = null;
  private stopped = true;

  constructor(private readonly o: RealtimeOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) (this.o.clearTimer ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>);
    this.timer = null;
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    const create = this.o.createSocket ?? ((u: string) => new WebSocket(u) as unknown as SocketLike);
    const s = create(this.o.url);
    this.socket = s;
    s.onopen = () => {
      this.attempt = 0;
      void this.o.token().then((token) => {
        if (this.socket === s)
          s.send(
            JSON.stringify({
              type: 'subscribe',
              workspaceId: this.o.workspaceId,
              ...(token ? { token } : {}),
            }),
          );
      });
    };
    s.onmessage = (e) => {
      try {
        const msg = JSON.parse(String(e.data)) as { type?: string; workspaceId?: string };
        if (msg.type === 'changes' && msg.workspaceId === this.o.workspaceId) this.o.onChanges();
      } catch {
        // ignore malformed frames
      }
    };
    s.onerror = () => s.close();
    s.onclose = () => {
      if (this.socket !== s) return;
      this.socket = null;
      if (this.stopped) return;
      const delay = reconnectDelay(this.attempt++);
      this.timer = (this.o.setTimer ?? setTimeout)(() => {
        this.timer = null;
        if (!this.stopped) this.connect();
      }, delay);
    };
  }
}

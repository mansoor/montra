import type { IncomingMessage } from 'node:http';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import pg from 'pg';
import { WebSocketServer, type WebSocket } from 'ws';
import { CONFIG, type AppConfig } from '../config.js';
import { Db } from '../db/database.js';
import { AUTH_PORT, type AuthPort } from '../auth/auth.js';

const CHANNEL = 'montra_changes';
const PATH = '/v1/ws';

interface Subscriber {
  socket: WebSocket;
  userId: string;
  workspaces: Set<string>;
  upgrade: IncomingMessage;
}

/**
 * Real-time change push (ADR-0008, PLT-06). One LISTEN connection per API instance receives a notification
 * per committed transaction that touched a workspace's change feed; subscribed sockets get
 * `{ type: "changes", workspaceId }` and pull `/sync/changes` (which applies RLS) for the details.
 *
 * Protocol (JSON text frames):
 *   client → { type: "subscribe", workspaceId, token? }   token = bearer value; else the upgrade's cookie/header
 *   server → { type: "subscribed", workspaceId } | { type: "error", code } | { type: "changes", workspaceId }
 */
@Injectable()
export class RealtimeService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Realtime');
  private wss?: WebSocketServer;
  private listener?: pg.Client;
  private readonly subscribers = new Set<Subscriber>();
  private heartbeat?: NodeJS.Timeout;

  constructor(
    @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost,
    @Inject(AUTH_PORT) private readonly auth: AuthPort,
    @Inject(Db) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const server = this.host.httpAdapter.getHttpServer();
    this.wss = new WebSocketServer({ server, path: PATH, maxPayload: 4096 });
    this.wss.on('connection', (socket, upgrade) => this.onConnection(socket, upgrade));

    this.listener = new pg.Client({ connectionString: this.config.DATABASE_URL });
    this.listener.on('notification', (n) => n.payload && this.broadcast(n.payload));
    this.listener.on('error', (err) => this.logger.error(`LISTEN connection failed: ${err.message}`));
    await this.listener.connect();
    await this.listener.query(`LISTEN ${CHANNEL}`);

    this.heartbeat = setInterval(() => {
      for (const s of this.subscribers) if (s.socket.readyState === s.socket.OPEN) s.socket.ping();
    }, 30_000);
    this.heartbeat.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.heartbeat);
    for (const s of this.subscribers) s.socket.terminate();
    this.wss?.close();
    await this.listener?.end().catch(() => {});
  }

  private onConnection(socket: WebSocket, upgrade: IncomingMessage): void {
    const sub: Subscriber = { socket, userId: '', workspaces: new Set(), upgrade };
    this.subscribers.add(sub);
    socket.on('close', () => this.subscribers.delete(sub));
    socket.on('message', (data) => {
      void this.onMessage(sub, data.toString()).catch(() =>
        this.send(sub, { type: 'error', code: 'internal' }),
      );
    });
  }

  private async onMessage(sub: Subscriber, raw: string): Promise<void> {
    let msg: { type?: string; workspaceId?: string; token?: string };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return this.send(sub, { type: 'error', code: 'bad_message' });
    }
    if (
      msg.type !== 'subscribe' ||
      typeof msg.workspaceId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(msg.workspaceId)
    ) {
      return this.send(sub, { type: 'error', code: 'bad_message' });
    }
    // Authenticate with the same port as HTTP requests, using the upgrade's headers (cookie) or the token.
    const headers = { ...sub.upgrade.headers } as Record<string, string>;
    if (msg.token) headers.authorization = `Bearer ${msg.token}`;
    const user = await this.auth.authenticate({ headers } as unknown as FastifyRequest);
    if (!user) return this.send(sub, { type: 'error', code: 'unauthenticated' });
    const workspaceId = msg.workspaceId;
    const member = await this.db.run({ userId: user.id }, (trx) =>
      trx
        .selectFrom('app.workspace_member')
        .select('role')
        .where('workspace_id', '=', workspaceId)
        .where('user_id', '=', user.id)
        .where('status', '=', 'active')
        .executeTakeFirst(),
    );
    if (!member) return this.send(sub, { type: 'error', code: 'forbidden', workspaceId });
    sub.userId = user.id;
    sub.workspaces.add(workspaceId);
    this.send(sub, { type: 'subscribed', workspaceId });
  }

  private broadcast(workspaceId: string): void {
    for (const s of this.subscribers)
      if (s.workspaces.has(workspaceId)) this.send(s, { type: 'changes', workspaceId });
  }

  private send(sub: Subscriber, body: object): void {
    if (sub.socket.readyState === sub.socket.OPEN) sub.socket.send(JSON.stringify(body));
  }
}

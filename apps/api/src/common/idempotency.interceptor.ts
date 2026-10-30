import { createHash } from 'node:crypto';
import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { from, mergeMap, of, type Observable } from 'rxjs';
import { Db } from '../db/database.js';
import type { RequestContext } from '../auth/auth.js';
import { AppError } from './errors.js';

/**
 * Idempotency-Key support for POST (docs/design/05 §1): a replay with the same key and body returns the stored
 * response; the same key with a different body is rejected. Keys live 24 hours per workspace.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(@Inject(Db) private readonly db: Db) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<FastifyRequest & { montra?: RequestContext }>();
    const reply = http.getResponse<FastifyReply>();
    const key = req.headers['idempotency-key'];
    const ctx = req.montra;
    if (req.method !== 'POST' || typeof key !== 'string' || !ctx?.workspaceId) return next.handle();
    if (key.length < 8 || key.length > 200) {
      throw new AppError(400, 'idempotency.invalid_key', 'Idempotency-Key must be 8–200 characters');
    }
    const dbCtx = { workspaceId: ctx.workspaceId, userId: ctx.user.id };
    const requestHash = createHash('sha256')
      .update(`${req.method} ${req.url}\n${JSON.stringify(req.body ?? null)}`)
      .digest('hex');

    return from(
      this.db.run(dbCtx, (trx) =>
        trx
          .selectFrom('app.idempotency_key')
          .select(['request_hash', 'status_code', 'response'])
          .where('workspace_id', '=', ctx.workspaceId!)
          .where('key', '=', key)
          .where('expires_at', '>', new Date())
          .executeTakeFirst(),
      ),
    ).pipe(
      mergeMap((stored) => {
        if (stored) {
          if (stored.request_hash !== requestHash) {
            throw new AppError(
              422,
              'idempotency.key_reused',
              'This Idempotency-Key was used with a different request',
            );
          }
          void reply.status(stored.status_code).header('idempotent-replay', 'true');
          return of(stored.response);
        }
        return next.handle().pipe(
          mergeMap((body) =>
            from(
              this.db
                .run(dbCtx, (trx) =>
                  trx
                    .insertInto('app.idempotency_key')
                    .values({
                      workspace_id: ctx.workspaceId!,
                      key,
                      request_hash: requestHash,
                      status_code: reply.statusCode,
                      response: JSON.stringify(body ?? null),
                    })
                    .onConflict((oc) => oc.doNothing())
                    .execute(),
                )
                .then(() => body),
            ),
          ),
        );
      }),
    );
  }
}

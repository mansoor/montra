import { ArgumentsHost, Catch, HttpException, Logger, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { LedgerError } from '@montra/domain';
import { AppError } from './errors.js';

interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  errors?: { path: string; message: string }[];
}

const TITLES: Record<number, string> = {
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  412: 'Precondition failed',
  422: 'Unprocessable entity',
  500: 'Internal server error',
};

const problem = (status: number, code: string, detail?: string, errors?: Problem['errors']): Problem => ({
  type: `https://docs.montra.app/problems/${code}`,
  title: TITLES[status] ?? 'Error',
  status,
  code,
  ...(detail ? { detail } : {}),
  ...(errors ? { errors } : {}),
});

/** Maps every error to application/problem+json (docs/design/05 §1). */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('ProblemFilter');

  catch(error: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const p = this.toProblem(error);
    if (p.status >= 500)
      this.logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    void reply.status(p.status).header('content-type', 'application/problem+json').send(p);
  }

  private toProblem(error: unknown): Problem {
    if (error instanceof AppError) return problem(error.status, error.code, error.message, error.errors);
    if (error instanceof ZodError) {
      return problem(
        400,
        'validation_failed',
        'The request is invalid',
        error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    if (error instanceof LedgerError) return problem(422, error.code, error.message);
    if (error instanceof HttpException) {
      const status = error.getStatus();
      return problem(status, status === 404 ? 'not_found' : 'http_error', error.message);
    }
    const pg = error as { code?: string; hint?: string; message?: string };
    if (typeof pg.code === 'string' && /^[0-9A-Z]{5}$/.test(pg.code)) {
      // Our triggers and functions raise with a stable problem code in HINT (e.g. ledger.unbalanced).
      if (pg.hint === 'period.locked') return problem(409, 'period.locked', pg.message);
      if (pg.hint && /^[a-z_]+\.[a-z_]+$/.test(pg.hint)) return problem(422, pg.hint, pg.message);
      if (pg.code === '42501') return problem(403, 'forbidden', 'You do not have access to this resource');
      if (pg.code === '23503') return problem(422, 'reference.invalid', 'A referenced record does not exist');
      if (pg.code === '23505') return problem(409, 'conflict', 'A record with these values already exists');
      if (pg.code === '23514') return problem(422, 'constraint.violated', pg.message);
    }
    return problem(500, 'internal', 'Something went wrong');
  }
}

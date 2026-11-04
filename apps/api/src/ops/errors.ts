/** Error tracking (NFR-13, ADR-0020 §11). Request bodies and query strings never leave: they can hold people's money. */
import * as Sentry from '@sentry/node';
import { Injectable, type Provider } from '@nestjs/common';
import type { AppConfig } from '../config.js';

export interface ErrorReporter {
  captureException(error: unknown, context?: Record<string, unknown>): void;
  captureMessage(message: string, context?: Record<string, unknown>): void;
}
export const ERROR_REPORTER = Symbol('ERROR_REPORTER');

@Injectable()
export class NoErrorReporter implements ErrorReporter {
  captureException(): void {}
  captureMessage(): void {}
}

/** Keeps what's useful for finding a bug, and drops everything else Sentry would collect by itself. */
export function scrubEvent<T extends { request?: unknown; user?: unknown; breadcrumbs?: unknown }>(
  event: T,
): T {
  delete event.request;
  delete event.breadcrumbs;
  const user = event.user as { id?: string } | undefined;
  event.user = user?.id ? { id: user.id } : undefined;
  return event;
}

export class SentryReporter implements ErrorReporter {
  constructor(dsn: string, environment: string) {
    Sentry.init({
      dsn,
      environment,
      tracesSampleRate: 0,
      beforeSend: (event) => scrubEvent(event),
    });
  }

  captureException(error: unknown, context: Record<string, unknown> = {}): void {
    Sentry.captureException(error, { extra: context });
  }

  captureMessage(message: string, context: Record<string, unknown> = {}): void {
    Sentry.captureMessage(message, { level: 'error', extra: context });
  }
}

export const errorReporterProvider = (config: AppConfig): Provider =>
  config.SENTRY_DSN
    ? { provide: ERROR_REPORTER, useValue: new SentryReporter(config.SENTRY_DSN, config.NODE_ENV) }
    : { provide: ERROR_REPORTER, useClass: NoErrorReporter };

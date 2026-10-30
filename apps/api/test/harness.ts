/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApp } from '../src/bootstrap.js';
import { APP_URL } from './env.js';

export interface Harness {
  app: NestFastifyApplication;
  as(email: string): Client;
  close(): Promise<void>;
}

export interface Response<T = any> {
  status: number;
  body: T;
  headers: Record<string, unknown>;
}

export interface Client {
  get<T = any>(url: string): Promise<Response<T>>;
  post<T = any>(url: string, body?: unknown, headers?: Record<string, string>): Promise<Response<T>>;
}

export async function startHarness(): Promise<Harness> {
  const app = await createApp({ NODE_ENV: 'test', PORT: 0, DATABASE_URL: APP_URL, AUTH_MODE: 'dev' });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const call = async (method: 'GET' | 'POST', url: string, email: string, body?: unknown, headers = {}) => {
    const res = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer dev:${email}`, ...headers },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    return {
      status: res.statusCode,
      body: res.body ? JSON.parse(res.body) : undefined,
      headers: res.headers,
    };
  };
  return {
    app,
    as: (email) => ({
      get: (url) => call('GET', url, email),
      post: (url, body, headers) => call('POST', url, email, body, headers),
    }),
    close: () => app.close(),
  };
}

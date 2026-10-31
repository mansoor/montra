import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against a real API and the production web build.
 * Prerequisites: `pnpm turbo run build` and a migrated database (`pnpm db:migrate`).
 * Servers already running on :4000 / :3000 are reused (they must share STORAGE_DIR with the worker).
 */
const API_PORT = Number(process.env.E2E_API_PORT ?? 4000);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3000);
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://montra_app:montra_app@localhost:5432/montra';
// Uploads are written by the API and read by the worker: both use the same folder.
const STORAGE_DIR = process.env.E2E_STORAGE_DIR ?? join(tmpdir(), 'montra-e2e-storage');

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node ../api/dist/main.js',
      url: `http://localhost:${API_PORT}/readyz`,
      reuseExistingServer: true,
      // AI_PROVIDER=fake: deterministic keyword categorization, no network (ADR-0012).
      env: { PORT: String(API_PORT), DATABASE_URL, AUTH_MODE: 'dev', STORAGE_DIR, AI_PROVIDER: 'fake' },
    },
    {
      // Import jobs (parse, commit, undo). No HTTP port: ready once it logs that it is listening.
      command: 'node ../api/dist/worker-main.js',
      wait: { stdout: /listening on import/ },
      stdout: 'pipe',
      env: { DATABASE_URL, STORAGE_DIR, AI_PROVIDER: 'fake' },
    },
    {
      command: `pnpm exec next start --port ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}/sign-in`,
      reuseExistingServer: true,
      env: { API_URL: `http://localhost:${API_PORT}` },
    },
  ],
});

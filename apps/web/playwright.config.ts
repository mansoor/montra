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
// ADR-0055: a synthetic SimpleFIN on this machine for the bank feed spec; the API and the worker reach it only with
// SIMPLEFIN_ALLOW_LOCAL_HTTP=on, which production refuses.
const SIMPLEFIN_PORT = Number(process.env.E2E_SIMPLEFIN_PORT ?? 4655);

/**
 * PLT-01: the latest Chrome, Edge, Safari and Firefox. Chromium (Chrome and Edge) runs every spec. Firefox and WebKit
 * (Safari's engine) run the main flows, in their own CI jobs: `E2E_PROJECTS=firefox pnpm test:e2e`. Each needs
 * `playwright install firefox` (or webkit) first.
 */
const CROSS_BROWSER = [
  'happy-path',
  'phase1a',
  'quick-add',
  'import',
  'review',
  'receipts',
  'accessibility',
].map((name) => `${name}.spec.ts`);
const ALL_PROJECTS = [
  { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  { name: 'firefox', use: { ...devices['Desktop Firefox'] }, testMatch: CROSS_BROWSER },
  { name: 'webkit', use: { ...devices['Desktop Safari'] }, testMatch: CROSS_BROWSER },
];
const WANTED = (process.env.E2E_PROJECTS ?? 'chromium').split(',').map((p) => p.trim());

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
  projects: ALL_PROJECTS.filter((p) => WANTED.includes(p.name)),
  webServer: [
    {
      command: 'node ../api/dist/main.js',
      url: `http://localhost:${API_PORT}/readyz`,
      reuseExistingServer: true,
      // AI_PROVIDER=fake: deterministic keyword categorization, no network (ADR-0012). FAMILY_VAULT_FAKE=on: the
      // vault's own fake, in the API process, instead of any real vault (ADR-0054 §15).
      env: {
        PORT: String(API_PORT),
        DATABASE_URL,
        AUTH_MODE: 'dev',
        STORAGE_DIR,
        AI_PROVIDER: 'fake',
        FAMILY_VAULT_FAKE: 'on',
        SIMPLEFIN_ALLOW_LOCAL_HTTP: 'on',
      },
    },
    {
      // Import jobs (parse, commit, undo). No HTTP port: ready once it logs that it is listening.
      command: 'node ../api/dist/worker-main.js',
      wait: { stdout: /listening on import/ },
      stdout: 'pipe',
      // FX_DAILY=false: no rate refresh against ECB during e2e.
      env: {
        DATABASE_URL,
        STORAGE_DIR,
        AI_PROVIDER: 'fake',
        FX_DAILY: 'false',
        SIMPLEFIN_ALLOW_LOCAL_HTTP: 'on',
      },
    },
    {
      // The synthetic SimpleFIN (apps/api/test/fakes): setup tokens from GET /__token, dates relative to today.
      command: 'pnpm --filter @montra/api exec tsx test/fakes/simplefin-server.ts',
      url: `http://127.0.0.1:${SIMPLEFIN_PORT}/__ready`,
      reuseExistingServer: true,
      env: { E2E_SIMPLEFIN_PORT: String(SIMPLEFIN_PORT) },
    },
    {
      command: `pnpm exec next start --port ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}/sign-in`,
      reuseExistingServer: true,
      env: { API_URL: `http://localhost:${API_PORT}` },
    },
  ],
});

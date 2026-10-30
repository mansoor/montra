import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against a real API and the production web build.
 * Prerequisites: `pnpm turbo run build` and a migrated database (`pnpm db:migrate`).
 * Servers already running on :4000 / :3000 are reused.
 */
const API_PORT = Number(process.env.E2E_API_PORT ?? 4000);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3000);

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
      env: {
        PORT: String(API_PORT),
        DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://montra_app:montra_app@localhost:5432/montra',
        AUTH_MODE: 'dev',
      },
    },
    {
      command: `pnpm exec next start --port ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}/sign-in`,
      reuseExistingServer: true,
      env: { API_URL: `http://localhost:${API_PORT}` },
    },
  ],
});

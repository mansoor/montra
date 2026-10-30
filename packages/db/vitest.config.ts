import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['@montra/source'] },
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Integration tests share one database; run files sequentially.
    fileParallelism: false,
    hookTimeout: 30_000,
  },
});

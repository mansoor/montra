import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['@montra/source'] },
  test: { include: ['test/**/*.test.ts'] },
});

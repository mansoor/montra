import { defineConfig } from 'vitest/config';
import { sourceAliases } from '../../vitest.shared.js';

export default defineConfig({
  resolve: { alias: sourceAliases },
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    hookTimeout: 30_000,
  },
});

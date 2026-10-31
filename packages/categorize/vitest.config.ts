import { defineConfig } from 'vitest/config';
import { sourceAliases } from '../../vitest.shared.js';

export default defineConfig({
  resolve: { alias: sourceAliases },
  // The perf budget is measured on its own (`test:perf`), not while every other suite shares the CPU.
  test: {
    include: process.env.PERF ? ['test/perf.test.ts'] : ['test/**/*.test.ts'],
    exclude: process.env.PERF ? [] : ['test/perf.test.ts'],
  },
});

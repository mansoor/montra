import { defineConfig } from 'vitest/config';
import { sourceAliases } from '../../vitest.shared.js';

// The perf budget is measured on its own (`test:perf`, i.e. `vitest run --mode perf`), not while every other
// suite shares the CPU. A mode rather than an env var keeps the script working in cmd.exe on Windows.
export default defineConfig(({ mode }) => ({
  resolve: { alias: sourceAliases },
  test: {
    include: mode === 'perf' ? ['test/perf.test.ts'] : ['test/**/*.test.ts'],
    exclude: mode === 'perf' ? [] : ['test/perf.test.ts'],
  },
}));

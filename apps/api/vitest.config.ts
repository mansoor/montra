import { defineConfig } from 'vitest/config';
import { sourceAliases } from '../../vitest.shared.js';

// The import-throughput budget is measured on its own (`test:perf`, i.e. `vitest run --mode perf`): under the
// full parallel `turbo test` run it competes for the CPU and the timing says nothing about the code.
export default defineConfig(({ mode }) => ({
  resolve: { alias: sourceAliases },
  test: {
    include: mode === 'perf' ? ['test/perf-commit.test.ts'] : ['test/**/*.test.ts'],
    exclude: mode === 'perf' ? [] : ['test/perf-commit.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    hookTimeout: 30_000,
  },
}));

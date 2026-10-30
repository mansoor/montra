import { defineConfig } from 'vitest/config';
import { sourceAliases } from '../../vitest.shared.js';

export default defineConfig({
  resolve: { alias: sourceAliases },
  test: { include: ['test/**/*.test.ts'] },
});

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { sourceAliases } from '../../vitest.shared.js';

export default defineConfig({
  resolve: { alias: { ...sourceAliases, '@': fileURLToPath(new URL('.', import.meta.url)) } },
  // tsconfig keeps `jsx: preserve` for Next; tests compile JSX themselves.
  oxc: { jsx: { runtime: 'automatic' } },
  test: { include: ['lib/**/*.test.ts', 'lib/**/*.test.tsx'] },
});

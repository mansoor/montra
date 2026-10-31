import { defineConfig } from 'vitest/config';
import { sourceAliases } from '../../vitest.shared.js';

// Unit tests cover the pure modules (store SQL, models, metrics, clients); React Native screens are verified by
// `expo export` bundling and Maestro flows on devices.
export default defineConfig({
  resolve: { alias: sourceAliases },
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});

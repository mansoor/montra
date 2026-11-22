import { defineConfig } from 'vitest/config';
import { sourceAliases } from '../../vitest.shared.js';

// Unit tests cover the pure modules (store SQL, models, metrics, clients). Screens are rendered by Jest (jest-expo and
// React Native Testing Library) in screens-test/, which this config never picks up; see jest.config.js.
export default defineConfig({
  resolve: { alias: sourceAliases },
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});

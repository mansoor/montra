/**
 * Screen tests: React Native Testing Library on the jest-expo preset, in screens-test/ only. Vitest runs the pure-module
 * tests in test/; neither runner picks up the other's files.
 */
const path = require('node:path');

const pkg = (name) => path.join(__dirname, '../../packages', name, 'src/index.ts');

/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  roots: ['<rootDir>/screens-test'],
  // Not `<rootDir>/…`: on Windows a dot in the checkout's path (such as `.claude/worktrees`) breaks that glob.
  testMatch: ['**/screens-test/**/*.test.tsx'],
  setupFilesAfterEnv: ['<rootDir>/screens-test/setup.tsx'],
  // With a cold transform cache (every CI run) the first render compiles React Native's lazily required modules inside
  // the test, which takes longer than Jest's default 5 s on a slow machine.
  testTimeout: 30_000,
  moduleNameMapper: {
    // Workspace packages resolve to their TypeScript sources, as in Metro and Vitest (no build step).
    '^@montra/(domain|schemas|i18n|sync|password)$': pkg('$1'),
    // Workspace sources import siblings as `./file.js` (TypeScript NodeNext); the file on disk is `.ts`.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};

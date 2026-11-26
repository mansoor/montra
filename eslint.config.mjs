import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** The browser's own dialogs, which the web app doesn't use. */
const BROWSER_DIALOGS = ['confirm', 'alert', 'prompt'];
const WEB_DIALOG_MESSAGE =
  "Use Montra's in-app dialog instead: useConfirm() (or usePrompt()) from components/ui/confirm-dialog.";

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/.next/**',
      '.claude/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Money must never go through floating point (NFR-09).
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'round', message: 'Use @montra/domain rounding helpers for money.' },
      ],
    },
  },
  {
    // The web app asks in its own dialog, never the browser's: `useConfirm` / `usePrompt` in components/ui/confirm-dialog.
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...BROWSER_DIALOGS.map((name) => ({ name, message: WEB_DIALOG_MESSAGE })),
      ],
      'no-restricted-properties': [
        'error',
        // Repeated from above: a later block's options replace the earlier ones.
        { object: 'Math', property: 'round', message: 'Use @montra/domain rounding helpers for money.' },
        ...['window', 'globalThis', 'self'].flatMap((object) =>
          BROWSER_DIALOGS.map((property) => ({ object, property, message: WEB_DIALOG_MESSAGE })),
        ),
      ],
    },
  },
  {
    files: ['packages/domain/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['node:*', 'pg', 'kysely', '@nestjs/*'] }],
    },
  },
);

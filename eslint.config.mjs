import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/.turbo/**'] },
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
    files: ['packages/domain/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['node:*', 'pg', 'kysely', '@nestjs/*'] }],
    },
  },
);

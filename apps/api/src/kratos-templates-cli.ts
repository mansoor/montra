/**
 * Writes Kratos's email templates from the shared layout (`src/mail/kratos-templates.ts`):
 *   pnpm --filter @montra/api kratos:templates
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kratosTemplateFiles } from './mail/kratos-templates.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../infra/kratos/templates');
for (const [path, content] of Object.entries(kratosTemplateFiles())) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  console.log(`wrote infra/kratos/templates/${path}`);
}

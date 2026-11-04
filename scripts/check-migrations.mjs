#!/usr/bin/env node
/**
 * OPS-03, OPS-04: during a blue/green deploy the old tasks run against the new schema, so a migration has to leave what they use in place.
 * This refuses destructive statements in new migrations. A contract step, once nothing uses the old shape, says so on the line above:
 *   -- contract: nothing has read app.foo.bar since v1.2.0
 * Migrations up to FIRST_CHECKED were written before there was anything running to protect.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIRST_CHECKED = 22;
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'db', 'migrations');

const FORBIDDEN = [
  [/\bdrop\s+table\b/i, 'drops a table'],
  [/\bdrop\s+column\b/i, 'drops a column'],
  [/\brename\s+(column\s+)?\w+\s+to\b/i, 'renames something'],
  [/\brename\s+to\b/i, 'renames a table'],
  [/\balter\s+(column\s+)?\w+\s+(set\s+data\s+)?type\b/i, 'changes a column type'],
  [/\balter\s+column\s+\w+\s+set\s+not\s+null\b/i, 'adds NOT NULL to an existing column'],
  [/\badd\s+column\s+[^;]*\bnot\s+null\b(?![^;]*\bdefault\b)/i, 'adds a NOT NULL column with no default'],
  [/\btruncate\b/i, 'truncates a table'],
];

/** @returns {{ file: string, line: number, why: string }[]} */
export function check(file, sql) {
  const problems = [];
  const lines = sql.split('\n');
  lines.forEach((text, i) => {
    const code = text.replace(/--.*$/, '');
    for (const [pattern, why] of FORBIDDEN) {
      if (pattern.test(code) && !/^\s*--\s*contract:\s*\S/.test(lines[i - 1] ?? '')) {
        problems.push({ file, line: i + 1, why });
      }
    }
  });
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = readdirSync(dir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) >= FIRST_CHECKED)
    .flatMap((f) => check(f, readFileSync(join(dir, f), 'utf8')));
  for (const p of problems) {
    console.error(
      `${p.file}:${p.line} ${p.why}. Old tasks still running would break; see scripts/check-migrations.mjs.`,
    );
  }
  if (problems.length) process.exit(1);
  console.log('Migrations are backward compatible.');
}

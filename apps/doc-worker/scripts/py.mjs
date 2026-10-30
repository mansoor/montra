#!/usr/bin/env node
// Runs the doc worker's Python toolchain. Prefers apps/doc-worker/.venv, then $PYTHON, then python3.
// Fails loudly when the dev dependencies are missing instead of silently passing.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const venv = join(root, '.venv', 'bin', 'python');
const python = existsSync(venv) ? venv : (process.env.PYTHON ?? 'python3');

const probe = spawnSync(python, ['-c', 'import pytest, ruff, mypy, pdfplumber, xlrd, psycopg'], {
  cwd: root,
});
if (probe.status !== 0) {
  console.error(
    `[doc-worker] Python dev dependencies are missing for ${python}.\n` +
      '  Install them with:\n' +
      '    python3 -m venv apps/doc-worker/.venv\n' +
      '    apps/doc-worker/.venv/bin/pip install -e "apps/doc-worker[dev]"',
  );
  process.exit(1);
}
const res = spawnSync(python, process.argv.slice(2), { cwd: root, stdio: 'inherit' });
process.exit(res.status ?? 1);

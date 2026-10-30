import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { catalogs } from '@montra/i18n';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP = new Set(['node_modules', '.next', 'e2e', 'test-results', 'playwright-report']);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const en = catalogs.en!;
const files = sources(ROOT).map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, 'utf8') }));

/** Values that dynamic keys (`t(\`prefix.${x}\`)`) can take, so every combination is checked. */
const DYNAMIC: Record<string, readonly string[]> = {
  'account.kind.': [
    'checking',
    'savings',
    'credit_card',
    'cash',
    'loan',
    'mortgage',
    'line_of_credit',
    'investment',
    'asset',
    'liability',
  ],
  'account.type.': ['asset', 'liability', 'equity', 'income', 'expense'],
  'account.type_plural.': ['asset', 'liability', 'equity', 'income', 'expense'],
  'entity.type.': ['personal', 'business', 'rental'],
  'imports.status.': [
    'uploaded',
    'parsing',
    'needs_mapping',
    'preview',
    'committing',
    'committed',
    'failed',
    'undone',
  ],
  'imports.role.': [
    'ignore',
    'date',
    'description',
    'payee',
    'amount',
    'debit',
    'credit',
    'balance',
    'category',
    'reference',
  ],
  'imports.row_error.': ['invalid_date', 'invalid_amount', 'missing_amount'],
  'imports.kept_reason.': ['reconciled', 'reversed_in_open_period'],
  'entities.action.': ['lock', 'unlock', 'relock'],
  'journal.kind.': [
    'standard',
    'transfer',
    'opening_balance',
    'adjustment',
    'reversal',
    'depreciation',
    'fx_revaluation',
    'closing',
    'manual',
  ],
  'members.relationship.': ['self', 'spouse_partner', 'child', 'parent', 'other'],
  'realtime.': ['connecting', 'live', 'polling'],
  'role.': ['owner', 'partner', 'viewer', 'accountant'],
  'security.group.': ['profile', 'password', 'totp', 'webauthn', 'passkey', 'lookup_secret'],
  'sharing.invite_status.': ['pending', 'accepted', 'revoked', 'expired'],
  'sharing.member_status.': ['invited', 'active', 'revoked'],
  'sharing.role_hint.': ['partner', 'viewer', 'accountant'],
};

describe('message catalog coverage (TZ-06)', () => {
  it('has every literal key used in apps/web', () => {
    const missing: string[] = [];
    let count = 0;
    for (const { path, text } of files) {
      for (const m of text.matchAll(/\bt\(\s*'([a-z0-9_.]+)'/g)) {
        count++;
        if (!(m[1]! in en)) missing.push(`${path}: ${m[1]}`);
      }
      // Keys stored in tables and passed to t() later, e.g. `label: 'transactions.filter.all'`.
      for (const m of text.matchAll(/label: '([a-z0-9_]+\.[a-z0-9_.]+)'/g)) {
        if (!(m[1]! in en)) missing.push(`${path}: ${m[1]}`);
      }
    }
    expect(count).toBeGreaterThan(200);
    expect(missing).toEqual([]);
  });

  it('has every value of every dynamic key, and no unknown dynamic prefix is used', () => {
    const unknown: string[] = [];
    const missing: string[] = [];
    for (const { path, text } of files) {
      for (const m of text.matchAll(/\bt\(\s*`([a-z0-9_.]+)\$\{/g)) {
        const prefix = m[1]!;
        const values = DYNAMIC[prefix];
        if (!values) unknown.push(`${path}: ${prefix}`);
        else for (const v of values) if (!(prefix + v in en)) missing.push(prefix + v);
      }
    }
    expect(unknown).toEqual([]);
    expect([...new Set(missing)]).toEqual([]);
  });

  it('keeps placeholders balanced in every message', () => {
    const broken = Object.entries(en).filter(
      ([, v]) => (v.match(/\{/g) ?? []).length !== (v.match(/\}/g) ?? []).length,
    );
    expect(broken).toEqual([]);
  });
});

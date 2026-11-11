import { describe, expect, it } from 'vitest';
import { MIGRATION_SOURCES } from '@montra/schemas';
import { catalogs } from '@montra/i18n';
import { SWITCH_SOURCES } from './switch-sources';

describe('switching from another app: export instructions (IMP-13)', () => {
  it('covers every source once, and every step and note has its message', () => {
    expect(SWITCH_SOURCES.map((s) => s.id).sort()).toEqual([...MIGRATION_SOURCES].sort());
    const en = catalogs.en!;
    const keys = SWITCH_SOURCES.flatMap((s) => [...s.steps, ...(s.note ? [s.note] : [])]);
    expect(keys.filter((k) => !(k in en))).toEqual([]);
    for (const s of SWITCH_SOURCES) expect(s.steps.length).toBeGreaterThan(0);
  });
});

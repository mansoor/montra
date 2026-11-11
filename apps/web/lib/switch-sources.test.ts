import { describe, expect, it } from 'vitest';
import { MIGRATION_SOURCES } from '@montra/schemas';
import { catalogs } from '@montra/i18n';
import { newCategoryName, sourceLabel, SWITCH_ACCEPT, SWITCH_SOURCES, switchSource } from './switch-sources';

describe('switching from another app: export instructions (IMP-13)', () => {
  it('covers every source once, and every step and note has its message', () => {
    expect(SWITCH_SOURCES.map((s) => s.id).sort()).toEqual([...MIGRATION_SOURCES].sort());
    const en = catalogs.en!;
    const keys = SWITCH_SOURCES.flatMap((s) => [...s.steps, ...(s.note ? [s.note] : [])]);
    expect(keys.filter((k) => !(k in en))).toEqual([]);
    for (const s of SWITCH_SOURCES) expect(s.steps.length).toBeGreaterThan(0);
    for (const s of SWITCH_SOURCES) if (!s.name) expect(en[s.nameKey ?? 'switch.other_name']).toBeTruthy();
  });

  it('names translated sources, takes QIF and OFX files, and names Quicken subcategories by their leaf', () => {
    const t = (key: string) => `<${key}>`;
    expect(sourceLabel(switchSource('bank')!, t)).toBe('<switch.bank_name>');
    expect(sourceLabel(switchSource('other')!, t)).toBe('<switch.other_name>');
    expect(sourceLabel(switchSource('quicken_windows')!, t)).toBe('Quicken (Windows)');
    expect(SWITCH_ACCEPT.split(',')).toEqual(
      expect.arrayContaining(['.qif', '.ofx', '.qfx', '.csv', '.xlsx']),
    );
    expect(newCategoryName('Food:Groceries', 'Food')).toBe('Groceries');
    expect(newCategoryName('Groceries', 'Everyday')).toBe('Groceries');
    expect(newCategoryName('Food:', 'Food')).toBe('Food:');
  });
});

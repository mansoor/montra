import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import * as schemas from '../src/index.js';

/**
 * Zod 4's `.partial()` keeps `.default()`, so a patch built from a create schema fills every field it leaves out
 * with the create default, and the API then overwrites what is stored. Every `Update…` schema must leave
 * omitted fields out.
 */
const updates = Object.entries(schemas as Record<string, unknown>)
  .filter(([name, s]) => name.startsWith('Update') && typeof (s as Partial<ZodType>).safeParse === 'function')
  .map(([name, s]): [string, ZodType] => [name, s as ZodType]);

/** The smallest body each schema accepts: nothing, or only the version. */
const minimal = (s: ZodType) =>
  [{}, { version: 1 }, { version: '1' }].find((body) => s.safeParse(body).success);

describe('patch schemas', () => {
  it('finds the update schemas', () => {
    expect(updates.length).toBeGreaterThan(30);
  });

  it.each(updates)('%s leaves omitted fields out', (_name, s) => {
    const body = minimal(s);
    // A few patches always need a field besides the version (a column mapping, a budget period's lines).
    if (!body) return;
    expect(s.parse(body)).toEqual(body);
  });

  it('keeps the fields a goal, an expected income, a bill or a maintenance job already has', () => {
    expect(schemas.UpdateGoalRequest.parse({ archived: true, version: 2 })).toEqual({
      archived: true,
      version: 2,
    });
    expect(schemas.UpdateExpectedIncomeRequest.parse({ active: false, version: 2 })).toEqual({
      active: false,
      version: 2,
    });
    expect(schemas.UpdateBillRequest.parse({ notes: 'Paid by card', version: 3 })).toEqual({
      notes: 'Paid by card',
      version: 3,
    });
    expect(schemas.UpdateMaintenanceRequest.parse({ status: 'done', version: 4 })).toEqual({
      status: 'done',
      version: 4,
    });
  });
});

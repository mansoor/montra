import { describe, expect, it } from 'vitest';
import type { TaxFormDto, TaxFormExpectedDto } from '@montra/api-client';
import {
  anyReading,
  boxFields,
  boxesOf,
  byPerson,
  canConfirmReading,
  checkChip,
  defaultTaxYear,
  readingStage,
  resultChip,
  yearChoices,
} from './tax-forms';

describe('the year shown (ADR-0052 §7.1)', () => {
  it.each([
    ['2026-01-15', 2025],
    ['2026-04-30', 2025],
    ['2026-05-01', 2026],
    ['2026-11-16', 2026],
  ])('on %s opens %s', (today, year) => {
    expect(defaultTaxYear(today)).toBe(year);
  });

  it('offers the last four years, and an older one when it is shown', () => {
    expect(yearChoices('2026-11-16', 2026)).toEqual([2026, 2025, 2024, 2023]);
    expect(yearChoices('2026-11-16', 2019)).toEqual([2026, 2025, 2024, 2023, 2019]);
  });
});

describe('typing boxes', () => {
  it('turns typed dollars into cents and leaves blank boxes out', () => {
    const fields = boxFields('w2', {});
    fields.money.box1 = '85,120.34';
    fields.money.box2 = '12045';
    fields.box12 = [{ code: 'D', amount: '5000' }];
    fields.state = { state: 'ca', box16: '85120.34', box17: '' };
    expect(boxesOf('w2', fields)).toEqual({
      ok: true,
      boxes: {
        box1: '8512034',
        box2: '1204500',
        box12: [{ code: 'D', amount: '500000' }],
        states: [{ state: 'CA', box16: '8512034' }],
      },
    });
  });

  it('keeps the boxes the editor doesn’t show', () => {
    const previous = {
      box1: '100',
      box14: [{ label: 'CASDI', amount: '108144' }],
      states: [
        { state: 'CA', box16: '100' },
        { state: 'NY', box16: '50' },
      ],
    };
    const fields = boxFields('w2', previous);
    expect(fields.money.box1).toBe('1.00');
    expect(fields.state).toEqual({ state: 'CA', box16: '1.00', box17: '' });
    fields.money.box1 = '';
    const r = boxesOf('w2', fields, previous);
    expect(r).toEqual({
      ok: true,
      boxes: {
        box14: previous.box14,
        states: [
          { state: 'CA', box16: '100' },
          { state: 'NY', box16: '50' },
        ],
      },
    });
  });

  it('names the box that isn’t an amount', () => {
    const fields = boxFields('1099_int', {});
    fields.money.box4 = 'abc';
    expect(boxesOf('1099_int', fields)).toMatchObject({ ok: false, field: 'box4' });
    fields.money.box4 = '-5';
    expect(boxesOf('1099_int', fields)).toMatchObject({ ok: false, field: 'box4' });
  });

  it('keeps a 1098’s dates and box 10’s label', () => {
    const fields = boxFields('1098', {});
    fields.money.box1 = '12000';
    fields.box3 = '2021-06-15';
    fields.box10Label = 'Property tax';
    expect(boxesOf('1098', fields)).toEqual({
      ok: true,
      boxes: { box1: '1200000', box3: '2021-06-15', box10Label: 'Property tax' },
    });
  });
});

describe('results and groups', () => {
  it('colours a result by whether it needs a look', () => {
    expect(resultChip('matches')).toContain('chip-good');
    expect(resultChip('differs')).toContain('chip-warn');
    expect(resultChip('needs_match')).toContain('chip-warn');
    expect(resultChip('not_tracked')).toContain('chip-muted');
    expect(checkChip('explained')).toContain('chip-good');
    expect(checkChip('info')).toContain('chip-muted');
  });

  it('groups expected forms by person, the household last', () => {
    const e = (personMemberId: string | null, name: string) =>
      ({ personMemberId, name, kind: '1099_int' }) as TaxFormExpectedDto;
    const groups = byPerson(
      [e(null, 'Joint savings'), e('b', 'Bea’s W-2'), e('a', 'Al’s W-2'), e('b', 'Bea’s savings')],
      new Map([
        ['a', 'Al'],
        ['b', 'Bea'],
      ]),
    );
    expect(groups.map((g) => [g.name, g.items.map((i) => i.name)])).toEqual([
      ['Al', ['Al’s W-2']],
      ['Bea', ['Bea’s W-2', 'Bea’s savings']],
      [null, ['Joint savings']],
    ]);
  });
});

describe('forms read from files (ADR-0052 PR 3)', () => {
  const reading: NonNullable<TaxFormDto['reading']> = {
    fileNames: ['w2.pdf'],
    kindKnown: true,
    boxesRead: true,
    problem: null,
    droppedBoxes: 0,
    confirmedBy: null,
    match: { automatic: true, reason: 'Matched', candidates: [] },
    copyOfId: null,
  };
  const form = (over: Partial<TaxFormDto> = {}, r: Partial<typeof reading> | null = {}) =>
    ({
      status: 'review',
      reason: null,
      boxes: { box1: '100' },
      targets: [{ employerId: 'e', accountId: null }],
      personMemberId: 'p',
      ...over,
      reading: r === null ? null : { ...reading, ...r },
    }) as TaxFormDto;

  it('says where the reading stands', () => {
    expect(readingStage(form({}, null))).toBeNull();
    expect(readingStage(form({ status: 'reading' }, { boxesRead: false, kindKnown: false }))).toBe('reading');
    expect(readingStage(form({ status: 'reading' }, { problem: 'waiting' }))).toBe('waiting');
    expect(readingStage(form({ status: 'reading' }, { problem: 'failed' }))).toBe('unread');
    expect(readingStage(form({ reason: 'unread', boxes: {} }, { boxesRead: false }))).toBe('unread');
    expect(readingStage(form())).toBe('to_confirm');
    expect(readingStage(form({ status: 'confirmed' }, { confirmedBy: 'books' }))).toBe('confirmed_by_books');
    expect(readingStage(form({ status: 'confirmed' }, { confirmedBy: 'person' }))).toBe('confirmed');
  });

  it('offers Confirm reading only for a read form that is matched and has a person', () => {
    expect(canConfirmReading(form())).toBe(true);
    expect(canConfirmReading(form({ targets: [] }))).toBe(false);
    expect(canConfirmReading(form({ personMemberId: null }))).toBe(false);
    expect(canConfirmReading(form({ reason: 'unread', boxes: {} }))).toBe(false);
    expect(canConfirmReading(form({ status: 'confirmed' }))).toBe(false);
    expect(canConfirmReading(form({}, null))).toBe(false);
  });

  it('looks again while a form is being read, but not once its reading failed', () => {
    expect(anyReading([form({ status: 'reading' })])).toBe(true);
    expect(anyReading([form({ status: 'reading' }, { problem: 'failed' })])).toBe(false);
    expect(anyReading([form()])).toBe(false);
  });
});

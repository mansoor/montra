import { describe, expect, it } from 'vitest';
import type { EducationStudentDto, EducationSummaryDto } from '@montra/api-client';
import { educationView } from './education';

const student = (over: Partial<EducationStudentDto>): EducationStudentDto => ({
  memberId: '00000000-0000-4000-8000-000000000001',
  name: 'Maya',
  relationship: 'child',
  isDependent: true,
  birthDate: '2006-04-02' as EducationStudentDto['birthDate'],
  expenses: [
    { type: 'tuition_fees', amount: '0' },
    { type: 'books_supplies', amount: '0' },
    { type: 'room_board', amount: '0' },
    { type: 'computer', amount: '0' },
  ],
  expenseTotal: '0',
  withdrawals529: '0',
  plans: [],
  ...over,
});
const summary = (students: EducationStudentDto[], marked = true): EducationSummaryDto => ({
  year: 2025,
  from: '2025-01-01' as EducationSummaryDto['from'],
  to: '2025-12-31' as EducationSummaryDto['to'],
  currency: 'USD' as EducationSummaryDto['currency'],
  categories: marked
    ? [{ categoryId: '00000000-0000-4000-8000-0000000000c1', name: 'Tuition', type: 'tuition_fees' }]
    : [],
  has529: true,
  students,
});
const amounts = (t: string, b: string, r: string, c: string) => [
  { type: 'tuition_fees' as const, amount: t },
  { type: 'books_supplies' as const, amount: b },
  { type: 'room_board' as const, amount: r },
  { type: 'computer' as const, amount: c },
];

// Education tax helpers (FAM-10): notes say what may matter, and decide nothing.
describe('education summary view', () => {
  it('shows only the kinds paid, and notes credits and room and board', () => {
    const v = educationView(
      summary([student({ expenses: amounts('300000', '10000', '150000', '0'), expenseTotal: '460000' })]),
    );
    expect(v.needsCategories).toBe(false);
    expect(v.students[0]!.expenses.map((e) => e.type)).toEqual([
      'tuition_fees',
      'books_supplies',
      'room_board',
    ]);
    expect(v.students[0]!.notes).toEqual(['credits', 'room_board']);
  });

  it('compares 529 withdrawals with the expenses marked', () => {
    const more = educationView(
      summary([
        student({
          expenses: amounts('0', '0', '0', '120000'),
          expenseTotal: '120000',
          withdrawals529: '400000',
        }),
      ]),
    ).students[0]!;
    expect(more.notes).toEqual(['withdrawals_more', 'no_double']);
    const covered = educationView(
      summary([
        student({
          expenses: amounts('500000', '0', '0', '0'),
          expenseTotal: '500000',
          withdrawals529: '400000',
        }),
      ]),
    ).students[0]!;
    expect(covered.notes).toEqual(['credits', 'no_double']);
    // A withdrawal with nothing marked against it.
    expect(educationView(summary([student({ withdrawals529: '1' })])).students[0]!.notes).toEqual([
      'withdrawals_more',
    ]);
  });

  it('flags what has no member, and drops students who net to nothing', () => {
    const v = educationView(
      summary(
        [
          student({
            memberId: null,
            name: 'Household',
            expenses: amounts('0', '5000', '0', '0'),
            expenseTotal: '5000',
          }),
          student({ expenses: amounts('2000', '-2000', '0', '0'), expenseTotal: '0' }),
        ],
        false,
      ),
    );
    expect(v.needsCategories).toBe(true);
    expect(v.students.map((s) => [s.key, s.notes])).toEqual([['none', ['unassigned', 'credits']]]);
  });

  it('a refund larger than the spending is not "paid"', () => {
    const v = educationView(
      summary([student({ expenses: amounts('-1000', '0', '0', '0'), expenseTotal: '-1000' })]),
    );
    expect(v.students[0]!.notes).toEqual([]);
  });
});

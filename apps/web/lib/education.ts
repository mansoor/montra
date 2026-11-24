import type { EducationStudentDto, EducationSummaryDto } from '@montra/api-client';

/**
 * Education tax helpers (FAM-10): what the By member page shows per student. Plain comparisons only, for notes that
 * say what may matter. Nothing here decides who qualifies or what is taxable; the page says to ask a tax adviser.
 *
 * The notes a student can get, in the order shown:
 * - unassigned: expenses or withdrawals with no member; choose the student on those transactions.
 * - credits: tuition, fees, books or supplies were paid, so the education credits may matter.
 * - room_board: room and board can count for a 529 withdrawal, but not for the credits.
 * - withdrawals_more: more came out of a 529 than the expenses marked for this student.
 * - no_double: the same expenses can't count for both a credit and a tax-free 529 withdrawal.
 */
export const EDUCATION_NOTES = [
  'unassigned',
  'credits',
  'room_board',
  'withdrawals_more',
  'no_double',
] as const;
export type EducationNote = (typeof EDUCATION_NOTES)[number];

export interface EducationStudentView {
  key: string;
  memberId: string | null;
  name: string;
  isDependent: boolean;
  expenses: { type: EducationStudentDto['expenses'][number]['type']; amount: string }[];
  expenseTotal: string;
  withdrawals529: string;
  plans: EducationStudentDto['plans'];
  notes: EducationNote[];
}

export interface EducationView {
  /** No category is marked yet: the page says how to mark one. */
  needsCategories: boolean;
  students: EducationStudentView[];
}

export function educationView(s: EducationSummaryDto): EducationView {
  const students = s.students
    .filter((x) => BigInt(x.expenseTotal) !== 0n || BigInt(x.withdrawals529) !== 0n)
    .map((x): EducationStudentView => {
      const paid = (types: string[]) =>
        x.expenses.some((e) => types.includes(e.type) && BigInt(e.amount) > 0n);
      const expenses = BigInt(x.expenseTotal);
      const withdrawn = BigInt(x.withdrawals529);
      const notes: EducationNote[] = [];
      if (x.memberId === null) notes.push('unassigned');
      if (paid(['tuition_fees', 'books_supplies'])) notes.push('credits');
      if (paid(['room_board'])) notes.push('room_board');
      if (withdrawn > 0n && withdrawn > expenses) notes.push('withdrawals_more');
      if (withdrawn > 0n && expenses > 0n) notes.push('no_double');
      return {
        key: x.memberId ?? 'none',
        memberId: x.memberId,
        name: x.name,
        isDependent: x.isDependent,
        expenses: x.expenses.filter((e) => BigInt(e.amount) !== 0n),
        expenseTotal: x.expenseTotal,
        withdrawals529: x.withdrawals529,
        plans: x.plans,
        notes,
      };
    });
  return { needsCategories: s.categories.length === 0, students };
}

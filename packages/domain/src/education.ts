/**
 * Education tax helpers (FAM-10). The kinds of expense a spending category can mark, for a per-student summary of what
 * may matter for the American Opportunity and Lifetime Learning credits or a 529 withdrawal. Informational only:
 * nothing here decides what qualifies, who is eligible, or how much is taxable (NFR-14).
 */
export const EDUCATION_EXPENSE_TYPES = ['tuition_fees', 'books_supplies', 'room_board', 'computer'] as const;
export type EducationExpenseType = (typeof EDUCATION_EXPENSE_TYPES)[number];

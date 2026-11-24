-- FAM-10: tax helpers for education. A spending category can say which kind of education expense it holds, so a
-- summary per student and tax year can show what may matter for the education credits or a 529 withdrawal. The
-- student is the family member on the posting (`posting.member_id`), dependents are `family_member.is_dependent`, and a
-- 529 plan is `bank_account.plan_type = '529'` (migration 0024), so this one nullable column is all that is new.
-- Informational only: nothing here decides what qualifies or computes a credit.
alter table app.ledger_account
  add column education_expense_type text
    check (education_expense_type in ('tuition_fees', 'books_supplies', 'room_board', 'computer')),
  add constraint ledger_account_education_category
    check (education_expense_type is null or (is_category and type = 'expense'));

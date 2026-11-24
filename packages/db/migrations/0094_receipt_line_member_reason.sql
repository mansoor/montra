-- Who a receipt line is for, and why (owner, 2026-11-24; RCP-03, FAM-05).
--
-- A receipt line's member ("For") is now chosen in this order:
--   1. a person's own pick on the line;
--   2. a receipt-item rule that sets a member or Household;
--   3. the member a person picked by hand for the same item on an earlier receipt;
--   4. the member linked to the login that added the receipt;
--   5. Household (no member).
-- The AI no longer sets it.
--
-- Step 3 needs to tell a member picked by hand from one that came from a default, a rule or history, and the review
-- screen shows the reason beside the member, as it does for the category. `categorization` can't hold it: it is about
-- the category, and is null for a line nobody categorized. So the line gets its own reason:
--   { "source": "user" | "rule" | "history" | "adder" | "household", "explanation": "...", "ruleId": "<uuid>" | null }
-- Null for lines stored before this; their members are left as they are.
--
-- Additive: old API tasks never write the column.

alter table app.receipt_line
  add column member_reason jsonb,
  add constraint receipt_line_member_reason check (
    member_reason is null
    or (jsonb_typeof(member_reason) = 'object'
        and member_reason ->> 'source' in ('user', 'rule', 'history', 'adder', 'household'))
  );

-- Step 3: the latest hand-picked member for an item.
create index receipt_line_member_by_hand on app.receipt_line (workspace_id, item_key, updated_at desc)
  where item_key is not null and member_reason ->> 'source' = 'user';

comment on column app.receipt_line.member_reason is
  'Why the line is for its member: { source: user | rule | history | adder | household, explanation, ruleId }. Null before 0094.';

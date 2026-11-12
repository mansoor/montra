-- Statement reconciliation, extended (DE-11..15; ADR-0039). A reconciliation records the balance it opened with (the previous
-- completed one's ending balance), the cleared deposits and payments it closed with, any balance adjustment it posted,
-- and, when undone, who undid it, when and why. Un-reconciling a line is refused everywhere except on the undo path,
-- which sets `app.allow_unreconcile` for its one transaction.

-- ---------------------------------------------------------------------------------------------
-- DE-11..14: the statement chain, the adjustment and the undo, on the reconciliation itself.
-- ---------------------------------------------------------------------------------------------
alter table app.reconciliation
  -- Natural terms, like statement_balance_minor (held for assets, owed for liabilities).
  add column opening_balance_minor     bigint not null default 0,
  -- Set when completed: what the statement's cleared lines added and took away, natural terms, both >= 0.
  add column deposits_minor            bigint check (deposits_minor >= 0),
  add column payments_minor            bigint check (payments_minor >= 0),
  -- DE-12: the balance adjustment posted when it was finished with a difference (natural terms, signed).
  add column adjustment_transaction_id uuid,
  add column adjustment_minor          bigint,
  -- DE-13: undone by an owner or accountant, with the reason they gave (also in the audit log).
  add column undone_at                 timestamptz,
  add column undone_by                 uuid references app.app_user (id),
  add column undo_reason               text check (length(undo_reason) between 1 and 500);
alter table app.reconciliation
  add foreign key (workspace_id, adjustment_transaction_id) references app.transaction (workspace_id, id);

alter table app.reconciliation drop constraint reconciliation_status_check;
alter table app.reconciliation add constraint reconciliation_status_check
  check (status in ('in_progress', 'completed', 'undone'));

-- The latest completed statement per account: the chain's last link, the accounts list's "Reconciled through".
create index reconciliation_account_completed on app.reconciliation (workspace_id, ledger_account_id, statement_date desc)
  where status = 'completed';

-- Existing reconciliations: each opened with the previous completed one's ending balance, and closed with the lines it
-- reconciled. Undone ones don't exist yet.
with chain as (
  select r.workspace_id, r.id,
         lag(r.statement_balance_minor) over (partition by r.workspace_id, r.ledger_account_id
                                              order by r.statement_date, r.completed_at, r.created_at) as previous
    from app.reconciliation r
   where r.status = 'completed'
)
update app.reconciliation r set opening_balance_minor = coalesce(c.previous, 0)
  from chain c
 where c.workspace_id = r.workspace_id and c.id = r.id;

update app.reconciliation r
   set opening_balance_minor = coalesce((
         select p.statement_balance_minor from app.reconciliation p
          where p.workspace_id = r.workspace_id and p.ledger_account_id = r.ledger_account_id and p.status = 'completed'
          order by p.statement_date desc, p.completed_at desc
          limit 1), 0)
 where r.status = 'in_progress';

update app.reconciliation r
   set deposits_minor = t.deposits, payments_minor = t.payments
  from (select r2.workspace_id, r2.id,
               coalesce(sum(n.natural) filter (where n.natural > 0), 0)::bigint as deposits,
               coalesce(-sum(n.natural) filter (where n.natural < 0), 0)::bigint as payments
          from app.reconciliation r2
          left join lateral (
            select case when a.type = 'asset' then p.amount_minor else -p.amount_minor end as natural
              from app.posting p
              join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
             where p.workspace_id = r2.workspace_id and p.reconciliation_id = r2.id) n on true
         where r2.status = 'completed'
         group by r2.workspace_id, r2.id) t
 where t.workspace_id = r.workspace_id and t.id = r.id;

-- ---------------------------------------------------------------------------------------------
-- DE-13: only the undo path un-reconciles. `app.allow_unreconcile` is set for one transaction by
-- POST reconciliations/:id/undo; nothing else sets it. Even the audited locked-edit path (account moves, restores,
-- purges) can't turn a reconciled line back into a cleared one: those delete and re-insert, they don't un-reconcile.
-- ---------------------------------------------------------------------------------------------
create function app.unreconcile_allowed() returns boolean
  language sql stable as $$ select coalesce(current_setting('app.allow_unreconcile', true), '') = 'on' $$;
revoke all on function app.unreconcile_allowed() from public;
grant execute on function app.unreconcile_allowed() to montra_app;

create or replace function app.guard_posting() returns trigger language plpgsql as $$
declare je record;
begin
  -- Un-reconciling is the undo's alone, whatever else is allowed.
  if tg_op = 'UPDATE' and old.cleared = 'reconciled' and new.cleared <> 'reconciled' and not app.unreconcile_allowed() then
    raise exception 'a reconciled line can only be un-reconciled by undoing its reconciliation'
      using errcode = 'check_violation', hint = 'period.locked';
  end if;
  if app.locked_edit_allowed() then return coalesce(new, old); end if;
  select locked, entry_date, entity_id into je
    from app.journal_entry
   where workspace_id = coalesce(new.workspace_id, old.workspace_id)
     and id = coalesce(new.journal_entry_id, old.journal_entry_id);
  if not found then return coalesce(new, old); end if; -- cascade from a permitted entry delete
  if je.locked or je.entry_date <= app.locked_through(old.workspace_id, je.entity_id)
     or je.entry_date <= app.locked_through(new.workspace_id, je.entity_id)
     or (tg_op <> 'INSERT' and old.cleared = 'reconciled') then
    -- Status-only changes are allowed; un-reconciling only on the undo path (checked above), outside closed periods.
    if tg_op = 'UPDATE'
       and (to_jsonb(new) - array['cleared', 'reconciliation_id', 'updated_at'])
         = (to_jsonb(old) - array['cleared', 'reconciliation_id', 'updated_at'])
       and not (old.cleared = 'reconciled' and new.cleared <> 'reconciled'
                and coalesce(je.entry_date <= app.locked_through(old.workspace_id, je.entity_id), false)) then
      return new;
    end if;
    raise exception 'posting belongs to a locked or reconciled entry'
      using errcode = 'check_violation', hint = 'period.locked';
  end if;
  return coalesce(new, old);
end $$;

create or replace function app.guard_journal_entry() returns trigger language plpgsql as $$
declare lock_date date;
begin
  if app.locked_edit_allowed() then return coalesce(new, old); end if;
  if tg_op in ('UPDATE', 'DELETE') then
    lock_date := app.locked_through(old.workspace_id, old.entity_id);
    if old.locked or old.entry_date <= lock_date then
      -- Locking an entry (false → true) and touching bookkeeping columns is allowed; so is releasing the lock on the
      -- undo path, outside a closed period.
      if tg_op = 'UPDATE' and (to_jsonb(new) - array['locked', 'version', 'updated_at'])
                            = (to_jsonb(old) - array['locked', 'version', 'updated_at'])
                          and (new.locked or not old.locked
                               or (app.unreconcile_allowed() and (lock_date is null or old.entry_date > lock_date))) then
        return new;
      end if;
      raise exception 'journal entry % is locked (reconciled or in a closed period)', old.id
        using errcode = 'check_violation', hint = 'period.locked';
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    lock_date := app.locked_through(new.workspace_id, new.entity_id);
    if new.entry_date <= lock_date then
      raise exception 'period is locked through %; cannot post an entry dated %', lock_date, new.entry_date
        using errcode = 'check_violation', hint = 'period.locked';
    end if;
  end if;
  return coalesce(new, old);
end $$;

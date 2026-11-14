-- A Health group in the personal chart (ACC-13): medicine had nowhere obvious to go. "Healthcare" moves there from
-- Daily living, next to new "Pharmacy & medicine", "Dental & vision" and "Health insurance" categories.
--
-- This replaces app.add_personal_categories (0042) with the same steps over the new list, so one function still brings
-- any personal book up to the template. Like 0042 it only adds and tidies: nothing is deleted or archived, no
-- transaction moves, and a category the user archived stays archived. "Healthcare" moves only while it is still in
-- Daily living, so one the user put elsewhere stays there.

create or replace function app.add_personal_categories(p_workspace uuid, p_entity uuid) returns integer
  language plpgsql
  set search_path = pg_catalog
as $$
declare
  n integer := 0;
  k integer;
  e record;
  g record;
  c record;
  gid uuid;
begin
  select id, functional_currency into e
    from app.entity where workspace_id = p_workspace and id = p_entity and type = 'personal';
  if not found then return 0; end if;

  -- Renames, unless the new name is taken.
  for c in select * from (values ('Fuel & transport', 'Fuel'), ('Gifts & donations', 'Gifts')) v(old, new) loop
    update app.ledger_account a set name = c.new, updated_at = now()
     where a.workspace_id = p_workspace and a.entity_id = p_entity and a.is_category and a.name = c.old
       and not exists (select 1 from app.ledger_account b
                        where b.workspace_id = p_workspace and b.entity_id = p_entity and b.is_category
                          and lower(b.name) = lower(c.new));
    get diagnostics k = row_count;
    n := n + k;
  end loop;

  -- Groups, in the template's order.
  for g in select * from (values
      (0, 'Income', 'income'), (1, 'Fixed bills', 'fixed'), (2, 'Daily living', 'daily'), (3, 'Health', 'daily'),
      (4, 'Home', 'daily'), (5, 'Transportation', 'daily'), (6, 'Fun', 'fun'), (7, 'Taxes', 'fixed'),
      (8, 'Debt', 'debt')
    ) v(pos, name, kind) loop
    select id into gid from app.category_group
     where workspace_id = p_workspace and entity_id = p_entity and lower(name) = lower(g.name)
     order by sort_order, created_at limit 1;
    if gid is null then
      insert into app.category_group (workspace_id, entity_id, name, kind, sort_order)
      values (p_workspace, p_entity, g.name, g.kind, g.pos);
      n := n + 1;
    else
      update app.category_group set sort_order = g.pos, updated_at = now()
       where workspace_id = p_workspace and id = gid and sort_order <> g.pos;
    end if;
  end loop;
  -- Groups the user added follow the template's; system groups (900) stay last.
  update app.category_group set sort_order = 9, updated_at = now()
   where workspace_id = p_workspace and entity_id = p_entity and sort_order < 9
     and lower(name) not in ('income', 'fixed bills', 'daily living', 'health', 'home', 'transportation', 'fun',
                             'taxes', 'debt');

  -- Moves out of Daily living: "Fuel" (where "Fuel & transport" was) and "Healthcare".
  for c in select * from (values ('Fuel', 'Transportation'), ('Healthcare', 'Health')) v(name, grp) loop
    update app.ledger_account a set category_group_id = t.id, updated_at = now()
      from app.category_group t, app.category_group d
     where a.workspace_id = p_workspace and a.entity_id = p_entity and a.is_category and a.name = c.name
       and t.workspace_id = p_workspace and t.entity_id = p_entity and t.name = c.grp
       and d.workspace_id = p_workspace and d.entity_id = p_entity and d.name = 'Daily living'
       and a.category_group_id = d.id;
  end loop;

  -- Missing categories, after the group's others.
  for c in select * from (values
      ('Income', 'income', 'Bonus'), ('Income', 'income', 'Dividends'), ('Income', 'income', 'Side income'),
      ('Income', 'income', 'Pension & Social Security'), ('Income', 'income', 'Tax refund'),
      ('Income', 'income', 'Refunds & reimbursements'), ('Income', 'income', 'Gifts received'),
      ('Fixed bills', 'expense', 'HOA dues'), ('Fixed bills', 'expense', 'Home & renters insurance'),
      ('Fixed bills', 'expense', 'Auto insurance'), ('Fixed bills', 'expense', 'Life insurance'),
      ('Daily living', 'expense', 'Gym & fitness'), ('Daily living', 'expense', 'Kids'' activities'),
      ('Daily living', 'expense', 'Allowance'), ('Daily living', 'expense', 'Pets'),
      ('Daily living', 'expense', 'Legal & professional fees'),
      ('Health', 'expense', 'Healthcare'), ('Health', 'expense', 'Pharmacy & medicine'),
      ('Health', 'expense', 'Dental & vision'), ('Health', 'expense', 'Health insurance'),
      ('Home', 'expense', 'Home improvement'), ('Home', 'expense', 'Home maintenance & repairs'),
      ('Home', 'expense', 'Furniture & furnishings'), ('Home', 'expense', 'House cleaning'),
      ('Home', 'expense', 'Gardener & landscaping'), ('Home', 'expense', 'Pest control & pool service'),
      ('Home', 'expense', 'Laundry & dry cleaning'),
      ('Transportation', 'expense', 'Fuel'), ('Transportation', 'expense', 'Public transit & rideshare'),
      ('Transportation', 'expense', 'Parking & tolls'), ('Transportation', 'expense', 'Car maintenance & repairs'),
      ('Transportation', 'expense', 'Registration & DMV'),
      ('Fun', 'expense', 'Gifts'), ('Fun', 'expense', 'Charitable donations'),
      ('Taxes', 'expense', 'Property tax'), ('Taxes', 'expense', 'Income tax payments'),
      ('Taxes', 'expense', 'Tax preparation')
    ) v(grp, type, name) loop
    select id into gid from app.category_group
     where workspace_id = p_workspace and entity_id = p_entity and lower(name) = lower(c.grp)
     order by sort_order, created_at limit 1;
    insert into app.ledger_account (workspace_id, entity_id, type, subtype, name, currency, is_category,
                                    category_group_id, sort_order)
    select p_workspace, p_entity, c.type, 'category', c.name, e.functional_currency, true, gid,
           coalesce((select max(a.sort_order) + 1 from app.ledger_account a
                      where a.workspace_id = p_workspace and a.entity_id = p_entity
                        and a.category_group_id is not distinct from gid and a.is_category), 0)
     where not exists (select 1 from app.ledger_account a
                        where a.workspace_id = p_workspace and a.entity_id = p_entity and a.is_category
                          and lower(a.name) = lower(c.name));
    get diagnostics k = row_count;
    n := n + k;
  end loop;
  return n;
end $$;
revoke all on function app.add_personal_categories(uuid, uuid) from public;

select app.add_personal_categories(e.workspace_id, e.id) from app.entity e where e.type = 'personal';

-- Fuller personal categories (ACC-13). New personal books get them from the chart template (`chart-templates.ts`);
-- this brings the books that exist up to the same list. It only adds and tidies: nothing is deleted or archived, and
-- no transaction moves.
--
-- - "Fuel & transport" becomes "Fuel" in the new Transportation group, now that transit, parking and car upkeep have
--   their own categories. "Gifts & donations" becomes "Gifts", next to the new "Charitable donations". Each is renamed
--   only while the book has no category of the new name.
-- - Missing groups (Home, Transportation, Taxes) and categories are added. A category is missing when the book has
--   none of that name in any case, archived or not, so one the user archived stays archived and running it again
--   adds nothing.
-- - The template's groups are put back in the template's order; groups the user added keep their place after them.

create function app.add_personal_categories(p_workspace uuid, p_entity uuid) returns integer
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
      (0, 'Income', 'income'), (1, 'Fixed bills', 'fixed'), (2, 'Daily living', 'daily'), (3, 'Home', 'daily'),
      (4, 'Transportation', 'daily'), (5, 'Fun', 'fun'), (6, 'Taxes', 'fixed'), (7, 'Debt', 'debt')
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
  -- Groups the user added (sort_order 0 by default) follow the template's; system groups (900) stay last.
  update app.category_group set sort_order = 8, updated_at = now()
   where workspace_id = p_workspace and entity_id = p_entity and sort_order < 8
     and lower(name) not in ('income', 'fixed bills', 'daily living', 'home', 'transportation', 'fun', 'taxes', 'debt');

  -- "Fuel" moves to Transportation from Daily living, where "Fuel & transport" was.
  update app.ledger_account a set category_group_id = t.id, updated_at = now()
    from app.category_group t, app.category_group d
   where a.workspace_id = p_workspace and a.entity_id = p_entity and a.is_category and a.name = 'Fuel'
     and t.workspace_id = p_workspace and t.entity_id = p_entity and t.name = 'Transportation'
     and d.workspace_id = p_workspace and d.entity_id = p_entity and d.name = 'Daily living'
     and a.category_group_id = d.id;

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

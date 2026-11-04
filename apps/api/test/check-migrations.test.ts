import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain script with no types
import { check } from '../../../scripts/check-migrations.mjs';

const why = (sql: string) => check('x.sql', sql).map((p: { why: string }) => p.why);

describe('check-migrations (OPS-03, OPS-04)', () => {
  it('refuses what would break a task still running the old code', () => {
    expect(why('drop table app.foo;')).toEqual(['drops a table']);
    expect(why('alter table app.foo drop column bar;')).toEqual(['drops a column']);
    expect(why('alter table app.foo rename column a to b;')).toEqual(['renames something']);
    expect(why('alter table app.foo rename to bar;')).toEqual(['renames a table']);
    expect(why('alter table app.foo alter column a type text;')).toEqual(['changes a column type']);
    expect(why('alter table app.foo alter column a set not null;')).toEqual([
      'adds NOT NULL to an existing column',
    ]);
    expect(why('alter table app.foo add column a text not null;')).toEqual([
      'adds a NOT NULL column with no default',
    ]);
  });

  it('lets through what old code can live with', () => {
    expect(why('create table app.foo (id uuid not null);')).toEqual([]);
    expect(why('alter table app.foo add column a text;')).toEqual([]);
    expect(why("alter table app.foo add column a text not null default 'x';")).toEqual([]);
    expect(why('create index foo_a on app.foo (a);')).toEqual([]);
  });

  it('ignores comments, and accepts a contract step that says why', () => {
    expect(why('-- we could drop table app.foo later')).toEqual([]);
    expect(
      why('-- contract: nothing has read bar since v1.2.0\nalter table app.foo drop column bar;'),
    ).toEqual([]);
    expect(why('-- contract:\nalter table app.foo drop column bar;')).toEqual(['drops a column']);
  });
});

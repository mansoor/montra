import { describe, expect, it } from 'vitest';
import { sankeyColumns } from './planning';

describe('sankeyColumns (FLOW-02, FLOW-06)', () => {
  it('keeps the four columns when no money moves between books', () => {
    const { column, count } = sankeyColumns(
      [
        { id: 'income:1', kind: 'income' },
        { id: 'entity:p', kind: 'entity' },
        { id: 'group:g', kind: 'group' },
        { id: 'category:c', kind: 'category' },
        { id: 'unspent:p', kind: 'unspent' },
      ],
      [
        { source: 'income:1', target: 'entity:p' },
        { source: 'entity:p', target: 'group:g' },
        { source: 'group:g', target: 'category:c' },
        { source: 'entity:p', target: 'unspent:p' },
      ],
    );
    expect(count).toBe(4);
    expect([...column.values()]).toEqual([0, 1, 2, 3, 2]);
  });

  it('puts a book that receives an owner draw to the right of the business', () => {
    const { column, count } = sankeyColumns(
      [
        { id: 'entity:p', kind: 'entity' },
        { id: 'entity:b', kind: 'entity' },
        { id: 'entity:r', kind: 'entity' },
        { id: 'group:g', kind: 'group' },
        { id: 'category:c', kind: 'category' },
      ],
      [
        { source: 'entity:b', target: 'entity:p' },
        { source: 'entity:p', target: 'entity:r' },
        { source: 'entity:p', target: 'group:g' },
      ],
    );
    expect(count).toBe(6);
    expect(column.get('entity:b')).toBe(1);
    expect(column.get('entity:p')).toBe(2);
    expect(column.get('entity:r')).toBe(3);
    expect(column.get('group:g')).toBe(4);
    expect(column.get('category:c')).toBe(5);
  });

  it('puts transfer nodes with income when they feed a book, with the groups when a book pays into them', () => {
    const { column } = sankeyColumns(
      [
        { id: 'transfer:b:p', kind: 'transfer' },
        { id: 'entity:p', kind: 'entity' },
        { id: 'transfer:p:r', kind: 'transfer' },
      ],
      [
        { source: 'transfer:b:p', target: 'entity:p' },
        { source: 'entity:p', target: 'transfer:p:r' },
      ],
    );
    expect(column.get('transfer:b:p')).toBe(0);
    expect(column.get('transfer:p:r')).toBe(2);
  });

  it('still ends when books send money round in a loop', () => {
    const { count } = sankeyColumns(
      [
        { id: 'entity:a', kind: 'entity' },
        { id: 'entity:b', kind: 'entity' },
      ],
      [
        { source: 'entity:a', target: 'entity:b' },
        { source: 'entity:b', target: 'entity:a' },
      ],
    );
    expect(count).toBe(5);
  });
});

/**
 * A receipt's or bill's pages fixed after capture (ADR-0059 §4, VLT-15): the new order a move or a removal gives, or
 * null when it can't be done (the first page up, the last page down, the only page removed).
 */
export function movePage(ids: readonly string[], index: number, by: -1 | 1): string[] | null {
  const to = index + by;
  if (index < 0 || index >= ids.length || to < 0 || to >= ids.length) return null;
  const next = [...ids];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

/** The pages without the one at `index`; null for the only page, which goes only with its record. */
export function removePage(ids: readonly string[], index: number): string[] | null {
  if (ids.length <= 1 || index < 0 || index >= ids.length) return null;
  return ids.filter((_, i) => i !== index);
}

/**
 * Adding a category from the phone's category picker (ACC-11). Pure: which books and group a new category goes in, and
 * whether its name is already taken. The server decides for real; this only pre-fills and warns early.
 */
import type { CategoryDto, CategoryGroupDto, EntityDto } from '@montra/schemas';

type Kind = 'income' | 'expense';

/** The books a new category goes in: the ones the visible categories belong to when that's one set, else Personal. */
export function defaultEntityId(
  entities: readonly Pick<EntityDto, 'id' | 'type'>[],
  categories: readonly Pick<CategoryDto, 'entityId'>[],
): string | null {
  const shown = new Set(categories.map((c) => c.entityId));
  if (shown.size === 1) {
    const only = [...shown][0]!;
    if (entities.some((e) => e.id === only)) return only;
  }
  return entities.find((e) => e.type === 'personal')?.id ?? entities[0]?.id ?? null;
}

/** Where a spending category goes by default in each kind of books. */
const SPENDING: Record<EntityDto['type'], CategoryGroupDto['kind']> = {
  personal: 'daily',
  business: 'business',
  rental: 'rental',
};

/** The groups a category of this kind may go in, the usual one first. */
export function groupChoices(
  groups: readonly CategoryGroupDto[],
  entityType: EntityDto['type'],
  kind: Kind,
): CategoryGroupDto[] {
  const fit = groups.filter((g) => g.kind !== 'system' && (g.kind === 'income') === (kind === 'income'));
  const usual = kind === 'income' ? 'income' : SPENDING[entityType];
  return [...fit].sort((a, b) => Number(b.kind === usual) - Number(a.kind === usual));
}

/** The search text, tidied, as the new category's name: "  miscellaneous " → "Miscellaneous". */
export function suggestedName(query: string): string {
  const s = query.trim().replace(/\s+/g, ' ');
  return s ? s[0]!.toUpperCase() + s.slice(1) : '';
}

/** An active category of these books and kind with the same name, ignoring case and spacing. */
export function nameTaken(
  categories: readonly Pick<CategoryDto, 'entityId' | 'type' | 'name'>[],
  entityId: string,
  kind: Kind,
  name: string,
): boolean {
  const key = name.trim().replace(/\s+/g, ' ').toLowerCase();
  return categories.some(
    (c) =>
      c.entityId === entityId && c.type === kind && c.name.trim().replace(/\s+/g, ' ').toLowerCase() === key,
  );
}

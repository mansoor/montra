import type { EntityDto, MemberRole } from '@montra/schemas';

/**
 * What the signed-in login may do on the phone (AUTH-18), worked out from the workspace's role and each book's access.
 * It only decides what to show: the API refuses anything else (AUTH-14..17), so this mirrors the server's rules:
 *
 * - **record**: add and edit transactions, work the review queue, capture and match receipts, log trips. Everyone but
 *   a viewer, in books they can write. Members also submit staff spending claims (PRL-11) under this.
 * - **setUp**: categories, budgets, goals, suggestions, payslips, rent and loan payments, a business's profile,
 *   planning settings. Not members (the server's member allowlist) or viewers.
 * - **importFiles**: statement imports, which the server allows owners, admins, partners and accountants.
 * - **backUp**: a whole-workspace backup, owners and admins only.
 */
export interface Abilities {
  role: MemberRole;
  record: boolean;
  setUp: boolean;
  importFiles: boolean;
  backUp: boolean;
  /** True when the login may write these books. An unknown book (not loaded yet) is left to the server. */
  writes: (entityId: string | null | undefined) => boolean;
}

type Workspace = {
  role: MemberRole;
  entities: Array<Pick<EntityDto, 'id'> & Partial<Pick<EntityDto, 'access'>>>;
};

const IMPORTERS: readonly MemberRole[] = ['owner', 'admin', 'partner', 'accountant'];

export const isAdminRole = (role: MemberRole): boolean => role === 'owner' || role === 'admin';

export function abilitiesOf(ws: Workspace): Abilities {
  const role = ws.role;
  // A workspace cached by an older build has no `access`: treat it as writable and let the server decide.
  const readOnly = new Set(ws.entities.filter((e) => e.access === 'read').map((e) => e.id));
  const anyWritable = ws.entities.some((e) => !readOnly.has(e.id));
  const record = role !== 'viewer' && anyWritable;
  return {
    role,
    record,
    setUp: record && role !== 'member',
    importFiles: anyWritable && IMPORTERS.includes(role),
    backUp: isAdminRole(role),
    writes: (entityId) => role !== 'viewer' && !(entityId && readOnly.has(entityId)),
  };
}

/** Nothing allowed: before sign-in, or while the workspace is still loading. */
export const NO_ABILITIES: Abilities = {
  role: 'viewer',
  record: false,
  setUp: false,
  importFiles: false,
  backUp: false,
  writes: () => false,
};

/** Whether a transaction on this account may be changed: the login records, and the account's books are writable. */
export function canChangeOn(
  can: Abilities,
  accounts: ReadonlyArray<{ id: string; entityId: string }>,
  accountId: string | null | undefined,
): boolean {
  return can.record && can.writes(accounts.find((a) => a.id === accountId)?.entityId);
}

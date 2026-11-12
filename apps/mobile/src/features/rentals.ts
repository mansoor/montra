/**
 * Rentals on the phone (08 §3): this month's rent and logging a payment. The numbers all come from the server, and no ledger
 * logic lives here; properties, leases and reports are managed on the web.
 */
import {
  RENTAL_CONTACT_ROLES,
  type AccountDto,
  type PropertyDto,
  type RentalContactDto,
  type RentRollDto,
  type TenantDto,
} from '@montra/schemas';

type RollRow = RentRollDto['rows'][number];

/** Who still owes this month first, largest first; then those who've paid, by name. */
export function rollInOrder(rows: readonly RollRow[]): RollRow[] {
  return [...rows].sort((a, b) => {
    const open = BigInt(b.open) - BigInt(a.open);
    if (open !== 0n) return open > 0n ? 1 : -1;
    return `${a.propertyName} ${a.unitLabel}`.localeCompare(`${b.propertyName} ${b.unitLabel}`);
  });
}

/** Rent lands in a bank or cash account; the portfolio's own are offered first. */
export function rentAccounts(accounts: readonly AccountDto[], entityId: string): AccountDto[] {
  return accounts
    .filter((a) => ['checking', 'savings', 'cash'].includes(a.kind))
    .sort((a, b) => Number(b.entityId === entityId) - Number(a.entityId === entityId));
}

/** A phone number as a `tel:` URL: digits and a leading +, an extension after a pause (RNT-22). */
export function telUrl(phone: string | null | undefined): string | null {
  const s = phone?.trim();
  if (!s) return null;
  const [main = '', ext] = s.split(/\s*(?:ext\.?|x|#)\s*/i);
  const digits = main.replace(/[^\d]/g, '');
  if (!digits) return null;
  const plus = main.trimStart().startsWith('+') ? '+' : '';
  const extDigits = ext?.replace(/[^\d]/g, '');
  return `tel:${plus}${digits}${extDigits ? `,${extDigits}` : ''}`;
}

/** A `mailto:` URL, only for something shaped like an address. */
export function mailtoUrl(email: string | null | undefined): string | null {
  const s = email?.trim();
  return s && /^[^\s@<>"?&]+@[^\s@<>"?&]+\.[^\s@<>"?&]+$/.test(s) ? `mailto:${s}` : null;
}

export interface PropertyContacts {
  /** Null: contacts linked to no property, for the whole portfolio. */
  propertyId: string | null;
  propertyName: string;
  contacts: RentalContactDto[];
}

const roleRank = (c: RentalContactDto) => RENTAL_CONTACT_ROLES.indexOf(c.role);

/**
 * Each property with its contacts, by role then name; a contact serving several properties shows under each. Properties
 * with none are left out, and contacts on no property come last, for the whole portfolio.
 */
export function contactsByProperty(
  contacts: readonly RentalContactDto[],
  properties: readonly Pick<PropertyDto, 'id' | 'name'>[],
  wholePortfolio: string,
): PropertyContacts[] {
  const live = contacts
    .filter((c) => !c.archived)
    .sort((a, b) => roleRank(a) - roleRank(b) || a.companyName.localeCompare(b.companyName));
  const out: PropertyContacts[] = [...properties]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({
      propertyId: p.id,
      propertyName: p.name,
      contacts: live.filter((c) => c.propertyIds.includes(p.id)),
    }))
    .filter((g) => g.contacts.length > 0);
  const known = new Set(properties.map((p) => p.id));
  const loose = live.filter((c) => !c.propertyIds.some((id) => known.has(id)));
  if (loose.length) out.push({ propertyId: null, propertyName: wholePortfolio, contacts: loose });
  return out;
}

/** Tenants who live somewhere now first, by property and unit; the rest by name. */
export function tenantsByHome(tenants: readonly TenantDto[]): TenantDto[] {
  const where = (t: TenantDto) => (t.current ? `${t.current.propertyName} ${t.current.unitLabel}` : '');
  return [...tenants].sort(
    (a, b) =>
      Number(!a.current) - Number(!b.current) ||
      where(a).localeCompare(where(b)) ||
      a.name.localeCompare(b.name),
  );
}

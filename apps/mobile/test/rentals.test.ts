import { describe, expect, it } from 'vitest';
import type { AccountDto, RentalContactDto, RentRollDto, TenantDto } from '@montra/schemas';
import {
  contactsByProperty,
  mailtoUrl,
  rentAccounts,
  rollInOrder,
  telUrl,
  tenantsByHome,
} from '../src/features/rentals';

const row = (propertyName: string, open: string) =>
  ({ propertyName, unitLabel: 'Main', open }) as RentRollDto['rows'][number];
const account = (id: string, kind: string, entityId: string) => ({ id, kind, entityId }) as AccountDto;

describe('rollInOrder', () => {
  it('puts the largest unpaid first, then the rest by name', () => {
    const out = rollInOrder([row('B', '0'), row('C', '100'), row('A', '0'), row('D', '900')]);
    expect(out.map((r) => r.propertyName)).toEqual(['D', 'C', 'A', 'B']);
  });
});

describe('rentAccounts', () => {
  it('keeps accounts rent can land in, with the portfolio own first', () => {
    const out = rentAccounts(
      [
        account('personal', 'checking', 'p'),
        account('card', 'credit_card', 'r'),
        account('loan', 'mortgage', 'r'),
        account('rental', 'savings', 'r'),
      ],
      'r',
    );
    expect(out.map((a) => a.id)).toEqual(['rental', 'personal']);
  });
});

const contact = (
  id: string,
  role: RentalContactDto['role'],
  companyName: string,
  propertyIds: string[],
  archived = false,
) => ({ id, role, companyName, propertyIds, archived }) as RentalContactDto;

describe('telUrl and mailtoUrl (RNT-22)', () => {
  it('dials digits and a leading plus, with an extension after a pause', () => {
    expect(telUrl('(800) 555-0100')).toBe('tel:8005550100');
    expect(telUrl('+1 415 555 0100 ext. 12')).toBe('tel:+14155550100,12');
    expect(telUrl('call us')).toBeNull();
    expect(telUrl(null)).toBeNull();
  });

  it('mails only something shaped like an address', () => {
    expect(mailtoUrl(' claims@acme.example ')).toBe('mailto:claims@acme.example');
    expect(mailtoUrl('not an email')).toBeNull();
    expect(mailtoUrl('a@b.example?cc=x@y.example')).toBeNull();
  });
});

describe('contactsByProperty (RNT-22)', () => {
  it('shows a shared contact under each property, by role, and the rest for the portfolio', () => {
    const groups = contactsByProperty(
      [
        contact('power', 'electricity', 'City Power', ['a']),
        contact('ins', 'insurance', 'Acme Mutual', ['a', 'b']),
        contact('pm', 'property_manager', 'Keys PM', []),
        contact('old', 'gas', 'Old Gas', ['a'], true),
      ],
      [
        { id: 'b', name: 'Birch House' },
        { id: 'a', name: 'Aspen House' },
        { id: 'c', name: 'Cedar House' },
      ],
      'Whole portfolio',
    );
    expect(groups.map((g) => [g.propertyName, g.contacts.map((c) => c.id)])).toEqual([
      ['Aspen House', ['ins', 'power']],
      ['Birch House', ['ins']],
      ['Whole portfolio', ['pm']],
    ]);
  });
});

describe('tenantsByHome (RNT-22)', () => {
  it('lists tenants who live somewhere now first, by property', () => {
    const t = (name: string, propertyName?: string) =>
      ({ name, current: propertyName ? { propertyName, unitLabel: 'Main' } : null }) as TenantDto;
    expect(tenantsByHome([t('Zed'), t('Amy', 'Pine'), t('Bo', 'Elm'), t('Al')]).map((x) => x.name)).toEqual([
      'Bo',
      'Amy',
      'Al',
      'Zed',
    ]);
  });
});

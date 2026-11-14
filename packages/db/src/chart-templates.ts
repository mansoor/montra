/**
 * Default chart of accounts per entity type (UP-03 onboarding templates, BIZ-02 Schedule C, RNT-06 Schedule E).
 * US-first; tax line codes are reference data keyed by country (docs/design/10 assumption 1).
 */
import type { AccountType, EntityType, SystemRole } from '@montra/domain';
import type { CategoryGroupTable } from './types.js';

export interface CategoryTemplate {
  name: string;
  type: Extract<AccountType, 'income' | 'expense'>;
  taxLine?: string;
}

export interface GroupTemplate {
  name: string;
  kind: CategoryGroupTable['kind'];
  categories: CategoryTemplate[];
}

export interface SystemAccountTemplate {
  role: SystemRole;
  name: string;
  type: AccountType;
}

const expense = (name: string, taxLine?: string): CategoryTemplate => ({ name, type: 'expense', taxLine });
const income = (name: string, taxLine?: string): CategoryTemplate => ({ name, type: 'income', taxLine });

/**
 * The personal chart (UP-03, ACC-13). `app.add_personal_categories` (migration 0042, last replaced in 0046) brings
 * personal books made from an older version of this list up to it; keep the two in step when it changes.
 */
const PERSONAL: GroupTemplate[] = [
  {
    name: 'Income',
    kind: 'income',
    categories: [
      income('Salary'),
      income('Bonus'),
      income('Interest income'),
      income('Dividends'),
      income('Side income'),
      income('Pension & Social Security'),
      income('Tax refund'),
      income('Refunds & reimbursements'),
      income('Gifts received'),
      income('Other income'),
    ],
  },
  {
    name: 'Fixed bills',
    kind: 'fixed',
    categories: [
      expense('Rent'),
      expense('Mortgage interest'),
      expense('HOA dues'),
      expense('Utilities'),
      expense('Phone & internet'),
      expense('Subscriptions'),
      expense('Home & renters insurance'),
      expense('Auto insurance'),
      expense('Life insurance'),
      // Any other cover: umbrella, travel, pet.
      expense('Insurance'),
    ],
  },
  {
    name: 'Daily living',
    kind: 'daily',
    categories: [
      expense('Groceries'),
      expense('Dining out'),
      expense('Household'),
      expense('Gym & fitness'),
      expense('Personal care'),
      expense('Clothing'),
      expense('Electronics'),
      expense('Education'),
      expense('Childcare'),
      expense("Kids' activities"),
      expense('Allowance'),
      expense('Pets'),
      expense('Legal & professional fees'),
      // ACC-12: for the small things that fit nowhere else (a bag fee at the till).
      expense('Miscellaneous'),
    ],
  },
  {
    name: 'Health',
    kind: 'daily',
    categories: [
      expense('Healthcare'),
      expense('Pharmacy & medicine'),
      expense('Dental & vision'),
      expense('Health insurance'),
    ],
  },
  {
    name: 'Home',
    kind: 'daily',
    categories: [
      expense('Home improvement'),
      expense('Home maintenance & repairs'),
      expense('Furniture & furnishings'),
      expense('House cleaning'),
      expense('Gardener & landscaping'),
      expense('Pest control & pool service'),
      expense('Laundry & dry cleaning'),
    ],
  },
  {
    name: 'Transportation',
    kind: 'daily',
    categories: [
      expense('Fuel'),
      expense('Public transit & rideshare'),
      expense('Parking & tolls'),
      expense('Car maintenance & repairs'),
      expense('Registration & DMV'),
    ],
  },
  {
    name: 'Fun',
    kind: 'fun',
    categories: [
      expense('Entertainment'),
      expense('Travel'),
      expense('Gifts'),
      expense('Charitable donations'),
      expense('Hobbies'),
    ],
  },
  {
    name: 'Taxes',
    kind: 'fixed',
    categories: [expense('Property tax'), expense('Income tax payments'), expense('Tax preparation')],
  },
  { name: 'Debt', kind: 'debt', categories: [expense('Interest & finance charges')] },
];

const BUSINESS: GroupTemplate[] = [
  {
    name: 'Revenue',
    kind: 'income',
    categories: [income('Sales & services', 'US_SCH_C_L1'), income('Other business income', 'US_SCH_C_L6')],
  },
  {
    name: 'Business expenses',
    kind: 'business',
    categories: [
      expense('Advertising', 'US_SCH_C_L8'),
      expense('Car & truck', 'US_SCH_C_L9'),
      expense('Commissions & fees', 'US_SCH_C_L10'),
      expense('Contract labor', 'US_SCH_C_L11'),
      expense('Insurance', 'US_SCH_C_L15'),
      expense('Interest', 'US_SCH_C_L16B'),
      expense('Legal & professional', 'US_SCH_C_L17'),
      expense('Office expense', 'US_SCH_C_L18'),
      expense('Rent or lease', 'US_SCH_C_L20B'),
      expense('Repairs & maintenance', 'US_SCH_C_L21'),
      expense('Supplies', 'US_SCH_C_L22'),
      expense('Taxes & licenses', 'US_SCH_C_L23'),
      expense('Travel', 'US_SCH_C_L24A'),
      expense('Meals', 'US_SCH_C_L24B'),
      expense('Utilities', 'US_SCH_C_L25'),
      expense('Software & subscriptions', 'US_SCH_C_L27A'),
      expense('Other expenses', 'US_SCH_C_L27A'),
    ],
  },
];

const RENTAL: GroupTemplate[] = [
  {
    name: 'Rental income',
    kind: 'income',
    categories: [income('Rents received', 'US_SCH_E_L3'), income('Other rental income', 'US_SCH_E_L3')],
  },
  {
    name: 'Rental expenses',
    kind: 'rental',
    categories: [
      expense('Advertising', 'US_SCH_E_L5'),
      expense('Auto & travel', 'US_SCH_E_L6'),
      expense('Cleaning & maintenance', 'US_SCH_E_L7'),
      expense('Commissions', 'US_SCH_E_L8'),
      expense('Insurance', 'US_SCH_E_L9'),
      expense('Legal & professional', 'US_SCH_E_L10'),
      expense('Management fees', 'US_SCH_E_L11'),
      expense('Mortgage interest', 'US_SCH_E_L12'),
      expense('Other interest', 'US_SCH_E_L13'),
      expense('Repairs', 'US_SCH_E_L14'),
      expense('Supplies', 'US_SCH_E_L15'),
      expense('Taxes', 'US_SCH_E_L16'),
      expense('Utilities', 'US_SCH_E_L17'),
      expense('Depreciation', 'US_SCH_E_L18'),
      // RNT-20: on line 19 (Other), which the return asks to be listed. Migration 0038 adds them to existing books.
      expense('HOA dues', 'US_SCH_E_L19'),
      expense('Home warranty', 'US_SCH_E_L19'),
      expense('Other', 'US_SCH_E_L19'),
    ],
  },
];

const COMMON_SYSTEM: SystemAccountTemplate[] = [
  { role: 'opening_balance_equity', name: 'Opening balance equity', type: 'equity' },
  { role: 'uncategorized_income', name: 'Uncategorized income', type: 'income' },
  { role: 'uncategorized_expense', name: 'Uncategorized expense', type: 'expense' },
  { role: 'fx_gain_loss', name: 'FX gain/loss', type: 'expense' },
  { role: 'fx_rounding', name: 'FX rounding', type: 'expense' },
  { role: 'bank_fees', name: 'Bank fees', type: 'expense' },
  { role: 'investment_gains', name: 'Investment gains and losses', type: 'equity' },
];

export function groupTemplates(type: EntityType): GroupTemplate[] {
  return type === 'personal' ? PERSONAL : type === 'business' ? BUSINESS : RENTAL;
}

export function systemAccountTemplates(type: EntityType): SystemAccountTemplate[] {
  const extra: SystemAccountTemplate[] =
    type === 'personal'
      ? []
      : [
          { role: 'owner_contribution', name: 'Owner contribution', type: 'equity' },
          { role: 'owner_draw', name: 'Owner draw', type: 'equity' },
        ];
  if (type === 'rental')
    extra.push({ role: 'security_deposits_held', name: 'Security deposits held', type: 'liability' });
  return [...COMMON_SYSTEM, ...extra];
}

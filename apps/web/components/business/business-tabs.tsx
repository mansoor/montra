'use client';

import { usePathname } from 'next/navigation';
import { LinkTabs } from '../ui/page-header';
import { useI18n } from '../i18n';

const TABS = [
  ['', 'business.tab_overview'],
  ['/invoices', 'business.tab_invoices'],
  ['/bills', 'business.tab_bills'],
  ['/parties', 'business.tab_parties'],
  ['/assets', 'business.tab_assets'],
  ['/mileage', 'business.tab_mileage'],
  ['/people', 'business.tab_people'],
  ['/payroll', 'business.tab_payroll'],
  ['/taxes', 'business.tab_taxes'],
  ['/receipts', 'business.tab_receipts'],
  ['/settings', 'business.tab_settings'],
] as const;

/** One business's sections; a client component because a layout can't see which page it's wrapping. */
export function BusinessTabs({ base }: { base: string }) {
  const { t } = useI18n();
  const path = usePathname();
  const current =
    TABS.slice(1).find(
      ([suffix]) => path === `${base}${suffix}` || path.startsWith(`${base}${suffix}/`),
    )?.[0] ?? '';
  return (
    <LinkTabs
      label={t('business.sections')}
      current={current}
      tabs={TABS.map(([suffix, label]) => ({ key: suffix, href: `${base}${suffix}`, label: t(label) }))}
    />
  );
}

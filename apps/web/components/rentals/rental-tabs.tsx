'use client';

import { usePathname } from 'next/navigation';
import { LinkTabs } from '../ui/page-header';
import { useI18n } from '../i18n';

const TABS = [
  ['', 'rentals.tab_overview'],
  ['/properties', 'rentals.tab_properties'],
  ['/tenants', 'rentals.tab_tenants'],
  ['/rent-roll', 'rentals.tab_rent_roll'],
  ['/arrears', 'rentals.tab_arrears'],
  ['/mortgages', 'rentals.tab_mortgages'],
  ['/maintenance', 'rentals.tab_maintenance'],
  ['/reminders', 'rentals.tab_reminders'],
  ['/schedule-e', 'rentals.tab_schedule_e'],
  ['/settings', 'rentals.tab_settings'],
] as const;

/** One portfolio's sections. */
export function RentalTabs({ base }: { base: string }) {
  const { t } = useI18n();
  const path = usePathname();
  // A lease is reached from its property, so that's the section it's in.
  const here = path.startsWith(`${base}/leases/`) ? `${base}/properties` : path;
  const current =
    TABS.slice(1).find(
      ([suffix]) => here === `${base}${suffix}` || here.startsWith(`${base}${suffix}/`),
    )?.[0] ?? '';
  return (
    <LinkTabs
      label={t('rentals.sections')}
      current={current}
      tabs={TABS.map(([suffix, label]) => ({ key: suffix, href: `${base}${suffix}`, label: t(label) }))}
    />
  );
}

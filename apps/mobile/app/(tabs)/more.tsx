/** More (08 §3): review, planning, accounts and registers, import, sync activity, settings, grouped by what they're for. */
import { useRouter, type Href } from 'expo-router';
import { t } from '../../src/i18n';
import { useAbilities, useSession } from '../../src/session/SessionProvider';
import { useSync } from '../../src/sync/SyncProvider';
import { Card, Row, Screen, SectionLabel, Small, Title } from '../../src/ui/components';
import type { IconName } from '../../src/ui/icons';

interface Item {
  title: string;
  icon: IconName;
  href: Href;
  testID: string;
  subtitle?: string;
}

export default function More() {
  const router = useRouter();
  const { state } = useSession();
  const { state: sync } = useSync();
  const can = useAbilities();
  const queued = sync ? sync.pending + sync.drafts : 0;
  const sections: Array<{ label: string; items: Item[] }> = [
    {
      label: t('mobile.more.section.everyday'),
      items: [
        ...(can.record
          ? [
              {
                title: t('mobile.tab.review'),
                icon: 'review',
                href: '/review',
                testID: 'more-review',
                ...(sync?.reviewCount
                  ? { subtitle: t('mobile.more.review_count', { count: sync.reviewCount }) }
                  : {}),
              } as Item,
            ]
          : []),
        { title: t('mobile.more.accounts'), icon: 'accounts', href: '/accounts', testID: 'more-accounts' },
        { title: t('mobile.more.receipts'), icon: 'receipt', href: '/receipts', testID: 'more-receipts' },
        { title: t('nav.payslips'), icon: 'payslips', href: '/payslips', testID: 'more-payslips' },
        // Imports are for those who set the books up (AUTH-18).
        ...(can.importFiles
          ? [
              {
                title: t('mobile.more.import'),
                icon: 'import',
                href: '/import',
                testID: 'more-import',
              } as Item,
            ]
          : []),
      ],
    },
    {
      label: t('mobile.more.section.planning'),
      items: [
        { title: t('nav.goals'), icon: 'goals', href: '/goals', testID: 'more-goals' },
        { title: t('nav.cash_flow'), icon: 'cashFlow', href: '/cash-flow', testID: 'more-cash-flow' },
        { title: t('nav.explore'), icon: 'explore', href: '/explore', testID: 'more-explore' },
        { title: t('nav.month'), icon: 'monthReview', href: '/month', testID: 'more-month' },
        { title: t('nav.calendar'), icon: 'calendar', href: '/calendar', testID: 'more-calendar' },
        {
          title: t('nav.suggestions'),
          icon: 'suggestions',
          href: '/suggestions',
          testID: 'more-suggestions',
        },
      ],
    },
    {
      label: t('mobile.more.section.property'),
      items: [
        { title: t('nav.business'), icon: 'business', href: '/business', testID: 'more-business' },
        { title: t('nav.rentals'), icon: 'rentals', href: '/rentals', testID: 'more-rentals' },
      ],
    },
    {
      label: t('mobile.more.section.app'),
      items: [
        {
          title: t('notifications.title'),
          icon: 'notifications',
          href: '/notifications',
          testID: 'more-notifications',
        },
        {
          title: t('mobile.more.activity'),
          icon: 'activity',
          href: '/activity',
          testID: 'more-activity',
          ...(queued > 0 ? { subtitle: t('mobile.activity.queue', { count: queued }) } : {}),
        },
        { title: t('settings.tab.data'), icon: 'data', href: '/your-data', testID: 'more-your-data' },
        { title: t('mobile.more.settings'), icon: 'settings', href: '/settings', testID: 'more-settings' },
      ],
    },
  ];
  return (
    <Screen testID="more">
      <Title>{t('mobile.tab.more')}</Title>
      {sections.map((s) => (
        <Card key={s.label} style={{ paddingVertical: 0, gap: 0 }}>
          <SectionLabel>{s.label}</SectionLabel>
          {s.items.map((i, n) => (
            <Row
              key={i.testID}
              title={i.title}
              subtitle={i.subtitle}
              icon={i.icon}
              onPress={() => router.push(i.href)}
              testID={i.testID}
              last={n === s.items.length - 1}
            />
          ))}
        </Card>
      ))}
      {state.status === 'signed_in' ? (
        <Small>
          {t('mobile.more.signed_in_as_role', { email: state.me.email, role: t(`role.${can.role}`) })}
          {can.record ? '' : ` ${t('mobile.more.read_only')}`}
        </Small>
      ) : null}
    </Screen>
  );
}

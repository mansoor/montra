import type { Metadata } from 'next';
import { SelfServicePage } from '@/components/kratos/self-service-page';
import { staticT as t } from '@/lib/i18n-static';

export const metadata: Metadata = { title: 'Recover account' };
export const dynamic = 'force-dynamic';

/** Account recovery by emailed code (AUTH-05); MFA is still required afterwards. */
export default async function RecoveryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  return (
    <SelfServicePage
      kind="recovery"
      params={await searchParams}
      title={t('auth.recovery_title')}
      intro={t('auth.recovery_intro')}
    />
  );
}

import type { Metadata } from 'next';
import { SelfServicePage } from '@/components/kratos/self-service-page';
import { staticT as t } from '@/lib/i18n-static';

export const metadata: Metadata = { title: 'Verify email' };
export const dynamic = 'force-dynamic';

/** Email verification (AUTH-03): required before financial data can be added. */
export default async function VerificationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  return (
    <SelfServicePage
      kind="verification"
      params={await searchParams}
      title={t('auth.verification_title')}
      intro={t('auth.verification_intro')}
    />
  );
}

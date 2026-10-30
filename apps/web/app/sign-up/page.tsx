import type { Metadata } from 'next';
import { SelfServicePage } from '@/components/kratos/self-service-page';
import { staticT as t } from '@/lib/i18n-static';

export const metadata: Metadata = { title: 'Create account' };
export const dynamic = 'force-dynamic';

/** Registration flow (AUTH-01, AUTH-02): Kratos checks password length and breach lists. */
export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  return (
    <SelfServicePage
      kind="registration"
      params={await searchParams}
      title={t('auth.sign_up_title')}
      intro={t('auth.sign_up_intro')}
    />
  );
}

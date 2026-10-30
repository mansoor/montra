import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AUTH_MODE } from '@/lib/session';
import { fetchFlow, flowInitUrl, KRATOS_ORIGIN, safeReturnTo } from '@/lib/kratos';
import { SETTINGS_GROUPS, toRenderModel } from '@/lib/kratos-ui';
import { getI18n } from '@/lib/i18n-server';
import { FlowForm, FlowMessages } from '@/components/kratos/flow-form';
import { I18nProvider } from '@/components/i18n';
import { SessionsList } from '@/components/sessions-list';

export const metadata: Metadata = { title: 'Security' };
export const dynamic = 'force-dynamic';

/**
 * Security settings (AUTH-04, AUTH-07): password, authenticator app (TOTP), passkeys and recovery codes come
 * from the Kratos settings flow, one form per method; the device list comes from the API.
 */
export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const { me, t } = await getI18n();
  let sections: { group: string; model: ReturnType<typeof toRenderModel> }[] = [];
  let flowMessages: ReturnType<typeof toRenderModel>['messages'] = [];
  if (AUTH_MODE === 'kratos') {
    const init = { return_to: safeReturnTo(params.return_to) };
    if (!params.flow) redirect(flowInitUrl('settings', init));
    const flow = await fetchFlow('settings', params.flow, init);
    const all = toRenderModel(flow.ui, { kratosOrigin: KRATOS_ORIGIN });
    flowMessages = all.messages;
    sections = SETTINGS_GROUPS.filter((g) => all.groups.includes(g)).map((group) => ({
      group,
      model: { ...toRenderModel(flow.ui, { kratosOrigin: KRATOS_ORIGIN, groups: [group] }), messages: [] },
    }));
  }

  return (
    <I18nProvider locale={me.locale} dateFormat={me.dateFormat}>
      <main id="main" className="mx-auto max-w-2xl space-y-6 px-4 py-8">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">{t('security.title')}</h1>
          <Link href="/" className="text-sm text-brand-600 underline">
            {t('security.back')}
          </Link>
        </div>
        <p className="text-sm text-muted">{t('security.signed_in_as', { email: me.email })}</p>
        {AUTH_MODE !== 'kratos' && <p className="card text-sm">{t('security.dev_mode')}</p>}
        <FlowMessages messages={flowMessages} />
        {sections.map(({ group, model }) => (
          <section key={group} className="card space-y-3" aria-labelledby={`sec-${group}`}>
            <h2 id={`sec-${group}`} className="text-base font-semibold">
              {t(`security.group.${group}`)}
            </h2>
            <FlowForm model={model} label={t(`security.group.${group}`)} />
          </section>
        ))}
        <section className="card space-y-3" aria-labelledby="sec-devices">
          <h2 id="sec-devices" className="text-base font-semibold">
            {t('security.devices')}
          </h2>
          <SessionsList />
        </section>
      </main>
    </I18nProvider>
  );
}

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
import { PhoneNumber } from '@/components/settings/phone-number';
import { GatewayNotice } from '@/components/kratos/gateway-notice';
import { newPasswordProps } from '@/lib/password-policy';
import { load } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Security' };
export const dynamic = 'force-dynamic';

/**
 * Security settings (AUTH-04, AUTH-07): password, authenticator app (TOTP), passkeys and recovery codes come
 * from the Kratos settings flow, one form per method; the device list comes from the API.
 */
const MFA_SETUP = 'mfa_setup';

/** The page to go back to, marked as a trip to set up two-step verification (ADR-0044). */
function markMfaSetup(returnTo: string | undefined): string | undefined {
  const safe = safeReturnTo(returnTo);
  if (!safe) return undefined;
  const url = new URL(safe);
  url.searchParams.set(MFA_SETUP, '1');
  return url.toString();
}

const isMfaSetup = (url: string | undefined) => {
  try {
    return Boolean(url && new URL(url).searchParams.get(MFA_SETUP) === '1');
  } catch {
    return false;
  }
};

export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const { me, t } = await getI18n();
  let sections: { group: string; model: ReturnType<typeof toRenderModel> }[] = [];
  let flowMessages: ReturnType<typeof toRenderModel>['messages'] = [];
  // ADR-0049 §6: a mobile number is only asked for where texts are on; it couldn't be confirmed otherwise.
  const texts = await load((api) => api.getNotificationPrefs())
    .then((p) => p.texts.available)
    .catch(() => false);
  const newPassword =
    AUTH_MODE === 'kratos' ? await newPasswordProps({ email: me.email, name: me.displayName }) : undefined;
  // ADR-0044: sent here to set up two-step verification. Starting the flow goes through Kratos, which keeps only the
  // flow's return_to, so the reason travels in it.
  let back = params.setup === 'mfa' ? markMfaSetup(params.return_to) : safeReturnTo(params.return_to);
  if (AUTH_MODE === 'kratos') {
    const init = { return_to: back };
    if (!params.flow) redirect(flowInitUrl('settings', init));
    const flow = await fetchFlow('settings', params.flow, init);
    // The number is changed in its own section below, through the API, which confirms it by a texted code. Kratos's
    // field stays in the profile form as a hidden input with the number as it is, since a profile save replaces every
    // trait: left out, saving a new name would remove the number.
    // (With no number there's nothing to keep, and an empty one wouldn't match the trait's pattern.)
    flow.ui.nodes = flow.ui.nodes.flatMap((n) => {
      const a = n.attributes as { name?: string; value?: unknown };
      if (a.name !== 'traits.phone') return [n];
      return a.value ? [{ ...n, attributes: { ...n.attributes, type: 'hidden' } }] : [];
    });
    back ??= safeReturnTo(flow.return_to);
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
          <h1 className="page-title">{t('security.title')}</h1>
          <Link href="/" className="text-sm text-brand-600 underline">
            {t('security.back')}
          </Link>
        </div>
        <p className="text-sm text-muted">{t('security.signed_in_as', { email: me.email })}</p>
        {AUTH_MODE !== 'kratos' && <p className="card text-sm">{t('security.dev_mode')}</p>}
        <GatewayNotice params={params} />
        {(params.setup === 'mfa' || isMfaSetup(back)) && (
          <div role="status" className="card space-y-2 border-warn text-sm" data-testid="mfa-needed">
            <p>{t('security.mfa_needed')}</p>
            {back && (
              <a href={back} className="text-brand-600 underline">
                {t('security.mfa_back')}
              </a>
            )}
          </div>
        )}
        <FlowMessages messages={flowMessages} />
        {sections.map(({ group, model }) => (
          <section key={group} className="card space-y-3" aria-labelledby={`sec-${group}`}>
            <h2 id={`sec-${group}`} className="text-base font-semibold">
              {t(`security.group.${group}`)}
            </h2>
            <FlowForm
              model={model}
              label={t(`security.group.${group}`)}
              newPassword={group === 'password' ? newPassword : undefined}
            />
          </section>
        ))}
        {texts && (
          <section className="card space-y-3" aria-labelledby="sec-phone">
            <h2 id="sec-phone" className="text-base font-semibold">
              {t('phone.title')}
            </h2>
            <PhoneNumber />
          </section>
        )}
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

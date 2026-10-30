import Link from 'next/link';
import { redirect } from 'next/navigation';
import { fetchFlow, flowInitUrl, KRATOS_ORIGIN, safeReturnTo, type FlowKind } from '@/lib/kratos';
import { toRenderModel } from '@/lib/kratos-ui';
import { AUTH_MODE } from '@/lib/session';
import { staticT as t } from '@/lib/i18n-static';
import { AuthShell } from './auth-shell';
import { FlowForm } from './flow-form';

/** Sign-up, recovery and verification pages: start the flow if needed, then render its nodes. */
export async function SelfServicePage({
  kind,
  params,
  title,
  intro,
}: {
  kind: Exclude<FlowKind, 'login' | 'settings'>;
  params: Record<string, string | undefined>;
  title: string;
  intro?: string;
}) {
  if (AUTH_MODE !== 'kratos') {
    return (
      <AuthShell title={title}>
        <p className="text-sm">{t('auth.dev_mode_only')}</p>
        <Link href="/sign-in" className="btn-primary">
          {t('auth.sign_in_title')}
        </Link>
      </AuthShell>
    );
  }
  const init = { return_to: safeReturnTo(params.return_to) };
  if (!params.flow) redirect(flowInitUrl(kind, init));
  const flow = await fetchFlow(kind, params.flow, init);
  return (
    <AuthShell title={title} intro={intro}>
      <FlowForm model={toRenderModel(flow.ui, { kratosOrigin: KRATOS_ORIGIN })} label={title} />
      <p className="text-sm">
        <Link href="/sign-in" className="text-brand-600 underline">
          {t('auth.back_to_sign_in')}
        </Link>
      </p>
    </AuthShell>
  );
}

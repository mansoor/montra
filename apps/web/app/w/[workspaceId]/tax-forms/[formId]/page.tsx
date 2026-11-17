import type { Metadata } from 'next';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { taxFormContext } from '@/lib/tax-forms-server';
import { PageHeader } from '@/components/ui/page-header';
import { TaxFormDetail } from '@/components/tax-forms/tax-form-detail';

export const metadata: Metadata = { title: 'Tax form' };
export const dynamic = 'force-dynamic';

/** One tax form (ADR-0052 §7.1): its checks against the books, and what can be done about a difference. */
export default async function TaxFormPage({
  params,
}: {
  params: Promise<{ workspaceId: string; formId: string }>;
}) {
  const { workspaceId, formId } = await params;
  const [workspace, form, members, accounts] = await load((api) =>
    Promise.all([
      api.getWorkspace(workspaceId),
      api.getTaxForm(workspaceId, formId),
      api.listFamilyMembers(workspaceId),
      api.listAccounts(workspaceId),
    ]),
  );
  const { t } = await getI18n();
  const context = await taxFormContext(workspace, members, accounts);
  const person = form.personMemberId ? members.find((m) => m.id === form.personMemberId)?.name : null;
  const kind = t(`tax_forms.kind.${form.kind}`);
  return (
    <div className="space-y-5">
      <PageHeader
        title={form.issuerName ? t('tax_forms.title_from', { kind, issuer: form.issuerName }) : kind}
        subtitle={[String(form.taxYear), person ?? t('tax_forms.person_unknown')].join(' · ')}
        back={{ href: `/w/${workspace.id}/tax-forms?year=${form.taxYear}`, label: t('tax_forms.title') }}
      />
      <TaxFormDetail workspaceId={workspace.id} form={form} {...context} />
    </div>
  );
}

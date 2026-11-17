import type { Metadata } from 'next';
import { todayIn } from '@montra/domain';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { defaultTaxYear, yearChoices } from '@/lib/tax-forms';
import { taxFormContext } from '@/lib/tax-forms-server';
import { EmptyState, LinkTabs, PageHeader } from '@/components/ui/page-header';
import { TaxYearView } from '@/components/tax-forms/tax-year-view';

export const metadata: Metadata = { title: 'Tax forms' };
export const dynamic = 'force-dynamic';

/**
 * Tax forms received (ADR-0052 §7.1, TAX-04..06): for a year, the forms expected against those received, each checked
 * against the books. US forms, so for workspaces kept in US dollars; not for viewers.
 */
export default async function TaxFormsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ year?: string }>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  const [workspace, members, accounts] = await load((api) =>
    Promise.all([
      api.getWorkspace(workspaceId),
      api.listFamilyMembers(workspaceId),
      api.listAccounts(workspaceId),
    ]),
  );
  const { t } = await getI18n();
  const today = todayIn(workspace.timeZone);
  const asked = Number(sp.year);
  const year = Number.isInteger(asked) && asked >= 2000 && asked <= 2100 ? asked : defaultTaxYear(today);
  const base = `/w/${workspace.id}/tax-forms`;
  const header = <PageHeader title={t('tax_forms.title')} subtitle={t('tax_forms.subtitle')} />;
  if (workspace.role === 'viewer' || workspace.baseCurrency !== 'USD') {
    return (
      <div className="space-y-5">
        {header}
        <EmptyState
          title={t(workspace.role === 'viewer' ? 'tax_forms.not_for_viewers' : 'tax_forms.us_only')}
        />
      </div>
    );
  }
  const data = await load((api) => api.getTaxYear(workspace.id, year));
  const context = await taxFormContext(workspace, members, accounts);
  return (
    <div className="space-y-5">
      {header}
      <LinkTabs
        label={t('tax_forms.year_picker')}
        current={String(year)}
        tabs={yearChoices(today, year).map((y) => ({
          key: String(y),
          href: `${base}?year=${y}`,
          label: String(y),
        }))}
      />
      <TaxYearView workspaceId={workspace.id} data={data} {...context} />
    </div>
  );
}

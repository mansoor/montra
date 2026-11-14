import Link from 'next/link';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import {
  AccountLookup,
  AiCeilingPanel,
  FlagsPanel,
  NoticesPanel,
  PasswordPolicyPanel,
  ReferencePanel,
  SupportRequestsPanel,
} from '@/components/admin/console';
import { PlansPanel, StaffPanel } from '@/components/admin/plans';

const TABS = [
  'accounts',
  'support',
  'plans',
  'imports',
  'ai',
  'flags',
  'notices',
  'security',
  'reference',
  'staff',
] as const;
type Tab = (typeof TABS)[number];
/** Only an owner manages staff (ADR-0049 §3). */
const OWNER_TABS: readonly Tab[] = ['staff'];

/** OPS-01, OPS-05: for staff, who can't see financial data here. Anyone else gets the 404 the API gives them. */
export default async function AdminPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const raw = (await searchParams).tab;
  const staff = await load((api) => api.adminMe());
  const isOwner = staff.role === 'owner';
  const tabs = TABS.filter((k) => isOwner || !OWNER_TABS.includes(k));
  const tab: Tab = tabs.includes(raw as Tab) ? (raw as Tab) : 'accounts';
  const { t } = await getI18n();
  // Each role includes the one below it.
  const canChange = staff.role === 'admin' || isOwner;
  let body;
  if (tab === 'accounts') {
    const plans = (await load((api) => api.adminPlans())).map((p) => ({ key: p.key, name: p.name }));
    body = <AccountLookup canChange={canChange} isOwner={isOwner} plans={plans} />;
  } else if (tab === 'support') {
    body = <SupportRequestsPanel requests={await load((api) => api.adminSupportRequests())} />;
  } else if (tab === 'plans') {
    body = <PlansPanel plans={await load((api) => api.adminPlans())} canChange={isOwner} />;
  } else if (tab === 'staff') {
    body = <StaffPanel staff={await load((api) => api.adminStaff())} />;
  } else if (tab === 'imports') {
    const rows = await load((api) => api.adminImportFailures(30));
    body = (
      <section className="card-flush overflow-x-auto" aria-label={t('admin.tab.imports')}>
        <table className="tbl">
          <thead>
            <tr>
              <th className="px-3 py-2">{t('admin.institution')}</th>
              <th className="px-3 py-2">{t('admin.file_type')}</th>
              <th className="px-3 py-2 text-right">{t('admin.batches')}</th>
              <th className="px-3 py-2 text-right">{t('admin.failed')}</th>
              <th className="px-3 py-2 text-right">{t('admin.needed_mapping')}</th>
              <th className="px-3 py-2 text-right">{t('admin.rows_failed')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={`${r.institution}-${r.fileType}`} data-testid="admin-import-row">
                <td className="px-3 py-2 text-sm">{r.institution}</td>
                <td className="px-3 py-2 text-sm">{r.fileType}</td>
                <td className="px-3 py-2 text-right text-sm">{r.batches}</td>
                <td className="px-3 py-2 text-right text-sm">{r.failed}</td>
                <td className="px-3 py-2 text-right text-sm">{r.neededMapping}</td>
                <td className="px-3 py-2 text-right text-sm">{r.rowsFailed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    );
  } else if (tab === 'ai') {
    const [rows, ceiling] = await load((api) => Promise.all([api.adminAiAccuracy(30), api.adminAiCeiling()]));
    body = (
      <div className="space-y-4">
        <AiCeilingPanel ceiling={ceiling} canChange={isOwner} />
        <section className="card-flush overflow-x-auto" aria-label={t('admin.tab.ai')}>
          <table className="tbl">
            <thead>
              <tr>
                <th className="px-3 py-2">{t('admin.task')}</th>
                <th className="px-3 py-2">{t('admin.model')}</th>
                <th className="px-3 py-2 text-right">{t('admin.calls')}</th>
                <th className="px-3 py-2 text-right">{t('admin.failed')}</th>
                <th className="px-3 py-2 text-right">{t('admin.accepted')}</th>
                <th className="px-3 py-2 text-right">{t('admin.edited')}</th>
                <th className="px-3 py-2 text-right">{t('admin.rejected')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={`${r.task}-${r.provider}-${r.model}`}>
                  <td className="px-3 py-2 text-sm">{r.task}</td>
                  <td className="px-3 py-2 text-sm">
                    {r.provider} · {r.model}
                  </td>
                  <td className="px-3 py-2 text-right text-sm">{r.calls}</td>
                  <td className="px-3 py-2 text-right text-sm">{r.failures}</td>
                  <td className="px-3 py-2 text-right text-sm">{r.accepted}</td>
                  <td className="px-3 py-2 text-right text-sm">{r.edited}</td>
                  <td className="px-3 py-2 text-right text-sm">{r.rejected}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    );
  } else if (tab === 'flags') {
    body = <FlagsPanel flags={await load((api) => api.adminFlags())} canChange={canChange} />;
  } else if (tab === 'notices') {
    const [notices, versions] = await load((api) =>
      Promise.all([api.adminNotices(), api.adminAppVersions()]),
    );
    body = <NoticesPanel notices={notices} versions={versions} canChange={canChange} />;
  } else if (tab === 'security') {
    body = (
      <PasswordPolicyPanel policy={await load((api) => api.adminPasswordPolicy())} canChange={canChange} />
    );
  } else {
    const [merchants, rates] = await load((api) =>
      Promise.all([api.adminMerchants(''), api.adminMileageRates()]),
    );
    body = <ReferencePanel merchants={merchants} rates={rates} canChange={canChange} />;
  }
  return (
    <>
      <header className="space-y-1">
        <h1 className="page-title">{t('admin.title')}</h1>
        <p className="text-sm text-muted">{t('admin.hint')}</p>
      </header>
      <nav className="tabs" aria-label={t('admin.sections')}>
        {tabs.map((k) => (
          <Link
            key={k}
            className="tab"
            aria-current={tab === k ? 'page' : undefined}
            href={`/admin?tab=${k}`}
          >
            {t(`admin.tab.${k}`)}
          </Link>
        ))}
      </nav>
      {body}
    </>
  );
}

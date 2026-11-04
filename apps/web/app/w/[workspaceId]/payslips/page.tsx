import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { STATUS_CHIP } from '@/lib/payslips';
import { DateText } from '@/components/i18n';
import { Money } from '@/components/money';
import { EmployerManager } from '@/components/payslips/employer-manager';
import { PayslipCapture } from '@/components/payslips/payslip-capture';
import { EmptyState, LinkTabs, PageHeader } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'Payslips' };
export const dynamic = 'force-dynamic';

/** Payslips and employers (PAY-01..03). Only owners and the member's linked login see them (PAY-09). */
export default async function PayslipsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { workspaceId } = await params;
  const { tab: rawTab } = await searchParams;
  const tab = rawTab === 'employers' ? 'employers' : 'payslips';
  const [payslips, employers, members, accounts] = await load((api) =>
    Promise.all([
      api.listPayslips(workspaceId),
      api.listEmployers(workspaceId),
      api.listFamilyMembers(workspaceId),
      api.listAccounts(workspaceId),
    ]),
  );
  const { t } = await getI18n();
  const base = `/w/${workspaceId}/payslips`;
  const active = members.filter((m) => m.status === 'active');
  const open = employers.filter((e) => !e.archived);
  const employerName = new Map(employers.map((e) => [e.id, e.name]));
  const memberName = new Map(members.map((m) => [m.id, m.name]));

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('nav.payslips')}
        subtitle={t('payslips.subtitle')}
        actions={
          <Link href={`/w/${workspaceId}/members`} className="btn-secondary">
            {t('payslips.see_reports')}
          </Link>
        }
      />
      <LinkTabs
        label={t('payslips.sections')}
        current={tab}
        tabs={[
          { key: 'payslips', href: base, label: t('payslips.tab_payslips') },
          { key: 'employers', href: `${base}?tab=employers`, label: t('payslips.tab_employers') },
        ]}
      />
      {tab === 'employers' ? (
        <EmployerManager
          workspaceId={workspaceId}
          employers={employers}
          members={active}
          accounts={accounts}
        />
      ) : open.length === 0 ? (
        <EmptyState title={t('payslips.no_employers')}>
          <Link href={`${base}?tab=employers`} className="btn-primary mt-3 inline-block">
            {t('employers.add')}
          </Link>
        </EmptyState>
      ) : (
        <>
          <PayslipCapture workspaceId={workspaceId} employers={open} members={members} />
          {payslips.length === 0 ? (
            <EmptyState title={t('payslips.empty')} />
          ) : (
            <section className="card-flush" aria-label={t('payslips.list')}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th className="px-4 py-2">{t('payslips.pay_date')}</th>
                    <th className="px-2 py-2">{t('payslips.employer')}</th>
                    <th className="px-2 py-2">{t('employers.member')}</th>
                    <th className="px-2 py-2 text-right">{t('payslips.gross')}</th>
                    <th className="px-2 py-2 text-right">{t('payslips.net')}</th>
                    <th className="px-4 py-2">{t('payslips.status_col')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {payslips.map((p) => (
                    <tr key={p.id} data-testid="payslip-row">
                      <td className="px-4 py-2">
                        <Link href={`${base}/${p.id}`} className="font-medium underline">
                          {p.payDate ? <DateText date={p.payDate} /> : t('payslips.no_date')}
                        </Link>
                      </td>
                      <td className="px-2 py-2">{employerName.get(p.employerId) ?? ''}</td>
                      <td className="px-2 py-2">{memberName.get(p.memberId) ?? ''}</td>
                      <td className="px-2 py-2 text-right">
                        <Money amount={p.gross} currency={p.currency} />
                      </td>
                      <td className="px-2 py-2 text-right">
                        <Money amount={p.net} currency={p.currency} />
                      </td>
                      <td className="px-4 py-2">
                        <span className={STATUS_CHIP[p.status]}>{t(`payslips.status.${p.status}`)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </div>
  );
}

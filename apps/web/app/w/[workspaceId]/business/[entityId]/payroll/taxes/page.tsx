import type { Metadata } from 'next';
import Link from 'next/link';
import { ApiError, type WorksheetForm } from '@montra/api-client';
import { todayIn } from '@montra/domain';
import { load, serverApi } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { PayrollTaxes } from '@/components/payroll/payroll-taxes';

export const metadata: Metadata = { title: 'Payroll taxes' };
export const dynamic = 'force-dynamic';

const PAY_FROM = new Set(['checking', 'savings', 'cash']);
const FORMS: readonly WorksheetForm[] = ['941', '940', 'de9', 'de9c'];

/** Employer tax for one business (PRL-12..16): settings, what to deposit and when, and the quarterly worksheets. */
export default async function PayrollTaxesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; entityId: string }>;
  searchParams: Promise<{ year?: string; form?: string; quarter?: string }>;
}) {
  const { workspaceId, entityId } = await params;
  const sp = await searchParams;
  const workspace = await load((api) => api.getWorkspace(workspaceId));
  const today = todayIn(workspace.timeZone);
  const year = /^\d{4}$/.test(sp.year ?? '') ? Number(sp.year) : Number(today.slice(0, 4));
  const form = FORMS.includes(sp.form as WorksheetForm) ? (sp.form as WorksheetForm) : '941';
  const quarter = /^[1-4]$/.test(sp.quarter ?? '')
    ? Number(sp.quarter)
    : year === Number(today.slice(0, 4))
      ? Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1
      : 4;
  const [business, taxes, worksheet, accounts] = await load((api) =>
    Promise.all([
      api.getBusiness(workspaceId, entityId),
      api.getPayrollTaxes(workspaceId, entityId, year),
      api.getPayrollWorksheet(workspaceId, entityId, form, year, form === '940' ? undefined : quarter),
      api.listAccounts(workspaceId),
    ]),
  );
  const { t } = await getI18n();
  let canWrite = true;
  try {
    await (await serverApi()).listPayrollPeople(workspaceId, { entityId, kind: 'employee' });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'payroll.no_access') canWrite = false;
    else throw err;
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/w/${workspaceId}/business/${entityId}/payroll`} className="text-sm underline">
          ← {t('business.tab_payroll')}
        </Link>
        <h2 className="text-lg font-semibold">{t('payroll.taxes.title')}</h2>
      </div>
      <PayrollTaxes
        workspaceId={workspaceId}
        entityId={entityId}
        currency={business.currency}
        taxes={taxes}
        worksheet={worksheet}
        form={form}
        quarter={quarter}
        accounts={accounts
          .filter((a) => a.entityId === entityId && !a.archived && PAY_FROM.has(a.kind))
          .map((a) => ({ id: a.id, name: a.name }))}
        today={today}
        canWrite={canWrite}
      />
    </div>
  );
}

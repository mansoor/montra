import type { Metadata } from 'next';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { PayslipReview } from '@/components/payslips/payslip-review';
import { PageHeader } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'Payslip' };
export const dynamic = 'force-dynamic';

/** Check one payslip against the file it came from, then post it (PAY-03, PAY-05). */
export default async function PayslipPage({
  params,
}: {
  params: Promise<{ workspaceId: string; payslipId: string }>;
}) {
  const { workspaceId, payslipId } = await params;
  const [payslip, employers, members] = await load((api) =>
    Promise.all([
      api.getPayslip(workspaceId, payslipId),
      api.listEmployers(workspaceId),
      api.listFamilyMembers(workspaceId),
    ]),
  );
  const { t } = await getI18n();
  const employer = employers.find((e) => e.id === payslip.employerId);
  const member = members.find((m) => m.id === payslip.memberId);
  return (
    <div className="space-y-4">
      <PageHeader
        title={employer?.name ?? t('nav.payslips')}
        subtitle={member?.name}
        back={{ href: `/w/${workspaceId}/payslips`, label: t('nav.payslips') }}
      />
      <PayslipReview workspaceId={workspaceId} payslip={payslip} />
    </div>
  );
}

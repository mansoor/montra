import type { Metadata } from 'next';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { TaxRateForm } from '@/components/business/tax-tools';
import { Money } from '@/components/money';
import { AllocationRules, RentalTaxAccounts } from '@/components/rentals/rental-ops';

export const metadata: Metadata = { title: 'Rental settings' };
export const dynamic = 'force-dynamic';

/** The tax set-aside and shared-expense rules (REC-09, RNT-07). */
export default async function RentalSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string; entityId: string }>;
}) {
  const { workspaceId, entityId } = await params;
  const [profile, estimate, accounts, properties, rules] = await load((api) =>
    Promise.all([
      api.getBusiness(workspaceId, entityId),
      api.getTaxEstimate(workspaceId, { entityId }),
      api.listAccounts(workspaceId),
      api.listProperties(workspaceId, entityId),
      api.listAllocationRules(workspaceId, entityId),
    ]),
  );
  const { t } = await getI18n();
  return (
    <div className="space-y-5">
      <section className="card space-y-3" aria-labelledby="tax-title">
        <h2 id="tax-title" className="text-base font-semibold">
          {t('rentals.tax_set_aside')}
        </h2>
        <p className="text-sm text-muted">{t('rentals.tax_set_aside_hint')}</p>
        <TaxRateForm workspaceId={workspaceId} profile={profile} />
        <RentalTaxAccounts
          workspaceId={workspaceId}
          profile={profile}
          accounts={accounts.filter((a) => a.entityId === entityId)}
        />
        {estimate.rateBps !== null && (
          <p className="text-sm" data-testid="rental-tax-estimate">
            {t('taxes.to_set_aside')}: <Money amount={estimate.toSetAside} currency={estimate.currency} />
          </p>
        )}
      </section>
      <AllocationRules workspaceId={workspaceId} entityId={entityId} properties={properties} rules={rules} />
    </div>
  );
}

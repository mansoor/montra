import Link from 'next/link';
import { accountProfile, bpsToPercent } from '@montra/domain';
import type { AccountBalanceHistoryDto, AccountDto } from '@montra/api-client';
import { LineChart } from '@/components/charts/line-chart';
import { Money } from '@/components/money';
import type { getI18n } from '@/lib/i18n-server';

type T = Awaited<ReturnType<typeof getI18n>>['t'];

/** The facts this account's type holds, such as a card's limit and what's still available. */
const PLANNING = new Set(['creditLimit', 'interestRate', 'minPayment', 'lowBalance']);

export function AccountFacts({
  account,
  workspaceId,
  t,
  interestEarned,
}: {
  account: AccountDto;
  workspaceId: string;
  t: T;
  /** Interest paid in this year, for savings (ADR-0027). */
  interestEarned?: string | null;
}) {
  const details = accountProfile(account.kind).details.filter((d) => PLANNING.has(d));
  if (details.length === 0) return null;
  const { creditLimit, interestRateBps, minPayment, lowBalance } = account.planning;
  const money = (amount: string) => <Money amount={amount} currency={account.currency} />;
  const facts: { label: string; value: React.ReactNode; testId: string }[] = [];
  if (details.includes('creditLimit') && creditLimit !== null) {
    facts.push({ label: t('accounts.credit_limit'), value: money(creditLimit), testId: 'fact-limit' });
    facts.push({
      label: t('account.available'),
      value: money(String(BigInt(creditLimit) - BigInt(account.balance.amount))),
      testId: 'fact-available',
    });
  }
  if (details.includes('interestRate') && interestRateBps !== null) {
    facts.push({
      label: t(account.kind === 'credit_card' ? 'account.apr' : 'account.interest_rate'),
      value: `${bpsToPercent(interestRateBps)}%`,
      testId: 'fact-rate',
    });
  }
  if (details.includes('minPayment') && minPayment !== null) {
    facts.push({ label: t('accounts.min_payment'), value: money(minPayment), testId: 'fact-min-payment' });
  }
  if (interestEarned != null && BigInt(interestEarned) > 0n) {
    facts.push({
      label: t('account.interest_earned'),
      value: money(interestEarned),
      testId: 'fact-interest-earned',
    });
  }
  if (details.includes('lowBalance') && BigInt(lowBalance) !== 0n) {
    facts.push({ label: t('accounts.low_balance'), value: money(lowBalance), testId: 'fact-low-balance' });
  }
  return (
    <section className="card" data-testid="account-facts" aria-label={t('account.details_title')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        {facts.length > 0 ? (
          <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
            {facts.map((f) => (
              <div key={f.testId} data-testid={f.testId}>
                <dt className="text-muted">{f.label}</dt>
                <dd className="font-medium">{f.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-muted">{t(`account.details_empty.${details[0]!}`)}</p>
        )}
        <Link href={`/w/${workspaceId}/settings?tab=accounts`} className="text-sm underline">
          {t(facts.length > 0 ? 'account.details_edit' : 'account.details_add')}
        </Link>
      </div>
    </section>
  );
}

const RANGES = ['3m', '6m', '1y', 'all'] as const;

/** The account's balance over time. Hidden until there's more than one day to draw. */
export function BalanceHistory({
  account,
  history,
  href,
  t,
}: {
  account: AccountDto;
  history: AccountBalanceHistoryDto;
  /** The page's address with this range selected. */
  href: (range: (typeof RANGES)[number]) => string;
  t: T;
}) {
  const word = accountProfile(account.kind).balanceWord;
  return (
    <section className="card space-y-3" data-testid="balance-history">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{t(`account.history.${word}`)}</h2>
        <nav aria-label={t('account.history.range')} className="segmented segmented-md">
          {RANGES.map((r) => (
            <Link
              key={r}
              href={href(r)}
              aria-current={history.range === r ? 'true' : undefined}
              scroll={false}
            >
              {t(`account.history.range_${r}`)}
            </Link>
          ))}
        </nav>
      </div>
      {history.points.length > 1 ? (
        <LineChart
          title={t(`account.history.title_${word}`, { name: account.name })}
          series={[{ label: account.name, values: history.points.map((p) => p.balance) }]}
          labels={history.points.map((p) => p.date)}
          currency={history.currency}
        />
      ) : (
        <p className="text-sm text-muted">{t('account.history.too_little')}</p>
      )}
    </section>
  );
}

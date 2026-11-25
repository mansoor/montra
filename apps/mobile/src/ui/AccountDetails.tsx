/**
 * What each account type shows on its phone screen (ADR-0024…0027): a loan's next payment, a card's statement, an
 * investment's gain, savings interest, a home's equity, when a debt is due. Figures come from the server; recording a loan
 * payment needs a connection, like the phone's other writes outside sync. Settings for each type are on the web.
 */
import { useState } from 'react';
import { View } from 'react-native';
import {
  bpsToPercent,
  calendarDate,
  ppmToPercent,
  ratePpmOf,
  sharePercent,
  type CalendarDate,
} from '@montra/domain';
import type {
  AccountDto,
  AmortizationRowDto,
  CardStatementDto,
  InterestEarnedDto,
  InvestmentPerformanceDto,
  LoanDto,
} from '@montra/schemas';
import type { Api } from '../api/client';
import { useAbilities } from '../session/SessionProvider';
import {
  assetFigures,
  isOverdue,
  LOAN_CHART_BY_YEAR_ABOVE,
  loanChartBars,
  loanPayingAccounts,
  loanPaymentDate,
  loanSuggestedLateFee,
  type AccountSections,
  type LoanChartBar,
} from '../features/accounts';
import { StackedBarChart } from './charts';
import { assignedInput, parseAssigned } from '../features/planning';
import { fmtDate, fmtMoney, t } from '../i18n';
import { Banner, Body, Button, Card, Field, Row, Segmented, Small, Title, useToast } from './components';
import { useTheme } from './theme';

/** What the server says about an account, read live and kept for offline viewing. */
export interface AccountDetailsData {
  loan: LoanDto | null;
  schedule: AmortizationRowDto[];
  statement: CardStatementDto | null;
  performance: InvestmentPerformanceDto | null;
  interest: InterestEarnedDto | null;
}

/** How many upcoming loan payments are listed. The full schedule is on the web. */
const UPCOMING_SHOWN = 3;

export async function loadAccountDetails(
  api: Api,
  ws: string,
  account: Pick<AccountDto, 'id' | 'entityId' | 'loanId'>,
  sections: AccountSections,
): Promise<AccountDetailsData> {
  const loanId = sections.loan ? account.loanId : null;
  const [loans, schedule, statement, performance, interest] = await Promise.all([
    loanId ? api.loans(ws, account.entityId) : Promise.resolve([]),
    loanId ? api.loanSchedule(ws, loanId) : Promise.resolve([]),
    sections.statement ? api.cardStatement(ws, account.id) : Promise.resolve(null),
    sections.performance ? api.accountPerformance(ws, account.id) : Promise.resolve(null),
    sections.interest ? api.interestEarned(ws, account.id) : Promise.resolve(null),
  ]);
  return {
    loan: loans.find((l) => l.id === loanId) ?? null,
    schedule,
    statement,
    performance,
    interest,
  };
}

/** One label and figure, the phone's version of the web's definition lists. */
function Fact({
  label,
  value,
  color,
  testID,
}: {
  label: string;
  value: string;
  color?: string;
  testID?: string;
}) {
  return (
    <View testID={testID} accessible accessibilityLabel={`${label}: ${value}`} style={{ gap: 2 }}>
      <Small>{label}</Small>
      <Body style={{ fontWeight: '600', ...(color ? { color } : {}) }}>{value}</Body>
    </View>
  );
}

const signed = (amount: bigint, currency: string) => `${amount > 0n ? '+' : ''}${fmtMoney(amount, currency)}`;

export function AccountDetails({
  api,
  ws,
  account,
  accounts,
  sections,
  data,
  online,
  today,
  onChanged,
}: {
  api: Api;
  ws: string;
  account: AccountDto;
  accounts: readonly AccountDto[];
  sections: AccountSections;
  data: AccountDetailsData | null;
  /** False when showing the saved copy: writes need a connection. */
  online: boolean;
  today: CalendarDate;
  onChanged: () => void;
}) {
  return (
    <>
      {sections.asset ? <AssetCard account={account} accounts={accounts} /> : null}
      {sections.dueDate ? <DueCard account={account} today={today} /> : null}
      {sections.statement && data ? <StatementCard statement={data.statement} today={today} /> : null}
      {sections.loan && data?.loan ? (
        <LoanCard
          api={api}
          ws={ws}
          loan={data.loan}
          schedule={data.schedule}
          accounts={accounts}
          online={online}
          today={today}
          onChanged={onChanged}
        />
      ) : null}
      {sections.untrackedLoan ? (
        <Card testID="account-loan-untracked">
          <Small>{t('mobile.account.track_on_web')}</Small>
        </Card>
      ) : null}
      {sections.performance && data?.performance ? <PerformanceCard perf={data.performance} /> : null}
      {sections.interest && data?.interest ? (
        <Card testID="account-interest">
          <Fact
            label={t('account.interest_earned')}
            value={fmtMoney(data.interest.amount, data.interest.currency)}
          />
        </Card>
      ) : null}
    </>
  );
}

function AssetCard({ account, accounts }: { account: AccountDto; accounts: readonly AccountDto[] }) {
  const th = useTheme();
  const f = assetFigures(account, accounts);
  const ccy = account.currency;
  return (
    <Card testID="account-asset">
      <Title>{t('asset.title')}</Title>
      <Fact label={t('asset.value')} value={fmtMoney(f.value, ccy)} />
      {f.loan && f.equity !== null ? (
        <>
          <Fact label={t('asset.owed', { name: f.loan.name })} value={fmtMoney(f.loan.owed, ccy)} />
          <Fact
            label={t('asset.equity')}
            value={fmtMoney(f.equity, ccy)}
            color={f.equity < 0n ? th.danger : undefined}
            testID="account-asset-equity"
          />
        </>
      ) : null}
      {f.purchasePrice !== null && f.change !== null ? (
        <>
          <Fact
            label={
              account.purchaseDate ? `${t('asset.paid')} (${fmtDate(account.purchaseDate)})` : t('asset.paid')
            }
            value={fmtMoney(f.purchasePrice, ccy)}
          />
          <Fact label={t('asset.change')} value={signed(f.change, ccy)} />
        </>
      ) : null}
      {!f.loan && f.purchasePrice === null ? <Small>{t('mobile.account.asset_unset')}</Small> : null}
    </Card>
  );
}

function DueCard({ account, today }: { account: AccountDto; today: CalendarDate }) {
  const th = useTheme();
  return (
    <Card testID="account-due">
      <Title>{t('debt.title')}</Title>
      {account.dueDate ? (
        <Body>
          {`${t('debt.due')} ${fmtDate(account.dueDate)}`}
          {isOverdue(account.dueDate, account.balance.amount, today) ? (
            <Body style={{ color: th.danger, fontWeight: '600' }}>{` · ${t('account.loan.overdue')}`}</Body>
          ) : null}
        </Body>
      ) : (
        <Small>{t('mobile.account.no_due')}</Small>
      )}
    </Card>
  );
}

function StatementCard({ statement: s, today }: { statement: CardStatementDto | null; today: CalendarDate }) {
  const th = useTheme();
  if (!s) {
    return (
      <Card testID="account-statement">
        <Title>{t('card.title')}</Title>
        <Small>{t('mobile.account.card_unset')}</Small>
      </Card>
    );
  }
  const ccy = s.currency;
  const due = BigInt(s.due) > 0n;
  return (
    <Card testID="account-statement">
      <Small>
        {t('card.due_title')}
        {isOverdue(s.dueDate, s.due, today) ? ` · ${t('account.loan.overdue')}` : ''}
      </Small>
      <Title>{fmtMoney(s.due, ccy)}</Title>
      {due ? (
        <Small color={isOverdue(s.dueDate, s.due, today) ? th.danger : undefined}>
          {`${t('card.due_on')} ${fmtDate(s.dueDate)} · ${t('card.minimum')} ${fmtMoney(s.minimumDue, ccy)}`}
        </Small>
      ) : (
        <Small>{t('card.paid_in_full')}</Small>
      )}
      <Fact
        label={`${t('card.statement_balance')} (${fmtDate(s.lastClose)})`}
        value={fmtMoney(s.statementBalance, ccy)}
      />
      <Fact label={t('card.paid_since')} value={fmtMoney(s.paidSince, ccy)} />
      <Fact label={t('card.since_statement')} value={fmtMoney(s.sinceStatement, ccy)} />
      <Fact label={t('card.next_close')} value={fmtDate(s.nextClose)} />
      {s.utilizationBps !== null ? (
        <Fact
          label={t('card.utilization')}
          value={`${bpsToPercent(s.utilizationBps)}%`}
          color={s.utilizationBps > 3000 ? th.danger : undefined}
          testID="account-utilization"
        />
      ) : null}
    </Card>
  );
}

function PerformanceCard({ perf }: { perf: InvestmentPerformanceDto }) {
  const th = useTheme();
  const s = perf.summary;
  const ccy = perf.currency;
  return (
    <Card testID="account-performance">
      <Title>{t('account.invest.title')}</Title>
      {perf.hidden ? (
        // PAY-09: someone else's private payslip money is in here, so the server sends no figures.
        <Small>{t('account.invest.hidden')}</Small>
      ) : !s ? (
        <Small>{t('account.invest.empty')}</Small>
      ) : (
        <>
          <Fact
            label={t('account.invest.gain')}
            value={signed(BigInt(s.gain), ccy)}
            color={BigInt(s.gain) < 0n ? th.danger : undefined}
            testID="account-gain"
          />
          <Fact
            label={t('account.invest.return')}
            value={s.returnBps === null ? '—' : `${bpsToPercent(s.returnBps)}%`}
          />
          {s.annualizedBps !== null ? (
            <Fact label={t('account.invest.annualized')} value={`${bpsToPercent(s.annualizedBps)}%`} />
          ) : null}
          <Fact label={t('account.invest.money_in')} value={fmtMoney(s.moneyIn, ccy)} />
          {BigInt(s.moneyOut) > 0n ? (
            <Fact label={t('account.invest.money_out')} value={fmtMoney(s.moneyOut, ccy)} />
          ) : null}
          <Fact label={t('account.invest.value_now')} value={fmtMoney(s.end, ccy)} />
          <Small>{t('account.invest.note')}</Small>
        </>
      )}
    </Card>
  );
}

function LoanCard({
  api,
  ws,
  loan,
  schedule,
  accounts,
  online,
  today,
  onChanged,
}: {
  api: Api;
  ws: string;
  loan: LoanDto;
  schedule: readonly AmortizationRowDto[];
  accounts: readonly AccountDto[];
  online: boolean;
  today: CalendarDate;
  onChanged: () => void;
}) {
  const th = useTheme();
  const toast = useToast();
  const ccy = loan.currency;
  const can = useAbilities();
  // Recording a payment posts to the books: for those who keep them (AUTH-18).
  const canPay = can.setUp && can.writes(loan.entityId);
  const next = loan.next;
  const paying = loanPayingAccounts(loan, accounts);
  const paidFrom = accounts.find((a) => a.id === loan.payingAccountId);
  const [from, setFrom] = useState('');
  const [dateInput, setDateInput] = useState<string | null>(null);
  const [extra, setExtra] = useState('');
  // The lender's own split (blank: Montra's), and a late fee suggested once past the grace period (ADR-0024 §13, §14).
  const [lenderPrincipal, setLenderPrincipal] = useState('');
  const [lenderInterest, setLenderInterest] = useState('');
  const [feeInput, setFeeInput] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accountId = from || paying[0]?.id || '';
  const date = dateInput ?? (next ? loanPaymentDate(next, today) : today);
  const suggestedFee = next ? loanSuggestedLateFee(loan, next, date.trim()) : 0n;
  const fee = feeInput ?? (suggestedFee > 0n ? assignedInput(String(suggestedFee), ccy) : '');
  const upcoming = schedule.filter((r) => !r.transactionId).slice(0, UPCOMING_SHOWN);
  const overdue = next !== null && next.date < today;

  const record = async () => {
    if (!next) return;
    let day: CalendarDate;
    try {
      day = calendarDate(date.trim());
    } catch {
      return setError(t('mobile.account.date_invalid'));
    }
    const extraMinor = parseAssigned(extra, ccy);
    const feeMinor = parseAssigned(fee, ccy);
    const split = lenderPrincipal.trim() !== '' || lenderInterest.trim() !== '';
    const principalMinor = parseAssigned(lenderPrincipal, ccy);
    const interestMinor = parseAssigned(lenderInterest, ccy);
    if (
      extraMinor === null ||
      feeMinor === null ||
      (split && (principalMinor === null || interestMinor === null))
    ) {
      return setError(t('budget.amount_invalid'));
    }
    setBusy(true);
    setError(null);
    try {
      await api.recordLoanPayment(ws, loan.id, {
        number: next.number,
        accountId,
        date: day,
        // The lender's principal already holds any extra.
        ...(split
          ? { principal: principalMinor!, interest: interestMinor! }
          : BigInt(extraMinor) > 0n
            ? { extraPrincipal: extraMinor }
            : {}),
        ...(BigInt(feeMinor) > 0n ? { lateFee: feeMinor } : {}),
      });
      setExtra('');
      setLenderPrincipal('');
      setLenderInterest('');
      setFeeInput(null);
      setDateInput(null);
      toast.show(t('account.loan.recorded'));
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card testID="account-loan">
        {next ? (
          <>
            <Small>
              {t('account.loan.next_title')}
              {overdue ? ` · ${t('account.loan.overdue')}` : ''}
            </Small>
            <Title>{fmtMoney(next.total, ccy)}</Title>
            <Small color={overdue ? th.danger : undefined}>
              {fmtDate(next.date)}
              {paidFrom ? ` · ${t('account.loan.from_account', { name: paidFrom.name })}` : ''}
            </Small>
            <Small>
              {`${t('account.loan.principal')} ${fmtMoney(next.principal, ccy)} · ${t('account.loan.interest')} ${fmtMoney(next.interest, ccy)}`}
              {BigInt(next.escrow) > 0n ? ` · ${t('account.loan.escrow')} ${fmtMoney(next.escrow, ccy)}` : ''}
            </Small>
            {next.late ? (
              <Small color={th.danger}>
                {BigInt(next.lateFee) > 0n
                  ? t('account.loan.late_fee_note', { amount: fmtMoney(next.lateFee, ccy) })
                  : t('account.loan.late_note')}
              </Small>
            ) : null}
          </>
        ) : (
          <Body style={{ fontWeight: '600' }}>{t('account.loan.paid_off')}</Body>
        )}
        <Fact
          label={t('account.interest_rate')}
          // A loan kept offline from before migration 0096 has only whole basis points.
          value={`${ppmToPercent(ratePpmOf(loan.ratePpm, loan.rateBps) ?? 0)}%`}
        />
        <Fact label={t('account.loan.monthly')} value={fmtMoney(loan.totalPayment, ccy)} />
        <Fact
          label={t('account.loan.interest_method')}
          value={
            loan.interestMethod === 'daily'
              ? t('account.loan.method_daily_short')
              : t('account.loan.method_monthly_short')
          }
          testID="account-loan-method"
        />
        {loan.graceDays > 0 ? (
          <Fact
            label={t('account.loan.grace_days')}
            value={String(loan.graceDays)}
            testID="account-loan-grace"
          />
        ) : null}
        {loan.lateFee !== null || loan.lateFeeBps !== null ? (
          <Fact
            label={t('account.loan.late_fee')}
            value={
              loan.lateFee !== null && loan.lateFeeBps !== null
                ? t('account.loan.late_fee_greater', {
                    amount: fmtMoney(loan.lateFee, ccy),
                    percent: bpsToPercent(loan.lateFeeBps),
                  })
                : loan.lateFee !== null
                  ? fmtMoney(loan.lateFee, ccy)
                  : t('account.loan.late_fee_percent_of', { percent: bpsToPercent(loan.lateFeeBps!) })
            }
            testID="account-loan-late-fee"
          />
        ) : null}
        {loan.payoffDate ? (
          <Fact label={t('account.loan.payoff')} value={fmtDate(loan.payoffDate)} testID="account-payoff" />
        ) : null}
        <Fact label={t('account.loan.interest_left')} value={fmtMoney(loan.interestRemaining, ccy)} />
        {BigInt(loan.interestPaid) > 0n ? (
          <Fact label={t('account.loan.interest_paid')} value={fmtMoney(loan.interestPaid, ccy)} />
        ) : null}
      </Card>

      {next && canPay ? (
        <Card testID="account-loan-record">
          <Title>{t('account.loan.record')}</Title>
          {error ? <Banner tone="danger" text={error} /> : null}
          {paying.length === 0 ? (
            <Small>{t('account.loan.no_paying_account')}</Small>
          ) : (
            <>
              <Segmented
                label={t('account.loan.paid_from')}
                value={accountId}
                options={paying.slice(0, 4).map((a) => ({ value: a.id, label: a.name }))}
                onChange={setFrom}
              />
              <Field
                label={t('fields.date')}
                value={date}
                onChangeText={setDateInput}
                placeholder="YYYY-MM-DD"
              />
              <Field
                label={t('account.loan.extra')}
                value={extra}
                onChangeText={setExtra}
                keyboardType="decimal-pad"
              />
              <Field
                label={t('account.loan.late_fee')}
                value={fee}
                onChangeText={setFeeInput}
                keyboardType="decimal-pad"
              />
              <Small>{t('account.loan.lender_split_hint')}</Small>
              <Field
                label={`${t('account.loan.lender_split')}: ${t('account.loan.principal')}`}
                value={lenderPrincipal}
                onChangeText={setLenderPrincipal}
                placeholder={assignedInput(next.principal, ccy)}
                keyboardType="decimal-pad"
              />
              <Field
                label={`${t('account.loan.lender_split')}: ${t('account.loan.interest')}`}
                value={lenderInterest}
                onChangeText={setLenderInterest}
                placeholder={assignedInput(next.interest, ccy)}
                keyboardType="decimal-pad"
              />
              <Button
                label={`${t('account.loan.record')} · ${fmtMoney(next.total, ccy)}`}
                onPress={() => void record()}
                disabled={!online || !accountId}
                busy={busy}
                testID="account-loan-save"
              />
            </>
          )}
        </Card>
      ) : null}

      <LoanPaidSoFar loan={loan} />

      {schedule.length > 0 ? (
        <Card testID="account-loan-schedule">
          <Title>{t('account.loan.schedule')}</Title>
          <LoanScheduleChart loan={loan} schedule={schedule} />
          {upcoming.map((r) => (
            <Row
              key={r.number}
              title={fmtDate(r.date)}
              subtitle={`${t('account.loan.owed_after')} ${fmtMoney(r.balance, ccy)}`}
              right={<Body>{fmtMoney(String(BigInt(r.payment) + BigInt(r.escrow)), ccy)}</Body>}
            />
          ))}
        </Card>
      ) : null}
    </>
  );
}

/** "Principal paid $X of $Y" and "Interest paid $X of about $Z total", each with a slim bar, as on the web. */
function LoanPaidSoFar({ loan }: { loan: LoanDto }) {
  const th = useTheme();
  const ccy = loan.currency;
  const interestPaid = BigInt(loan.interestPaid);
  const interestTotal = interestPaid + BigInt(loan.interestRemaining);
  const rows = [
    {
      key: 'principal',
      text: t('account.loan.principal_paid_of', {
        paid: fmtMoney(loan.principalPaid, ccy),
        total: fmtMoney(loan.principal, ccy),
      }),
      percent: sharePercent(BigInt(loan.principalPaid), BigInt(loan.principal)),
      color: th.chart3,
    },
    {
      key: 'interest',
      text: t('account.loan.interest_paid_of', {
        paid: fmtMoney(interestPaid, ccy),
        total: fmtMoney(interestTotal, ccy),
      }),
      percent: sharePercent(interestPaid, interestTotal),
      color: th.chart2,
    },
  ];
  return (
    <Card testID="account-loan-paid">
      <Title>{t('account.loan.paid_so_far')}</Title>
      {rows.map((r) => (
        <View
          key={r.key}
          testID={`account-loan-paid-${r.key}`}
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={r.text}
          accessibilityValue={{ min: 0, max: 100, now: Math.min(100, r.percent) }}
          style={{ gap: 4 }}
        >
          <Body>{r.text}</Body>
          <View style={{ height: 6, borderRadius: 3, backgroundColor: th.surfaceAlt, overflow: 'hidden' }}>
            <View
              style={{
                height: 6,
                borderRadius: 3,
                width: `${Math.min(100, Math.max(0, r.percent))}%`,
                backgroundColor: r.color,
              }}
            />
          </View>
        </View>
      ))}
      {loan.paymentsBefore > 0 ? <Small>{t('account.loan.interest_before_tracking')}</Small> : null}
    </Card>
  );
}

/** Principal and interest in each payment (or each year, on a long loan), recorded ones solid and the rest lighter. */
function LoanScheduleChart({ loan, schedule }: { loan: LoanDto; schedule: readonly AmortizationRowDto[] }) {
  const th = useTheme();
  const ccy = loan.currency;
  const [selected, setSelected] = useState<number | null>(null);
  const { byYear, bars } = loanChartBars(schedule);
  const paid = schedule.filter((r) => r.transactionId !== null).length;
  // Today falls after the last recorded bar.
  const today = bars.reduce((at, b, i) => (b.recorded ? i + 1 : at), 0);
  let lastYear = '';
  const chartBars = bars.map((b) => {
    const year = b.date.slice(0, 4);
    const label = byYear || year !== lastYear ? year : '';
    lastYear = year;
    return { key: b.key, values: [b.principal, b.interest], faded: !b.recorded, label };
  });
  const pick = selected === null ? null : (bars[selected] ?? null);
  const when = (b: LoanChartBar) =>
    b.year !== null ? t('account.loan.chart_year', { year: b.year, count: b.count }) : fmtDate(b.date);
  return (
    <View testID="account-loan-chart" style={{ gap: th.space(2) }}>
      <StackedBarChart
        bars={chartBars}
        colors={[th.chart3, th.chart2]}
        currency={ccy}
        title={t('account.loan.view_chart')}
        summary={t('account.loan.chart_title', { name: loan.name, paid, left: schedule.length - paid })}
        marker={{ index: today, label: t('account.loan.today') }}
        selected={selected}
        onSelect={setSelected}
      />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space(3) }}>
        {[
          { label: t('account.loan.principal'), color: th.chart3 },
          { label: t('account.loan.interest'), color: th.chart2 },
        ].map((s) => (
          <View key={s.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: s.color }} />
            <Small>{s.label}</Small>
          </View>
        ))}
      </View>
      {pick ? (
        <View testID="account-loan-chart-pick" accessibilityLiveRegion="polite">
          <Body style={{ fontWeight: '600' }}>
            {`${when(pick)} · ${t(pick.recorded ? 'account.loan.paid' : 'account.loan.to_come')}`}
          </Body>
          <Small>
            {`${t('account.loan.principal')} ${fmtMoney(pick.principal, ccy)} · ${t('account.loan.interest')} ${fmtMoney(pick.interest, ccy)} · ${t('account.loan.owed_after')} ${fmtMoney(pick.owedAfter, ccy)}`}
          </Small>
        </View>
      ) : (
        <Small>{t('mobile.account.chart_tap')}</Small>
      )}
      <Small>
        {[
          byYear ? t('account.loan.chart_by_year', { count: LOAN_CHART_BY_YEAR_ABOVE }) : null,
          bars.some((b) => !b.recorded) ? t('account.loan.chart_faded') : null,
        ]
          .filter(Boolean)
          .join(' ')}
      </Small>
    </View>
  );
}

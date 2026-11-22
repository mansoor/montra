'use client';

import type { TransferFxDto } from '@montra/api-client';
import { transferFxView } from '@montra/domain';
import { useI18n } from './i18n';

/**
 * A transfer between currencies against the market (CUR-08): the rate it got, the market rate for its date, and
 * the FX cost (or gain) in the books' base currency. Without a stored market rate it says so instead of guessing.
 */
export function TransferFxSummary({
  fx,
  date,
  testId = 'transfer-fx',
}: {
  fx: TransferFxDto;
  /** The transfer's date, for the "no market rate" line. */
  date: string;
  testId?: string;
}) {
  const { t, money, date: formatDate } = useI18n();
  const view = transferFxView(fx);
  const outcome = view.outcome;
  return (
    <div className="space-y-1 text-sm" data-testid={testId}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted">{t('fx.transfer.yours')}</dt>
        <dd className="num" data-testid={`${testId}-effective`}>
          {view.effective}
        </dd>
        {view.market && (
          <>
            <dt className="text-muted">{t('fx.transfer.market')}</dt>
            <dd>
              <span className="num">{view.market}</span>
              {view.marketDate && (
                <span className="text-muted">
                  {' '}
                  · {t('fx.transfer.market_date', { date: formatDate(view.marketDate) })}
                </span>
              )}
            </dd>
          </>
        )}
        {outcome && (
          <>
            <dt className="text-muted">
              {outcome.tone === 'gain' ? t('fx.transfer.gain') : t('fx.transfer.cost')}
            </dt>
            <dd className={outcome.tone === 'gain' ? 'num text-good' : 'num'} data-testid={`${testId}-cost`}>
              {outcome.tone === 'even'
                ? t('fx.transfer.even')
                : outcome.percent === null
                  ? money(outcome.amount, outcome.currency)
                  : t('fx.transfer.cost_value', {
                      amount: money(outcome.amount, outcome.currency),
                      percent: outcome.percent,
                    })}
            </dd>
          </>
        )}
      </dl>
      {outcome ? (
        <p className="text-xs text-muted">{t('fx.transfer.hint', { currency: fx.baseCurrency })}</p>
      ) : (
        <p className="text-muted" data-testid={`${testId}-no-rate`}>
          {t('fx.transfer.no_rate', { date: formatDate(date) })}
        </p>
      )}
    </div>
  );
}

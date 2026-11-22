import type { Trx } from '@montra/db';
import {
  asCurrencyCode,
  decimalToString,
  parseDecimal,
  transferEffectiveRate,
  transferFxQuote,
  type CalendarDate,
  type CurrencyCode,
} from '@montra/domain';
import type { TransferFxDto } from '@montra/schemas';
import type { FxRatesService } from '../fx/fx.service.js';

/** A transfer between two accounts, in minor units of each account's currency. */
export interface TransferFxInput {
  readonly date: CalendarDate;
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly amountOut: bigint;
  readonly amountIn: bigint;
}

/**
 * CUR-08: transfers between currencies measured against the stored reference rates for their dates. One account
 * query and one rate query for the whole batch. Same-currency transfers, non-positive amounts and accounts the caller
 * can't read (RLS) get no entry. A missing market rate is reported as nulls, never guessed.
 */
export async function transferFxFor(
  trx: Trx,
  workspaceId: string,
  fx: FxRatesService,
  items: ReadonlyMap<string, TransferFxInput>,
): Promise<Map<string, TransferFxDto>> {
  const out = new Map<string, TransferFxDto>();
  const list = [...items].filter(([, i]) => i.amountOut > 0n && i.amountIn > 0n);
  if (list.length === 0) return out;
  const ids = [...new Set(list.flatMap(([, i]) => [i.fromAccountId, i.toAccountId]))];
  const rows = await trx
    .selectFrom('app.ledger_account as a')
    .innerJoin('app.entity as e', 'e.id', 'a.entity_id')
    .select(['a.id', 'a.currency', 'e.functional_currency'])
    .where('a.workspace_id', '=', workspaceId)
    .where('a.id', 'in', ids)
    .execute();
  const accounts = new Map(rows.map((r) => [r.id, r]));
  const legs = list.flatMap(([key, i]) => {
    const from = accounts.get(i.fromAccountId);
    const to = accounts.get(i.toAccountId);
    if (!from || !to || from.currency === to.currency) return [];
    return [{ key, i, from: from.currency, to: to.currency, base: from.functional_currency }];
  });
  if (legs.length === 0) return out;
  const dates = legs.map((l) => l.i.date).sort();
  const table = await fx.table(
    trx,
    [...new Set(legs.flatMap((l) => [l.from, l.to, l.base]))],
    dates[0]!,
    dates[dates.length - 1]!,
  );
  for (const { key, i, from, to, base } of legs) {
    const sent = { amount: i.amountOut, currency: asCurrencyCode(from) };
    const received = { amount: i.amountIn, currency: asCurrencyCode(to) };
    const market = table.get(from, to, i.date);
    const sentRate = table.get(from, base, i.date);
    const receivedRate = table.get(to, base, i.date);
    const quote =
      market && sentRate && receivedRate
        ? transferFxQuote(sent, received, asCurrencyCode(base), {
            sent: parseDecimal(sentRate.rate),
            received: parseDecimal(receivedRate.rate),
          })
        : null;
    out.set(key, {
      sent: { amount: i.amountOut.toString(), currency: sent.currency },
      received: { amount: i.amountIn.toString(), currency: received.currency },
      effectiveRate: trimRate(decimalToString(transferEffectiveRate(sent, received))),
      marketRate: quote ? market!.rate : null,
      marketRateDate: quote ? market!.rateDate : null,
      baseCurrency: base,
      cost: quote ? { amount: quote.cost.toString(), currency: base as CurrencyCode } : null,
      costBps: quote && quote.costBps !== null ? Number(quote.costBps) : null,
    });
  }
  return out;
}

/** "0.9090000000" → "0.909". */
const trimRate = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);

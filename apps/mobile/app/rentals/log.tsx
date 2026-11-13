/**
 * Logging rent on the phone (08 §3, RNT-04): the check's in hand, so write it down. Needs a connection, like budget writes:
 * what it owes and how it's applied are the server's to work out.
 */
import { useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { calendarDate } from '@montra/domain';
import type { AccountDto } from '@montra/schemas';
import { assignedInput, parseAssigned } from '../../src/features/planning';
import { rentAccounts } from '../../src/features/rentals';
import { fmtMoney, t } from '../../src/i18n';
import { useAbilities, useSession } from '../../src/session/SessionProvider';
import { Banner, Body, Button, Card, Field, Screen, Segmented, Small } from '../../src/ui/components';
import { NotAllowed } from '../../src/ui/NotAllowed';

const todayLocal = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export default function LogRent() {
  const params = useLocalSearchParams<{
    leaseId: string;
    entityId: string;
    name: string;
    open: string;
    currency: string;
  }>();
  const router = useRouter();
  const { state: session, api } = useSession();
  const can = useAbilities();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const owed = BigInt(params.open ?? '0');
  const [accounts, setAccounts] = useState<AccountDto[]>([]);
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState(owed > 0n ? assignedInput(params.open, params.currency) : '');
  const [date, setDate] = useState(todayLocal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .accountList(ws)
      .then((list) => {
        const usable = rentAccounts(list, params.entityId);
        setAccounts(usable);
        setAccountId((current) => current || (usable[0]?.id ?? ''));
      })
      .catch((err: Error) => setError(err.message));
  }, [api, ws, params.entityId]);

  const save = async () => {
    const minor = parseAssigned(amount, params.currency);
    if (!minor || BigInt(minor) <= 0n) return setError(t('money.positive'));
    if (!accountId) return setError(t('mobile.rentals.choose_account'));
    setBusy(true);
    setError(null);
    try {
      await api.recordRent(ws, params.leaseId, { accountId, date: calendarDate(date.trim()), amount: minor });
      router.back();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Rent posts to the rental books: for those who keep them (AUTH-18).
  if (!can.setUp || !can.writes(params.entityId))
    return (
      <Screen>
        <NotAllowed />
      </Screen>
    );
  return (
    <Screen testID="rentals-log">
      {error ? <Banner tone="danger" text={error} /> : null}
      <Card>
        <Body style={{ fontWeight: '700' }}>{params.name}</Body>
        {owed > 0n ? (
          <Small>
            {t('rentals.still_open')}: {fmtMoney(params.open, params.currency)}
          </Small>
        ) : null}
      </Card>
      <Card>
        <Field
          label={t('rentals.amount')}
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          testID="rentals-amount"
        />
        <Field label={t('rentals.date')} value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" />
        {accounts.length > 0 ? (
          <Segmented
            label={t('rentals.into_account')}
            value={accountId}
            options={accounts.slice(0, 4).map((a) => ({ value: a.id, label: a.name }))}
            onChange={setAccountId}
          />
        ) : null}
        <Button
          label={t('rentals.record_payment')}
          onPress={() => void save()}
          disabled={busy}
          testID="rentals-save"
        />
      </Card>
    </Screen>
  );
}

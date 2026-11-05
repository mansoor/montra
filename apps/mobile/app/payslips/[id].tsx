/**
 * Check and confirm a payslip on the phone (PAY-03, PAY-04): the payslip beside what was read from it. Several
 * deposits that could be this pay are offered to choose from. Amounts are corrected on the web review screen.
 */
import { useCallback, useEffect, useState } from 'react';
import { Image } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { depositChoices } from '@montra/domain';
import type { PayslipDto } from '@montra/schemas';
import { config } from '../../src/config';
import { canConfirm, linesBySection } from '../../src/features/payslips';
import { fmtDate, fmtMoney, t } from '../../src/i18n';
import { useSession } from '../../src/session/SessionProvider';
import { Banner, Body, Button, Card, Row, Screen, Small, Title } from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';

export default function PayslipReview() {
  const th = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { state: session, api, token } = useSession();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const [payslip, setPayslip] = useState<PayslipDto | null>(null);
  const [bearer, setBearer] = useState<string | null>(null);
  const [unshown, setUnshown] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [picks, setPicks] = useState<Record<string, string | null>>({});
  const [accountNames, setAccountNames] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPayslip(await api.getPayslip(ws, id));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, ws, id]);

  useEffect(() => {
    void load();
    void token().then(setBearer);
    void api.accountList(ws).then(
      (list) => setAccountNames(new Map(list.map((a) => [a.id, a.name]))),
      () => undefined,
    );
  }, [load, token, api, ws]);

  // While the payslip is being read, check back.
  useEffect(() => {
    if (payslip?.status !== 'processing') return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [payslip?.status, load]);

  const confirm = async (chosen: Record<string, string | null> = {}) => {
    if (!payslip) return;
    setBusy(true);
    setError(null);
    try {
      setPayslip(
        await api.confirmPayslip(ws, id, {
          version: payslip.version,
          ...depositChoices(
            payslip.deposits.map((d) => d.accountId),
            chosen,
          ),
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deletePayslip(ws, id);
      router.back();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (!payslip)
    return <Screen>{error ? <Banner tone="danger" text={error} /> : <Body muted>…</Body>}</Screen>;
  const ccy = payslip.currency;
  const candidates = payslip.status === 'needs_review' ? payslip.matchCandidates : [];
  const askedAccounts = [...new Set(candidates.map((c) => c.accountId))];
  /** Picks one account's deposit, and goes ahead once every account asked about has an answer. */
  const pick = (accountId: string, transactionId: string | null) => {
    const next = { ...picks, [accountId]: transactionId };
    setPicks(next);
    if (askedAccounts.every((id) => id in next)) void confirm(next);
  };
  const nameOf = (id: string) => accountNames.get(id) ?? t('payslips.deposit');

  return (
    <Screen testID="payslip-review">
      <Title>{fmtMoney(payslip.net, ccy)}</Title>
      <Small>
        {[payslip.payDate ? fmtDate(payslip.payDate) : null, t(`mobile.payslips.status.${payslip.status}`)]
          .filter(Boolean)
          .join(' · ')}
      </Small>
      {payslip.status === 'processing' ? <Body muted>{t('mobile.payslips.reading')}</Body> : null}
      {payslip.status === 'needs_review' && payslip.gap !== '0' ? (
        <Banner tone="warning" text={t('mobile.payslips.gap', { amount: fmtMoney(payslip.gap, ccy) })} />
      ) : null}
      {payslip.status === 'posted' && payslip.matchedDeposit ? (
        <Banner text={t('mobile.payslips.matched')} />
      ) : null}

      {bearer
        ? payslip.fileIds.map((fileId, i) =>
            unshown.has(fileId) ? (
              <Small key={fileId}>{t('mobile.payslips.file_on_web')}</Small>
            ) : (
              <Image
                key={fileId}
                accessibilityLabel={t('mobile.receipts.page_n', { n: i + 1 })}
                source={{
                  uri: `${config.apiUrl}${api.payslipFilePath(ws, payslip.id, fileId)}`,
                  headers: { authorization: `Bearer ${bearer}` },
                }}
                onError={() => setUnshown((s) => new Set(s).add(fileId))}
                style={{ height: 320, borderRadius: th.radius, backgroundColor: th.surface }}
                resizeMode="contain"
              />
            ),
          )
        : null}

      {linesBySection(payslip).map((g) => (
        <Card key={g.section}>
          <Body>{t(`payslips.section.${g.section}`)}</Body>
          {g.lines.map((l) => (
            <Row key={l.id} title={l.label} right={<Small>{fmtMoney(l.amount, ccy)}</Small>} />
          ))}
        </Card>
      ))}

      {payslip.deposits.length > 0 ? (
        <Card testID="payslip-deposits">
          <Body>{t('mobile.payslips.deposits')}</Body>
          <Row
            title={t('mobile.payslips.main_account')}
            right={<Small>{fmtMoney(payslip.mainDeposit, ccy)}</Small>}
          />
          {payslip.deposits.map((d) => (
            <Row
              key={d.accountId}
              title={nameOf(d.accountId)}
              right={<Small>{fmtMoney(d.amount, ccy)}</Small>}
              testID="payslip-deposit"
            />
          ))}
          {payslip.status !== 'posted' ? <Small>{t('mobile.payslips.change_split_on_web')}</Small> : null}
        </Card>
      ) : null}
      {candidates.length > 0 ? (
        <Card testID="payslip-candidates">
          <Body>{t('payslips.choose_deposit')}</Body>
          <Small>{t('payslips.choose_deposit_hint')}</Small>
          {askedAccounts.map((accountId) => (
            <Card key={accountId} testID="payslip-deposit-choice">
              {askedAccounts.length > 1 || payslip.deposits.length > 0 ? (
                <Small>{nameOf(accountId)}</Small>
              ) : null}
              {candidates
                .filter((c) => c.accountId === accountId)
                .map((c) => (
                  <Row
                    key={c.transactionId}
                    title={c.payee ?? t('payslips.deposit')}
                    subtitle={`${fmtDate(c.date)}${picks[accountId] === c.transactionId ? ' ✓' : ''}`}
                    right={<Small>{fmtMoney(c.amount, ccy)}</Small>}
                    onPress={() => pick(accountId, c.transactionId)}
                    testID="payslip-candidate"
                  />
                ))}
              <Button
                kind="secondary"
                label={t('payslips.none_of_these')}
                busy={busy}
                onPress={() => pick(accountId, null)}
              />
            </Card>
          ))}
        </Card>
      ) : canConfirm(payslip) ? (
        <Button
          label={t('payslips.confirm')}
          busy={busy}
          onPress={() => void confirm()}
          testID="payslip-confirm"
        />
      ) : null}
      {payslip.status === 'needs_review' && !canConfirm(payslip) && candidates.length === 0 ? (
        <Small>{t('mobile.payslips.fix_on_web')}</Small>
      ) : null}
      {error ? <Banner tone="danger" text={error} /> : null}
      {payslip.status !== 'processing' ? (
        <Button
          kind="secondary"
          label={t('payslips.delete')}
          busy={busy}
          onPress={() => void remove()}
          testID="payslip-delete"
        />
      ) : null}
    </Screen>
  );
}

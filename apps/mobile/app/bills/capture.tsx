/**
 * Scanning a bill (ADR-0048 §4): the phone's document scanner first, the camera when it can't run, or a picked PDF or
 * photo. The scan is read once: the provider is found among the budget's bill providers (by the account number's last
 * four digits, else by name), with the amount due and the due date. The person checks them and saves; the bill then
 * shows in upcoming and the forecast with its exact amount, and is marked paid when the payment comes in. A provider
 * that isn't on the budget yet is added here, on the category chosen.
 */
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { money, parseMoney, toDecimalString, type CurrencyCode } from '@montra/domain';
import type { BillerDto, ScanBillDetectedDto } from '@montra/schemas';
import { fmtDate, t } from '../../src/i18n';
import { waitForScan, type CapturedPage } from '../../src/features/scanner';
import { removePage } from '../../src/receipts/files';
import { useAbilities, useSession } from '../../src/session/SessionProvider';
import { useLocal } from '../../src/sync/SyncProvider';
import { DocumentCapture } from '../../src/ui/DocumentCapture';
import { NotAllowed } from '../../src/ui/NotAllowed';
import {
  Banner,
  Body,
  Button,
  Card,
  Field,
  Row,
  Screen,
  Small,
  Title,
  useToast,
} from '../../src/ui/components';
import { Icon } from '../../src/ui/icons';
import { useTheme } from '../../src/ui/theme';

interface Read {
  scanId?: string;
  found: ScanBillDetectedDto | null;
}

/** "84.12" in the bill's currency → minor units, or null. */
function toMinor(text: string, currency: string): string | null {
  try {
    const m = parseMoney(text.trim(), currency as CurrencyCode).amount;
    return m > 0n ? m.toString() : null;
  } catch {
    return null;
  }
}

export default function BillCapture() {
  const th = useTheme();
  const router = useRouter();
  const toast = useToast();
  const { state: session, api } = useSession();
  const can = useAbilities();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const currency = session.status === 'signed_in' ? session.workspace.baseCurrency : 'USD';
  const categories = (useLocal((s) => s.getReference('categories')) ?? []).filter(
    (c) => c.type === 'expense',
  );
  const [billers, setBillers] = useState<BillerDto[] | null>(null);
  const [read, setRead] = useState<Read | null>(null);
  const [billerId, setBillerId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ws) return;
    api.billers(ws).then(
      (list) => setBillers(list.filter((b) => !b.archived)),
      (err: Error) => setError(err.message),
    );
  }, [api, ws]);

  const captured = async (pages: CapturedPage[]) => {
    setBusy(true);
    setError(null);
    try {
      const fileIds: string[] = [];
      for (const p of pages)
        fileIds.push((await api.uploadBillFile(ws, { uri: p.uri, name: p.name, type: p.type })).fileId);
      await Promise.all(pages.filter((p) => p.shot).map((p) => removePage(p.uri)));
      const scan = await api.createScan(ws, 'bill', fileIds);
      const done = await waitForScan(() => api.getScan(ws, scan.id));
      const found = done?.status === 'ready' ? done.bill : null;
      setRead({ scanId: done?.status === 'ready' ? scan.id : undefined, found });
      setBillerId(found?.billerId ?? found?.candidates[0]?.billerId ?? null);
      setNewName(found?.billerName ?? '');
      if (found?.amount && found.currency) setAmount(toDecimalString(money(found.amount, found.currency)));
      if (found?.dueDate) setDue(found.dueDate);
      if (!done || done.status === 'failed') setError(t('mobile.bills.not_read'));
    } finally {
      setBusy(false);
    }
  };

  const billCurrency = read?.found?.currency ?? currency;
  const minor = toMinor(amount, billCurrency);
  const dueOk = /^\d{4}-\d{2}-\d{2}$/.test(due);
  const chosenCategory = categoryId ?? categories.find((c) => c.name === 'Utilities')?.id ?? null;

  const save = async () => {
    if (!minor || !dueOk) return;
    setBusy(true);
    setError(null);
    try {
      let id = billerId;
      if (!id) {
        if (!newName.trim() || !chosenCategory) return;
        id = (
          await api.createBiller(ws, {
            name: newName.trim(),
            categoryId: chosenCategory,
            dueDay: null,
            accountLast4: read?.found?.accountLast4 ?? null,
          })
        ).id;
      }
      const f = read?.found;
      await api.createHouseholdBill(ws, {
        billerId: id,
        ...(read?.scanId ? { scanId: read.scanId } : {}),
        amount: minor,
        dueDate: due,
        billDate: f?.billDate ?? null,
        periodStart: f?.periodStart ?? null,
        periodEnd: f?.periodEnd ?? null,
      });
      toast.show(t('mobile.bills.saved'));
      router.replace('/bills');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!can.record)
    return (
      <Screen>
        <NotAllowed />
      </Screen>
    );
  if (!read)
    return (
      <Screen testID="bill-capture">
        {busy ? <Small>{t('mobile.bills.reading')}</Small> : null}
        <DocumentCapture
          scanLabel={t('mobile.bills.scan')}
          scanHint={t('mobile.bills.scan_hint')}
          cameraHint={t('mobile.bills.camera_hint')}
          onPages={captured}
          busy={busy}
        />
        {error ? <Banner tone="danger" text={error} /> : null}
      </Screen>
    );

  const f = read.found;
  const list = billers ?? [];
  return (
    <Screen testID="bill-confirm">
      <Title>{t('mobile.bills.check')}</Title>
      {f?.billerName ? (
        <Card>
          <Body style={{ fontWeight: '600' }}>{f.billerName}</Body>
          <Small>
            {[
              f.accountLast4 ? t('mobile.bills.account_ending', { last4: f.accountLast4 }) : null,
              f.periodStart && f.periodEnd
                ? t('mobile.bills.period', { from: fmtDate(f.periodStart), to: fmtDate(f.periodEnd) })
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Small>
        </Card>
      ) : null}
      {error ? <Banner tone="warning" text={error} /> : null}
      <Field
        label={t('mobile.bills.amount', { currency: billCurrency })}
        keyboardType="decimal-pad"
        value={amount}
        onChangeText={setAmount}
        testID="bill-amount"
      />
      <Field
        label={t('mobile.bills.due_date')}
        placeholder="YYYY-MM-DD"
        value={due}
        onChangeText={setDue}
        testID="bill-due"
      />
      <Small>{f?.billerId ? t('mobile.bills.found_provider') : t('mobile.bills.choose_provider')}</Small>
      <View>
        {list.map((b, i) => (
          <Row
            key={b.id}
            title={b.name}
            last={i === list.length - 1 && billerId !== null}
            onPress={() => setBillerId(b.id)}
            right={
              b.id === billerId ? (
                <Icon name="check" size={18} color={th.primary} />
              ) : (
                <View style={{ width: 18 }} />
              )
            }
          />
        ))}
        <Row
          title={t('mobile.bills.new_provider')}
          last
          onPress={() => setBillerId(null)}
          right={
            billerId === null ? (
              <Icon name="check" size={18} color={th.primary} />
            ) : (
              <View style={{ width: 18 }} />
            )
          }
        />
      </View>
      {billerId === null ? (
        <Card>
          <Field label={t('mobile.billers.name')} value={newName} onChangeText={setNewName} />
          <Small>{t('mobile.billers.category')}</Small>
          {categories.slice(0, 40).map((c, i, all) => (
            <Row
              key={c.id}
              title={c.name}
              subtitle={c.group ?? undefined}
              last={i === all.length - 1}
              onPress={() => setCategoryId(c.id)}
              right={
                c.id === chosenCategory ? (
                  <Icon name="check" size={18} color={th.primary} />
                ) : (
                  <View style={{ width: 18 }} />
                )
              }
            />
          ))}
        </Card>
      ) : null}
      <Button
        label={t('mobile.bills.save')}
        busy={busy}
        disabled={!minor || !dueOk || (billerId === null && (!newName.trim() || !chosenCategory))}
        onPress={() => void save()}
        testID="bill-save"
      />
    </Screen>
  );
}

/**
 * Bill providers on the phone's budget (ADR-0048 §4): the companies that send the budget's bills, each with its next
 * bill estimated from the payments to it, and a form to add one. The estimate shows in upcoming and the forecast.
 */
import { useState } from 'react';
import { View } from 'react-native';
import type { BillerDto } from '@montra/schemas';
import { fmtDate, fmtMoney, t } from '../i18n';
import { Body, Button, Card, Field, Row, Small } from './components';
import { Icon } from './icons';
import { SidePanel } from './SidePanel';
import { useTheme } from './theme';

/** "SDG&E · ≈ $85.00 due Nov 20", or just the name before it has a payment to go on. */
export function billerSummary(b: BillerDto): string {
  return b.next
    ? t('mobile.billers.summary', {
        name: b.name,
        amount: fmtMoney(b.next.amount, b.next.currency),
        date: fmtDate(b.next.date),
      })
    : b.name;
}

export function BillersCard({
  billers,
  categories,
  canEdit,
  onAdd,
}: {
  billers: BillerDto[];
  /** The budget's categories, to put a provider on. */
  categories: { id: string; name: string }[];
  canEdit: boolean;
  onAdd: (input: {
    name: string;
    categoryId: string;
    dueDay: number | null;
    accountLast4: string | null;
  }) => Promise<boolean>;
}) {
  const th = useTheme();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [dueDay, setDueDay] = useState('');
  const [last4, setLast4] = useState('');
  const [busy, setBusy] = useState(false);
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const chosen =
    categoryId ?? categories.find((c) => c.name === 'Utilities')?.id ?? categories[0]?.id ?? null;
  const day = dueDay.trim() ? Number(dueDay) : null;
  const valid =
    name.trim().length > 0 &&
    chosen !== null &&
    (day === null || (Number.isInteger(day) && day >= 1 && day <= 31)) &&
    (last4 === '' || /^\d{4}$/.test(last4));

  return (
    <Card testID="billers">
      <Body style={{ fontWeight: '700' }}>{t('mobile.billers.title')}</Body>
      <Small>{t('mobile.billers.hint')}</Small>
      {billers.length === 0 ? <Body muted>{t('mobile.billers.empty')}</Body> : null}
      {billers.map((b, i) => (
        <Row
          key={b.id}
          testID="biller-row"
          title={b.name}
          subtitle={[
            names.get(b.categoryId),
            b.next
              ? t('mobile.billers.next', {
                  amount: fmtMoney(b.next.amount, b.next.currency),
                  date: fmtDate(b.next.date),
                })
              : t('mobile.billers.no_payments'),
          ]
            .filter(Boolean)
            .join(' · ')}
          last={i === billers.length - 1}
        />
      ))}
      {canEdit ? (
        <Button kind="secondary" icon="add" label={t('mobile.billers.add')} onPress={() => setAdding(true)} />
      ) : null}
      <SidePanel
        visible={adding}
        title={t('mobile.billers.add')}
        closeLabel={t('mobile.common.cancel')}
        onClose={() => setAdding(false)}
        testID="biller-form"
        footer={
          <Button
            label={t('mobile.billers.save')}
            busy={busy}
            disabled={!valid}
            onPress={() => {
              setBusy(true);
              void onAdd({ name: name.trim(), categoryId: chosen!, dueDay: day, accountLast4: last4 || null })
                .then((ok) => {
                  if (!ok) return;
                  setAdding(false);
                  setName('');
                  setDueDay('');
                  setLast4('');
                })
                .finally(() => setBusy(false));
            }}
          />
        }
      >
        <Field
          label={t('mobile.billers.name')}
          placeholder="SDG&E, Comcast, GEICO…"
          value={name}
          onChangeText={setName}
        />
        <Field
          label={t('mobile.billers.due_day')}
          keyboardType="number-pad"
          maxLength={2}
          value={dueDay}
          onChangeText={setDueDay}
        />
        <Field
          label={t('mobile.billers.last4')}
          keyboardType="number-pad"
          maxLength={4}
          value={last4}
          onChangeText={setLast4}
        />
        <Small>{t('mobile.billers.category')}</Small>
        <View>
          {categories.map((c, i) => (
            <Row
              key={c.id}
              title={c.name}
              last={i === categories.length - 1}
              onPress={() => setCategoryId(c.id)}
              right={
                c.id === chosen ? (
                  <Icon name="check" size={18} color={th.primary} />
                ) : (
                  <View style={{ width: 18 }} />
                )
              }
            />
          ))}
        </View>
      </SidePanel>
    </Card>
  );
}

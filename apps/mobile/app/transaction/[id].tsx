/**
 * Transaction detail and edit (DE-10 on the server): payee, date, account, category, memo, tags; splits are read-only.
 * The receipt button sits by the amount: it opens the receipt, or adds one.
 */
import { useCallback, useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { canSpendFrom } from '@montra/domain';
import type { CategoryDto, TransactionDto, UpdateTransactionRequest } from '@montra/schemas';
import type { LocalTransaction } from '@montra/sync';
import { expenseLines } from '../../src/features/business';
import { editRules } from '../../src/features/transaction-edit';
import { fmtMoney, t } from '../../src/i18n';
import { useSession } from '../../src/session/SessionProvider';
import { useLocal, useSync } from '../../src/sync/SyncProvider';
import { CategoryPicker } from '../../src/ui/CategoryPicker';
import { Banner, Body, Button, Card, Field, Row, Screen, Small } from '../../src/ui/components';
import { Icon } from '../../src/ui/icons';
import { SidePanel } from '../../src/ui/SidePanel';
import { useTheme } from '../../src/ui/theme';

export default function TransactionDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const th = useTheme();
  const { engine, receipts, touch } = useSync();
  const { state: session, api } = useSession();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const row = useLocal((s) => s.getTransaction(id), [id]);
  const categories = useLocal((s) => s.getReference('categories')) ?? [];
  const allAccounts = useLocal((s) => s.getReference('accounts')) ?? [];
  const [draft, setDraft] = useState<LocalTransaction | null>(null);
  const [picking, setPicking] = useState(false);
  const [choosingAccount, setChoosingAccount] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The receipt, fresh from the server: linking one doesn't always change the synced transaction.
  const [fresh, setFresh] = useState<TransactionDto['receipt'] | undefined>(undefined);
  const [queued, setQueued] = useState(false);

  useEffect(() => {
    if (row && !draft) setDraft(row);
  }, [row, draft]);

  useFocusEffect(
    useCallback(() => {
      let live = true;
      void receipts.list().then((items) => {
        if (live) setQueued(items.some((q) => q.transactionId === id));
      });
      if (ws)
        api.getTransaction(ws, id).then(
          (txn) => {
            if (live) setFresh(txn.receipt);
          },
          () => undefined, // offline or not synced yet: the synced copy stands
        );
      return () => {
        live = false;
      };
    }, [api, receipts, ws, id]),
  );

  if (!row || !draft)
    return (
      <Screen>
        <Small>{t('mobile.common.loading')}</Small>
      </Screen>
    );
  const splits = row.server?.splits ?? null;
  const isSplit = Boolean(splits && splits.length > 1);
  const categoryName = draft.categoryId
    ? (categories.find((c) => c.id === draft.categoryId)?.name ?? draft.categoryName)
    : null;
  // The paying account can change on an income or expense nothing else manages, to another in the same currency;
  // a reconciled one keeps its account, amount and date (DE-15).
  const { reconciled, canMove, canChangeDate } = editRules(row);
  const account = allAccounts.find((a) => a.id === draft.accountId);
  const accountChoices = allAccounts.filter(
    (a) => a.id === row.accountId || (canSpendFrom(a) && a.currency === row.currency),
  );
  // How the category was chosen ("Chosen by you", a rule, the AI): only while it is still that category.
  const how = draft.categoryId === row.categoryId ? row.explanation : null;
  const receipt = fresh !== undefined ? fresh : (row.server?.receipt ?? null);
  // BIZ-18: who spent and, for a meal, who was there and why. Entered on the web.
  const business = expenseLines(row.server?.expenseDetail);
  const canAdd = !row.pending && Boolean(row.amount?.startsWith('-')) && !row.server?.managedBy;
  const receiptState: ReceiptState | null = receipt
    ? receipt.status === 'processing'
      ? 'reading'
      : receipt.status === 'needs_review'
        ? 'check'
        : 'view'
    : queued
      ? 'waiting'
      : canAdd
        ? 'add'
        : null;

  const save = async () => {
    setError(null);
    const patch: UpdateTransactionRequest = {};
    if (draft.payee !== row.payee) patch.payee = draft.payee;
    if (canChangeDate && draft.date !== row.date) patch.date = draft.date as UpdateTransactionRequest['date'];
    if (draft.memo !== row.memo) patch.memo = draft.memo;
    if (canMove && draft.accountId && draft.accountId !== row.accountId) patch.accountId = draft.accountId;
    if (draft.tags.join(',') !== row.tags.join(',')) patch.tags = draft.tags;
    if (!isSplit && draft.categoryId && draft.categoryId !== row.categoryId)
      patch.categoryId = draft.categoryId;
    if (Object.keys(patch).length === 0) return router.back();
    try {
      if (patch.categoryId && row.reviewState === 'needs_review' && Object.keys(patch).length === 1)
        await engine.resolveReview(row.id, patch.categoryId);
      else await engine.updateTransaction(row.id, patch);
      touch();
      router.back();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Screen testID="txn-detail">
      {row.pending ? <Banner text={t('mobile.txn.pending')} /> : null}
      {error ? <Banner tone="danger" text={error} /> : null}
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space(3) }}>
          {reconciled ? <Icon name="locked" size={20} color={th.muted} /> : null}
          <Body style={{ flex: 1, fontSize: 28, fontWeight: '700' }}>
            {fmtMoney(row.amount, row.currency)}
          </Body>
          {receiptState ? (
            <ReceiptButton
              state={receiptState}
              onPress={() => {
                if (receipt) router.push(`/receipts/${receipt.id}`);
                else if (receiptState === 'waiting') router.push('/receipts');
                else router.push({ pathname: '/receipt-capture', params: { transactionId: row.id } });
              }}
            />
          ) : null}
        </View>
        {receiptState && receiptState !== 'add' && receiptState !== 'view' ? (
          <Small>{t(RECEIPT_LABEL[receiptState])}</Small>
        ) : null}
        {reconciled ? <Small>{t('mobile.txn.reconciled_note')}</Small> : null}
      </Card>
      {business ? (
        <Card testID="txn-expense-detail">
          {business.spentBy ? (
            <Row
              title={t('expense.spent_by')}
              subtitle={business.spentBy === 'owner' ? t('expense.spent_by_owner') : business.spentBy}
            />
          ) : null}
          {business.attendees ? <Row title={t('expense.attendees')} subtitle={business.attendees} /> : null}
          {business.purpose ? <Row title={t('expense.purpose')} subtitle={business.purpose} /> : null}
          {business.mealHint ? <Small>{t('expense.meal_hint')}</Small> : null}
        </Card>
      ) : null}
      <Field
        label={t('mobile.txn.payee')}
        value={draft.payee ?? ''}
        onChangeText={(v) => setDraft({ ...draft, payee: v || null })}
        testID="ed-payee"
      />
      {canChangeDate ? (
        <Field
          label={t('mobile.txn.date')}
          value={draft.date}
          onChangeText={(v) => setDraft({ ...draft, date: v })}
          placeholder="YYYY-MM-DD"
          keyboardType="numbers-and-punctuation"
        />
      ) : (
        <Row title={t('mobile.txn.date')} subtitle={row.date} icon="locked" testID="ed-date-locked" />
      )}
      <Row
        title={t('mobile.txn.account')}
        subtitle={[account?.name ?? '', canMove ? null : t('mobile.txn.account_fixed')]
          .filter(Boolean)
          .join(' · ')}
        onPress={canMove ? () => setChoosingAccount(true) : undefined}
        testID="ed-account"
      />
      {isSplit ? (
        <Card>
          <Small>{t('mobile.txn.splits')}</Small>
          {splits!.map((s, i) => (
            <Row
              key={`${s.accountId}-${i}`}
              title={categories.find((c) => c.id === s.accountId)?.name ?? s.accountId}
              right={<Body>{fmtMoney(s.amount, row.currency)}</Body>}
            />
          ))}
          <Small>{t('mobile.txn.split_readonly')}</Small>
        </Card>
      ) : (
        <Row
          title={t('mobile.txn.category')}
          subtitle={[categoryName ?? t('mobile.txn.uncategorized'), how].filter(Boolean).join(' · ')}
          onPress={() => setPicking(true)}
          testID="ed-category"
        />
      )}
      <Field
        label={t('mobile.txn.memo')}
        value={draft.memo ?? ''}
        onChangeText={(v) => setDraft({ ...draft, memo: v || null })}
        multiline
      />
      <Field
        label={t('mobile.txn.tags')}
        value={draft.tags.join(', ')}
        onChangeText={(v) =>
          setDraft({
            ...draft,
            tags: v
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean),
          })
        }
        autoCapitalize="none"
      />
      <Button label={t('mobile.txn.save')} onPress={() => void save()} testID="ed-save" />
      <SidePanel
        visible={choosingAccount}
        title={t('mobile.txn.account')}
        closeLabel={t('mobile.common.cancel')}
        onClose={() => setChoosingAccount(false)}
        testID="ed-account-list"
      >
        {accountChoices.map((a, i) => (
          <Row
            key={a.id}
            title={a.name}
            subtitle={t(`account.kind.${a.kind}`)}
            right={a.id === draft.accountId ? <Icon name="check" size={18} color={th.primary} /> : undefined}
            onPress={() => {
              setDraft({ ...draft, accountId: a.id });
              setChoosingAccount(false);
            }}
            last={i === accountChoices.length - 1}
          />
        ))}
      </SidePanel>
      <CategoryPicker
        visible={picking}
        categories={categories}
        kind={row.amount?.startsWith('-') ? 'expense' : 'income'}
        onClose={() => setPicking(false)}
        onPick={(c: CategoryDto) => {
          setDraft({ ...draft, categoryId: c.id, categoryName: c.name });
          setPicking(false);
        }}
      />
    </Screen>
  );
}

type ReceiptState = 'add' | 'view' | 'reading' | 'check' | 'waiting';

const RECEIPT_LABEL: Record<ReceiptState, string> = {
  add: 'mobile.receipts.add_to_transaction',
  view: 'mobile.txn.receipt_view',
  reading: 'mobile.txn.receipt_reading',
  check: 'mobile.txn.receipt_check',
  waiting: 'mobile.txn.receipt_waiting',
};

/** The receipt by the amount: filled when there is one, a quiet "+" when one can be added. */
function ReceiptButton({ state, onPress }: { state: ReceiptState; onPress: () => void }) {
  const th = useTheme();
  const has = state === 'view';
  const attention = state === 'check';
  const bg = has ? th.primary : attention ? th.warningSoft : th.primarySoft;
  const fg = has ? th.onPrimary : attention ? th.warning : th.primary;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t(RECEIPT_LABEL[state])}
      testID={state === 'add' ? 'txn-add-receipt' : 'txn-receipt'}
      hitSlop={6}
      style={({ pressed }) => ({
        width: th.tap,
        height: th.tap,
        borderRadius: th.tap / 2,
        backgroundColor: bg,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Icon name="receipt" size={22} color={fg} />
      {state === 'add' ? (
        <View
          style={{
            position: 'absolute',
            right: 4,
            bottom: 4,
            width: 16,
            height: 16,
            borderRadius: 8,
            backgroundColor: th.primary,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="add" size={12} color={th.onPrimary} strokeWidth={3} />
        </View>
      ) : null}
    </Pressable>
  );
}

/** Transaction detail and edit (DE-10 on the server): payee, date, category, memo, tags; splits are read-only. */
import { useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { CategoryDto, UpdateTransactionRequest } from '@montra/schemas';
import type { LocalTransaction } from '@montra/sync';
import { fmtMoney, t } from '../../src/i18n';
import { useLocal, useSync } from '../../src/sync/SyncProvider';
import { CategoryPicker } from '../../src/ui/CategoryPicker';
import { Banner, Body, Button, Card, Field, Row, Screen, Small } from '../../src/ui/components';

export default function TransactionDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { engine, touch } = useSync();
  const row = useLocal((s) => s.getTransaction(id), [id]);
  const categories = useLocal((s) => s.getReference('categories')) ?? [];
  const [draft, setDraft] = useState<LocalTransaction | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (row && !draft) setDraft(row);
  }, [row, draft]);

  if (!row || !draft) return <Screen><Small>{t('mobile.common.loading')}</Small></Screen>;
  const splits = row.server?.splits ?? null;
  const isSplit = Boolean(splits && splits.length > 1);
  const categoryName = draft.categoryId ? (categories.find((c) => c.id === draft.categoryId)?.name ?? draft.categoryName) : null;

  const save = async () => {
    setError(null);
    const patch: UpdateTransactionRequest = {};
    if (draft.payee !== row.payee) patch.payee = draft.payee;
    if (draft.date !== row.date) patch.date = draft.date as UpdateTransactionRequest['date'];
    if (draft.memo !== row.memo) patch.memo = draft.memo;
    if (draft.tags.join(',') !== row.tags.join(',')) patch.tags = draft.tags;
    if (!isSplit && draft.categoryId && draft.categoryId !== row.categoryId) patch.categoryId = draft.categoryId;
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
        <Body style={{ fontSize: 28, fontWeight: '700' }}>{fmtMoney(row.amount, row.currency)}</Body>
        {row.explanation ? <Small>{row.explanation}</Small> : null}
      </Card>
      <Field label={t('mobile.txn.payee')} value={draft.payee ?? ''} onChangeText={(v) => setDraft({ ...draft, payee: v || null })} testID="ed-payee" />
      <Field
        label={t('mobile.txn.date')}
        value={draft.date}
        onChangeText={(v) => setDraft({ ...draft, date: v })}
        placeholder="YYYY-MM-DD"
        keyboardType="numbers-and-punctuation"
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
        <Row title={t('mobile.txn.category')} subtitle={categoryName ?? t('mobile.txn.uncategorized')} onPress={() => setPicking(true)} testID="ed-category" />
      )}
      <Field label={t('mobile.txn.memo')} value={draft.memo ?? ''} onChangeText={(v) => setDraft({ ...draft, memo: v || null })} multiline />
      <Field
        label={t('mobile.txn.tags')}
        value={draft.tags.join(', ')}
        onChangeText={(v) => setDraft({ ...draft, tags: v.split(',').map((x) => x.trim()).filter(Boolean) })}
        autoCapitalize="none"
      />
      <Button label={t('mobile.txn.save')} onPress={() => void save()} testID="ed-save" />
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

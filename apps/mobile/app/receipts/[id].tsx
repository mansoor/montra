/**
 * Receipt review on the phone (RCP-06, IMP-11): the receipt image, its lines with their categories (tap a line
 * to change it; the API learns an item rule), the splits, and linking to a transaction. Amount edits are on the
 * web review screen.
 */
import { useCallback, useEffect, useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { canSpendFrom, receiptAccountId } from '@montra/domain';
import type { CategoryDto, ReceiptDto } from '@montra/schemas';
import { config } from '../../src/config';
import { fmtDate, fmtMoney, t } from '../../src/i18n';
import { useAbilities, useSession } from '../../src/session/SessionProvider';
import { useLocal } from '../../src/sync/SyncProvider';
import {
  receiptStatusKey,
  reviewEdits,
  stalledMessage,
  uncategorizedLines,
} from '../../src/features/receipt-capture';
import { CategoryPicker } from '../../src/ui/CategoryPicker';
import { Banner, Body, Button, Card, Disclosure, Row, Screen, Small, Title } from '../../src/ui/components';
import { Icon } from '../../src/ui/icons';
import { ReceiptViewer } from '../../src/ui/ReceiptViewer';
import { SidePanel } from '../../src/ui/SidePanel';
import { useTheme } from '../../src/ui/theme';

export default function ReceiptReview() {
  const th = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { state: session, api, token } = useSession();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const categories = useLocal((s) => s.getReference('categories')) ?? [];
  const can = useAbilities();
  // Paid from an account in books this login writes (AUTH-18).
  const accounts = (useLocal((s) => s.getReference('accounts')) ?? []).filter(
    (a) => canSpendFrom(a) && can.writes(a.entityId),
  );
  const history = useLocal((s) => s.listTransactions({ limit: 200 })) ?? [];
  // Which account a new transaction from this receipt is paid from: chosen, else the card the receipt names.
  const [chosenAccount, setChosenAccount] = useState<string | null>(null);
  const [choosingAccount, setChoosingAccount] = useState(false);
  const [receipt, setReceipt] = useState<ReceiptDto | null>(null);
  const [bearer, setBearer] = useState<string | null>(null);
  const [picked, setPicked] = useState<Map<string, string | null>>(new Map());
  const [picking, setPicking] = useState<string | null>(null);
  // The receipt page open full screen for zooming, if any.
  const [viewing, setViewing] = useState<number | null>(null);
  // The photos fold away by default: the lines are what's checked here, the photo when something looks off.
  const [showImage, setShowImage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = new Map(categories.map((c) => [c.id, c.name]));

  const load = useCallback(async () => {
    try {
      setReceipt(await api.getReceipt(ws, id));
      setPicked(new Map());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, ws, id]);

  useEffect(() => {
    void load();
    void token().then(setBearer);
  }, [load, token]);

  // While the receipt is being read, check back.
  useEffect(() => {
    if (receipt?.status !== 'processing') return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [receipt?.status, load]);

  const act = async (fn: () => Promise<ReceiptDto>) => {
    setBusy(true);
    setError(null);
    try {
      setReceipt(await fn());
      setPicked(new Map());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!receipt)
    return <Screen>{error ? <Banner tone="danger" text={error} /> : <Body muted>…</Body>}</Screen>;
  // A viewer sees the receipt and its lines; matching and changing them is for those who record.
  const open = can.record && (receipt.status === 'inbox' || receipt.status === 'needs_review');
  const twin = receipt.likelyDuplicates[0];
  const payFromId =
    chosenAccount ??
    receiptAccountId(
      accounts,
      receipt.cardLast4,
      history.map((h) => h.accountId),
    );
  const payFrom = accounts.find((a) => a.id === payFromId);
  const missing = uncategorizedLines(receipt).length;
  const stalled = stalledMessage(receipt);
  const pages = bearer
    ? receipt.fileIds.map((fileId) => ({
        uri: `${config.apiUrl}${api.receiptFilePath(ws, receipt.id, fileId)}`,
        headers: { authorization: `Bearer ${bearer}` },
      }))
    : [];

  return (
    <Screen testID="receipt-review">
      <Title>{receipt.merchant ?? t('mobile.receipts.unknown_merchant')}</Title>
      <Small>
        {[receipt.receiptDate ? fmtDate(receipt.receiptDate) : null, t(receiptStatusKey(receipt))]
          .filter(Boolean)
          .join(' · ')}
      </Small>
      {stalled ? (
        <Banner tone="warning" text={t(stalled)} />
      ) : receipt.status === 'processing' ? (
        <Body muted>{t('mobile.receipts.reading')}</Body>
      ) : null}
      {receipt.validationGap && receipt.validationGap !== '0' ? (
        <Banner
          tone="warning"
          text={t('mobile.receipts.gap', { amount: fmtMoney(receipt.validationGap, receipt.currency) })}
        />
      ) : null}
      {twin ? (
        <Card>
          <Banner tone="warning" text={t('mobile.receipts.duplicate_note')} />
          <Row
            title={t('mobile.receipts.duplicate_open')}
            subtitle={[
              twin.merchant,
              twin.receiptDate ? fmtDate(twin.receiptDate) : null,
              twin.total ? fmtMoney(twin.total, receipt.currency) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            onPress={() => router.push(`/receipts/${twin.id}`)}
            testID="receipt-duplicate"
          />
          {can.record && receipt.status !== 'matched' ? (
            <Button
              kind="danger"
              label={t('mobile.receipts.discard_copy')}
              busy={busy}
              onPress={() => {
                setBusy(true);
                api.deleteReceipt(ws, receipt.id).then(
                  () => router.back(),
                  (err: unknown) => {
                    setError((err as Error).message);
                    setBusy(false);
                  },
                );
              }}
              testID="receipt-discard"
            />
          ) : null}
        </Card>
      ) : null}
      {pages.length ? (
        <Disclosure
          title={t('mobile.receipts.image')}
          summary={t('mobile.receipts.pages', { count: pages.length })}
          open={showImage}
          onToggle={() => setShowImage((v) => !v)}
          testID="receipt-image-toggle"
        >
          <View style={{ gap: th.space(2) }}>
            {pages.map((source, i) => (
              <Pressable
                key={source.uri}
                accessibilityRole="imagebutton"
                accessibilityLabel={t('mobile.receipts.page_n', { n: i + 1 })}
                accessibilityHint={t('mobile.receipts.zoom_hint')}
                onPress={() => setViewing(i)}
                testID="receipt-page"
              >
                <Image
                  source={source}
                  style={{ height: 320, borderRadius: th.radius, backgroundColor: th.surface }}
                  resizeMode="contain"
                />
              </Pressable>
            ))}
            <Small>{t('mobile.receipts.zoom_hint')}</Small>
          </View>
        </Disclosure>
      ) : null}

      {receipt.lines.length ? <Title>{t('mobile.receipts.lines')}</Title> : null}
      {missing > 0 ? <Small>{t('mobile.receipts.uncategorized_count', { count: missing })}</Small> : null}
      {receipt.lines.map((l) => {
        const categoryId = picked.has(l.id) ? picked.get(l.id) : l.categoryId;
        return (
          <Row
            key={l.id}
            testID="receipt-line"
            title={l.expandedName ?? l.rawText}
            subtitle={categoryId ? (names.get(categoryId) ?? '') : t('mobile.receipts.uncategorized')}
            right={<Small>{fmtMoney(l.lineTotal, receipt.currency)}</Small>}
            onPress={can.record ? () => setPicking(l.id) : undefined}
          />
        );
      })}
      {picked.size > 0 ? (
        <Button
          label={t('mobile.receipts.save')}
          busy={busy}
          onPress={() => void act(() => api.updateReceipt(ws, receipt.id, reviewEdits(receipt, picked)))}
          testID="receipt-save"
        />
      ) : null}

      {receipt.groups.length ? (
        <Card>
          <Body>{t('mobile.receipts.splits')}</Body>
          {receipt.groups.map((g) => (
            <View key={g.lineIds.join()} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Small>
                {g.categoryId ? (names.get(g.categoryId) ?? '') : t('mobile.receipts.uncategorized')}
              </Small>
              <Small>{fmtMoney(g.total, receipt.currency)}</Small>
            </View>
          ))}
        </Card>
      ) : null}

      {receipt.transactionId ? (
        <Button
          kind="secondary"
          label={t('mobile.receipts.open_transaction')}
          onPress={() => router.push(`/transaction/${receipt.transactionId}`)}
        />
      ) : null}

      {open ? (
        <>
          <Title>{t('mobile.receipts.match_title')}</Title>
          {receipt.candidates.length === 0 ? <Body muted>{t('mobile.receipts.no_candidates')}</Body> : null}
          {receipt.candidates.map((c) => (
            <Row
              key={c.transactionId}
              title={`${c.payee ?? ''} · ${fmtMoney(c.amount.amount, c.amount.currency)}`}
              subtitle={`${fmtDate(c.date)} · ${t('mobile.receipts.score', { score: Math.trunc(c.score * 100) })}`}
              onPress={() =>
                void act(() =>
                  api.applyReceipt(ws, receipt.id, {
                    transactionId: c.transactionId,
                    version: receipt.version,
                  }),
                )
              }
            />
          ))}
          {payFrom ? (
            <>
              <Row
                title={t('mobile.receipts.paid_from')}
                subtitle={payFrom.name}
                onPress={() => setChoosingAccount(true)}
                testID="receipt-paid-from"
              />
              <Button
                kind="secondary"
                label={t('mobile.receipts.record', { account: payFrom.name })}
                busy={busy}
                onPress={() =>
                  void act(() =>
                    api.applyReceipt(ws, receipt.id, {
                      createTransaction: { accountId: payFrom.id },
                      version: receipt.version,
                    }),
                  )
                }
              />
            </>
          ) : null}
          <Button
            kind="secondary"
            label={t('mobile.receipts.match_again')}
            busy={busy}
            onPress={() => void act(() => api.matchReceipt(ws, receipt.id))}
          />
          <Button
            kind="danger"
            label={t('mobile.receipts.reject')}
            busy={busy}
            onPress={() => void act(() => api.rejectReceipt(ws, receipt.id))}
          />
        </>
      ) : null}
      {error ? <Banner tone="danger" text={error} /> : null}
      <ReceiptViewer pages={pages} page={viewing} onPage={setViewing} onClose={() => setViewing(null)} />
      <SidePanel
        visible={choosingAccount}
        title={t('mobile.receipts.paid_from')}
        closeLabel={t('mobile.common.cancel')}
        onClose={() => setChoosingAccount(false)}
        testID="receipt-account-list"
      >
        {accounts.map((a, i) => (
          <Row
            key={a.id}
            title={a.name}
            subtitle={t(`account.kind.${a.kind}`)}
            right={a.id === payFrom?.id ? <Icon name="check" size={18} color={th.primary} /> : undefined}
            onPress={() => {
              setChosenAccount(a.id);
              setChoosingAccount(false);
            }}
            last={i === accounts.length - 1}
          />
        ))}
      </SidePanel>
      <CategoryPicker
        visible={picking !== null}
        categories={categories}
        kind="expense"
        onClose={() => setPicking(null)}
        onPick={(c: CategoryDto) => {
          if (picking) setPicked(new Map(picked).set(picking, c.id));
          setPicking(null);
        }}
      />
    </Screen>
  );
}

/**
 * One tax form on the phone (ADR-0052 §7.2, TAX-09): its result, how it was read, its boxes to compare with the paper,
 * and its checks against the books box by box, with how each was worked out and a drill-down to the payslips and
 * transactions summed. From here: pick or change the match and the person, confirm the reading, accept a difference
 * with a note, and Record from the form. The server works out every check; editing the boxes is on the web. Kept on the
 * device for offline viewing; actions need a connection.
 */
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { EmployerDto, TaxFormDto } from '@montra/schemas';
import { fmtDate, fmtMoney, t } from '../../src/i18n';
import {
  acceptable,
  boxLabel,
  boxLines,
  canConfirmReading,
  canMatchEmployer,
  checkTone,
  drillDown,
  formCacheName,
  matchableAccounts,
  matchedIds,
  matchUpdate,
  personPickable,
  pickableCandidates,
  readingStage,
  resultTone,
  shownDifference,
} from '../../src/features/tax-forms';
import { useCached } from '../../src/features/use-cached';
import { useTaxFormsToCheck } from '../../src/features/use-tax-forms';
import { useAbilities, useSession } from '../../src/session/SessionProvider';
import { useLocal } from '../../src/sync/SyncProvider';
import {
  Banner,
  Body,
  Button,
  Card,
  CheckRow,
  Disclosure,
  Field,
  Row,
  Screen,
  Small,
  Title,
  useToast,
} from '../../src/ui/components';
import { Icon } from '../../src/ui/icons';
import { resultText, taxFormTitle, toneColor } from '../../src/ui/TaxForms';
import { useTheme } from '../../src/ui/theme';
import { useFileStorageStates, VaultBadges } from '../../src/ui/Vault';

type Check = TaxFormDto['checks'][number];

export default function TaxFormScreen() {
  const th = useTheme();
  const router = useRouter();
  const toast = useToast();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { state: session, api } = useSession();
  const can = useAbilities();
  const badge = useTaxFormsToCheck();
  const ws = session.status === 'signed_in' ? session.workspace : null;
  const wsId = ws?.id ?? '';
  const role = ws?.role ?? 'viewer';
  const cached = useCached<TaxFormDto>(wsId, formCacheName(id), () => api.getTaxForm(wsId, id), Boolean(ws));
  const form = cached.data?.id === id ? cached.data : null;
  const { reload } = cached;
  const people = useLocal((s) => s.getReference('members'));
  const allAccounts = useLocal((s) => s.getReference('accounts'));
  const [employers, setEmployers] = useState<EmployerDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [open, setOpen] = useState<'match' | 'person' | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [confirmRecord, setConfirmRecord] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const members = useMemo(() => (people ?? []).filter((m) => m.status === 'active'), [people]);
  const memberName = (mid: string | null) => (mid ? members.find((m) => m.id === mid)?.name : undefined);
  const matchEmployer = canMatchEmployer(role);

  // Employers are private to their person (PAY-09): an accountant gets none, and doesn't match a W-2.
  useEffect(() => {
    if (!ws || form?.kind !== 'w2' || !matchEmployer) return;
    api.listEmployers(ws.id).then(
      (list) => setEmployers(list.filter((e) => !e.archived && e.type === 'employer')),
      () => undefined,
    );
  }, [api, ws, form?.kind, matchEmployer]);

  // While it's being read, look again.
  const stage = form ? readingStage(form) : null;
  useEffect(() => {
    if (stage !== 'reading' && stage !== 'waiting') return;
    const timer = setInterval(() => void reload(), 5000);
    return () => clearInterval(timer);
  }, [stage, reload]);

  // ADR-0054 §13: where the form's files are with the vault. Read online only; offline there are none to show.
  const fileStates = useFileStorageStates(form?.fileIds ?? []);

  if (!form)
    return (
      <Screen>
        {cached.stale ? <Banner tone="warning" text={t('mobile.plan.offline_empty')} /> : null}
        {cached.error ? <Banner tone="danger" text={cached.error} /> : <Body muted>…</Body>}
      </Screen>
    );

  const canWrite = can.writes(form.entityId) && !cached.stale;
  const reading = form.status === 'reading';
  const r = form.reading;
  const matched = form.targets.length > 0;
  const candidates = matched || reading ? [] : pickableCandidates(form, role);
  const choices =
    form.kind === 'w2'
      ? employers.map((e) => ({ id: e.id, name: e.name }))
      : matchableAccounts(form.kind, allAccounts ?? []).map((a) => ({ id: a.id, name: a.name }));
  const multiple = form.kind === '1099_int' || form.kind === '1099_div';
  const recordable = form.result.recordable;

  /** Runs an action on the form, keeps its answer (and the offline copy), and reads the badge's count again. */
  const act = async (fn: () => Promise<TaxFormDto>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      cached.set(await fn());
      toast.show(done);
      void badge.refresh();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveMatch = async (pick: { employerId: string } | { accountIds: string[] }) => {
    const update = matchUpdate(form, pick);
    if (!update) return;
    if (await act(() => api.updateTaxForm(wsId, form.id, update), t('tax_forms.matched'))) setOpen(null);
  };

  const accept = async (box: string) => {
    if (!note.trim()) return;
    const ok = await act(
      () => api.acceptTaxFormDifference(wsId, form.id, { box, note: note.trim() }),
      t('tax_forms.accepted'),
    );
    if (ok) {
      setAccepting(null);
      setNote('');
    }
  };

  const person = memberName(form.personMemberId);
  return (
    <Screen
      testID="tax-form"
      refreshing={refreshing}
      onRefresh={() => {
        setRefreshing(true);
        void reload().finally(() => setRefreshing(false));
      }}
    >
      <Title>{taxFormTitle(form)}</Title>
      <Small>{[String(form.taxYear), person ?? t('tax_forms.person_unknown')].join(' · ')}</Small>
      <Body style={{ color: toneColor(th, resultTone(form.result.state)), fontWeight: '600' }}>
        {resultText(form)}
        {form.corrected ? ` · ${t('tax_forms.corrected')}` : ''}
      </Body>
      <VaultBadges fileIds={form.fileIds} states={fileStates} />
      {cached.stale ? <Banner tone="warning" text={t('mobile.tax_forms.offline')} /> : null}
      {error ? <Banner tone="danger" text={error} /> : null}

      {r && stage ? (
        <Card testID="tax-form-reading">
          <Body style={{ fontWeight: '600' }}>{t('tax_forms.reading_title')}</Body>
          <Small>
            {stage === 'reading' ? t('mobile.tax_forms.being_read') : t(`tax_forms.reading_stage.${stage}`)}
            {stage === 'unread' && r.problem ? ` ${t(`tax_forms.reading_problem.${r.problem}`)}` : ''}
          </Small>
          {stage === 'unread' ? <Small>{t('mobile.tax_forms.type_on_web')}</Small> : null}
          {r.droppedBoxes > 0 ? (
            <Small>{t('tax_forms.reading_dropped', { count: r.droppedBoxes })}</Small>
          ) : null}
          {r.copyOfId ? (
            <Row
              title={t('tax_forms.reading_copy_open')}
              subtitle={t('tax_forms.reading_copy')}
              onPress={() => router.push(`/tax-forms/${r.copyOfId}`)}
              last
            />
          ) : null}
          {matched && r.match.automatic && r.match.reason ? <Small>{r.match.reason}</Small> : null}
          {canWrite && canConfirmReading(form) ? (
            <>
              <Button
                label={t('tax_forms.confirm_reading')}
                busy={busy}
                onPress={() =>
                  void act(
                    () => api.confirmTaxFormReading(wsId, form.id, form.version),
                    t('tax_forms.reading_confirmed'),
                  )
                }
                testID="tax-form-confirm"
              />
              <Small>{t('mobile.tax_forms.confirm_hint')}</Small>
            </>
          ) : null}
        </Card>
      ) : null}

      {canWrite && candidates.length > 0 ? (
        <Card testID="tax-form-candidates">
          <Body style={{ fontWeight: '600' }}>{t('tax_forms.suggested')}</Body>
          {candidates.map((c, i) => (
            <Row
              key={c.employerId ?? c.accountId}
              title={t('tax_forms.match_to', { name: c.name })}
              subtitle={c.reason}
              onPress={
                busy
                  ? undefined
                  : () =>
                      void saveMatch(
                        c.employerId ? { employerId: c.employerId } : { accountIds: [c.accountId!] },
                      )
              }
              last={i === candidates.length - 1}
              testID="tax-form-candidate"
            />
          ))}
        </Card>
      ) : null}

      {canWrite && !reading ? (
        <Card style={{ paddingVertical: 0, gap: 0 }}>
          {form.kind === 'w2' && !matchEmployer ? (
            <View style={{ paddingVertical: th.space(2) }}>
              <Small>{t('tax_forms.employer_not_yours')}</Small>
            </View>
          ) : (
            <Disclosure
              title={t(
                form.kind === 'w2'
                  ? 'tax_forms.employer'
                  : form.kind === '1098'
                    ? 'tax_forms.mortgage'
                    : 'tax_forms.accounts',
              )}
              summary={
                matched
                  ? form.targets
                      .map((x) => choices.find((c) => c.id === (x.employerId ?? x.accountId))?.name)
                      .filter(Boolean)
                      .join(', ') || t('mobile.tax_forms.matched')
                  : t('tax_forms.not_matched')
              }
              open={open === 'match'}
              onToggle={() => {
                setPicked(matchedIds(form));
                setOpen(open === 'match' ? null : 'match');
              }}
              testID="tax-form-change-match"
            >
              {choices.length === 0 ? <Small>{t('tax_forms.no_accounts')}</Small> : null}
              {choices.map((c) => (
                <CheckRow
                  key={c.id}
                  title={c.name}
                  checked={picked.includes(c.id)}
                  onPress={() =>
                    setPicked((p) =>
                      multiple ? (p.includes(c.id) ? p.filter((x) => x !== c.id) : [...p, c.id]) : [c.id],
                    )
                  }
                />
              ))}
              {choices.length > 0 ? (
                <Button
                  label={t('mobile.tax_forms.save_match')}
                  busy={busy}
                  disabled={picked.length === 0}
                  onPress={() =>
                    void saveMatch(form.kind === 'w2' ? { employerId: picked[0]! } : { accountIds: picked })
                  }
                  testID="tax-form-save-match"
                />
              ) : null}
            </Disclosure>
          )}
          {personPickable(form) ? (
            <Disclosure
              title={t('tax_forms.person')}
              summary={person ?? t('tax_forms.person_unknown')}
              open={open === 'person'}
              onToggle={() => setOpen(open === 'person' ? null : 'person')}
              testID="tax-form-change-person"
            >
              {members.map((m, i) => (
                <Row
                  key={m.id}
                  title={m.name}
                  last={i === members.length - 1}
                  right={
                    m.id === form.personMemberId ? (
                      <Icon name="check" size={18} color={th.primary} />
                    ) : (
                      <View style={{ width: 18 }} />
                    )
                  }
                  onPress={
                    busy
                      ? undefined
                      : async () => {
                          const ok = await act(
                            () =>
                              api.updateTaxForm(wsId, form.id, {
                                personMemberId: m.id,
                                version: form.version,
                              }),
                            t('mobile.tax_forms.person_saved'),
                          );
                          if (ok) setOpen(null);
                        }
                  }
                />
              ))}
            </Disclosure>
          ) : null}
        </Card>
      ) : null}

      {!reading ? <Boxes form={form} /> : null}

      {reading ? null : form.checks.length === 0 ? (
        <Card>
          <Body muted>{t('tax_forms.no_checks')}</Body>
        </Card>
      ) : (
        <>
          <Title>{t('tax_forms.checks')}</Title>
          {form.checks.map((c) => (
            <CheckCard
              key={c.box}
              check={c}
              onOpen={(path) => router.push(path as never)}
              accept={
                canWrite && acceptable(c)
                  ? {
                      open: accepting === c.box,
                      note,
                      busy,
                      onOpen: () => {
                        setAccepting(c.box);
                        setNote('');
                      },
                      onNote: setNote,
                      onCancel: () => setAccepting(null),
                      onSave: () => void accept(c.box),
                    }
                  : null
              }
            />
          ))}
        </>
      )}

      {recordable && canWrite ? (
        <Card testID="tax-form-record">
          <Body style={{ fontWeight: '600' }}>{t('tax_forms.record_title')}</Body>
          <Small>
            {t('tax_forms.record_intro', {
              amount: fmtMoney(recordable.amount, 'USD'),
              category: recordable.categoryName,
              account: recordable.accountName,
              year: form.taxYear,
            })}
          </Small>
          {confirmRecord ? (
            <>
              <Button
                label={t('tax_forms.record_confirm', {
                  amount: fmtMoney(recordable.amount, 'USD'),
                  category: recordable.categoryName,
                })}
                busy={busy}
                onPress={async () => {
                  if (
                    await act(
                      () => api.recordFromTaxForm(wsId, form.id, recordable.amount),
                      t('tax_forms.recorded'),
                    )
                  )
                    setConfirmRecord(false);
                }}
                testID="tax-form-record-confirm"
              />
              <Button kind="secondary" label={t('common.cancel')} onPress={() => setConfirmRecord(false)} />
            </>
          ) : (
            <Button
              kind="secondary"
              label={t('tax_forms.record')}
              onPress={() => setConfirmRecord(true)}
              testID="tax-form-record-open"
            />
          )}
        </Card>
      ) : null}
      {form.result.recorded ? (
        <Card>
          <Small>
            {t('tax_forms.recorded_on', { amount: fmtMoney(form.result.recorded.amount, 'USD') })}{' '}
            {fmtDate(form.result.recorded.date)}
          </Small>
          {canWrite ? (
            <Button
              kind="secondary"
              label={t('tax_forms.record_undo')}
              busy={busy}
              onPress={() =>
                void act(() => api.undoRecordFromTaxForm(wsId, form.id), t('tax_forms.record_undone'))
              }
            />
          ) : null}
        </Card>
      ) : null}
      <Small>{t('mobile.tax_forms.edit_on_web')}</Small>
    </Screen>
  );
}

/** The boxes as read or typed, to compare with the paper before confirming. */
function Boxes({ form }: { form: TaxFormDto }) {
  const lines = boxLines(form);
  if (lines.length === 0) return null;
  return (
    <Card style={{ paddingVertical: 0, gap: 0 }} testID="tax-form-boxes">
      <View style={{ paddingTop: 12 }}>
        <Body style={{ fontWeight: '600' }}>{t('tax_forms.boxes_section')}</Body>
      </View>
      {lines.map((l, i) => (
        <Row
          key={`${l.box ?? ''}${l.nameKey ?? ''}`}
          title={boxLabel(l, t)}
          right={<Small>{l.amount !== undefined ? fmtMoney(l.amount, 'USD') : fmtDate(l.date ?? '')}</Small>}
          last={i === lines.length - 1}
        />
      ))}
    </Card>
  );
}

interface AcceptState {
  open: boolean;
  note: string;
  busy: boolean;
  onOpen(): void;
  onNote(v: string): void;
  onCancel(): void;
  onSave(): void;
}

/** One check: the form, the books and the difference, its status, how it was worked out, and accepting it. */
function CheckCard({
  check: c,
  onOpen,
  accept,
}: {
  check: Check;
  onOpen: (path: string) => void;
  accept: AcceptState | null;
}) {
  const th = useTheme();
  const [how, setHow] = useState(false);
  const drill = drillDown(c);
  const difference = shownDifference(c);
  const money = (v: string | null) => (v === null ? '—' : fmtMoney(v, 'USD'));
  return (
    <Card testID="tax-form-check">
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: th.space(2) }}>
        <Body style={{ fontWeight: '600' }}>{t('tax_forms.box_short', { box: c.box })}</Body>
        <Small color={toneColor(th, checkTone(c.status))}>{t(`tax_forms.check_status.${c.status}`)}</Small>
      </View>
      <Row title={t('tax_forms.col_form')} right={<Small>{money(c.form)}</Small>} />
      <Row title={t('tax_forms.col_books')} right={<Small>{money(c.books)}</Small>} />
      <Row title={t('tax_forms.col_difference')} right={<Small>{money(difference)}</Small>} last />
      <Disclosure title={t('tax_forms.how')} summary="" open={how} onToggle={() => setHow(!how)}>
        <Small>{c.rule}</Small>
        {c.explanation ? <Small>{c.explanation}</Small> : null}
        {c.acceptedNote ? <Small>{t('tax_forms.accepted_note', { note: c.acceptedNote })}</Small> : null}
        {drill.payslipIds.map((pid, i) => (
          <Row
            key={pid}
            title={t('tax_forms.source_payslip', { n: i + 1 })}
            onPress={() => onOpen(`/payslips/${pid}`)}
          />
        ))}
        {drill.transactionIds.map((tid, i) => (
          <Row
            key={tid}
            title={t('tax_forms.source_transaction', { n: i + 1 })}
            onPress={() => onOpen(`/transaction/${tid}`)}
          />
        ))}
        {drill.entries > 0 ? (
          <Small>
            {t('tax_forms.source_entries', { count: drill.entries })} · {t('mobile.tax_forms.journal_on_web')}
          </Small>
        ) : null}
        {drill.payslipIds.length + drill.transactionIds.length + drill.entries === 0 &&
        c.books !== null &&
        c.kind === 'check' ? (
          <Small>{t('tax_forms.no_drilldown')}</Small>
        ) : null}
      </Disclosure>
      {accept && !accept.open ? (
        <Button
          kind="secondary"
          label={t('tax_forms.accept')}
          onPress={accept.onOpen}
          testID="tax-form-accept-open"
        />
      ) : null}
      {accept?.open ? (
        <>
          <Field label={t('tax_forms.accept_note')} value={accept.note} onChangeText={accept.onNote} />
          <Button
            label={t('tax_forms.accept_save')}
            busy={accept.busy}
            disabled={!accept.note.trim()}
            onPress={accept.onSave}
            testID="tax-form-accept-save"
          />
          <Button kind="secondary" label={t('common.cancel')} onPress={accept.onCancel} />
        </>
      ) : null}
    </Card>
  );
}

'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type { AccountDto, CategoryDto, FamilyMemberDto, JobDto, WorkspaceDto } from '@montra/api-client';
import type { RuleDto, RuleSuggestionDto } from '@montra/schemas';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage } from '@/lib/errors';
import {
  canApplyToExisting,
  describeConditions,
  describeFor,
  emptyDraft,
  ORIGIN_KEYS,
  ruleToDraft,
  sortRules,
} from '@/lib/rules';
import { RuleOffer } from '../review/rule-offer';
import { useI18n } from '../i18n';
import { useConfirm } from '../ui/confirm-dialog';
import { RuleForm } from './rule-form';

const POLL_MS = 1000;

/**
 * Rules (UP-02): the ordered list with enable toggles and hit counts, the editor with live preview, "apply to
 * existing" as a background job, and the rules the app offers after repeated corrections (AI-05).
 */
export function RulesManager({
  workspace,
  initialRules,
  suggestions: initialSuggestions,
  accounts,
  categories,
  members,
}: {
  workspace: WorkspaceDto;
  initialRules: RuleDto[];
  suggestions: RuleSuggestionDto[];
  accounts: AccountDto[];
  categories: CategoryDto[];
  members: FamilyMemberDto[];
}) {
  const router = useRouter();
  const { t } = useI18n();
  const { confirm, dialog } = useConfirm();
  const [rules, setRules] = useState(() => sortRules(initialRules));
  const [suggestions, setSuggestions] = useState(initialSuggestions);
  const [editing, setEditing] = useState<RuleDto | 'new' | null>(null);
  const [message, setMessage] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [jobs, setJobs] = useState<Record<string, JobDto>>({});
  const canEdit = workspace.role !== 'viewer' && workspace.role !== 'member';

  useEffect(() => setRules(sortRules(initialRules)), [initialRules]);
  useEffect(() => setSuggestions(initialSuggestions), [initialSuggestions]);

  const membersById = useMemo(() => new Map(members.map((m) => [m.id, m.name])), [members]);
  const names = useMemo(() => {
    const byField: Record<string, Map<string, string>> = {
      account: new Map(accounts.map((a) => [a.id, a.name])),
      entity: new Map(workspace.entities.map((e) => [e.id, e.name])),
      added_by: membersById,
      category: new Map(categories.map((c) => [c.id, c.name])),
    };
    return (field: string, id: string) => byField[field]?.get(id) ?? id;
  }, [accounts, workspace.entities, membersById, categories]);
  const categoryName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? null;

  // Poll running apply jobs.
  const running = Object.values(jobs).filter((j) => j.status === 'queued' || j.status === 'running');
  useEffect(() => {
    if (running.length === 0) return;
    const timer = setInterval(() => {
      for (const j of running)
        void browserApi.getJob(workspace.id, j.id).then(
          (next) => {
            setJobs((m) => {
              const ruleId = Object.keys(m).find((k) => m[k]!.id === next.id);
              return ruleId ? { ...m, [ruleId]: next } : m;
            });
            if (next.status === 'succeeded') router.refresh();
          },
          () => undefined,
        );
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [running.map((j) => j.id).join(','), workspace.id]); // re-arm when the set of running jobs changes

  async function run(fn: () => Promise<unknown>, success?: string) {
    setMessage(null);
    try {
      await fn();
      if (success) setMessage({ tone: 'good', text: success });
      router.refresh();
    } catch (err) {
      setMessage({ tone: 'bad', text: friendlyMessage(err, t) });
    }
  }

  async function toggle(rule: RuleDto) {
    setRules((rs) => rs.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r)));
    await run(() => browserApi.updateRule(workspace.id, rule.id, { enabled: !rule.enabled }));
  }

  async function apply(rule: RuleDto) {
    setMessage(null);
    try {
      const job = await browserApi.applyRule(workspace.id, rule.id);
      setJobs((m) => ({ ...m, [rule.id]: job }));
    } catch (err) {
      setMessage({ tone: 'bad', text: friendlyMessage(err, t) });
    }
  }

  const jobLine = (job: JobDto) => {
    if (job.status === 'failed') return t('rules.apply.failed', { error: job.error ?? '' });
    if (job.status !== 'succeeded')
      return job.progress != null
        ? t('rules.apply.progress', { percent: job.progress })
        : t('rules.apply.running');
    const r = (job.result ?? {}) as Record<string, unknown>;
    const n = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0);
    return t('rules.apply.done', { changed: n('changed'), skipped: n('skipped') });
  };

  return (
    <div className="space-y-6">
      {suggestions.length > 0 && (
        <section aria-labelledby="suggestions-heading" className="space-y-2">
          <h2 id="suggestions-heading" className="text-lg font-semibold">
            {t('rules.suggestions.title')}
          </h2>
          {suggestions.map((s) => (
            <RuleOffer
              key={s.id}
              workspaceId={workspace.id}
              suggestion={s}
              categoryName={categoryName}
              onDone={(m) => {
                setSuggestions((list) => list.filter((x) => x.id !== s.id));
                if (m) setMessage({ tone: 'good', text: m });
                router.refresh();
              }}
            />
          ))}
        </section>
      )}

      {message && (
        <p
          role={message.tone === 'bad' ? 'alert' : 'status'}
          className={`text-sm ${message.tone === 'good' ? 'text-good' : 'text-bad'}`}
        >
          {message.text}
        </p>
      )}

      {editing ? (
        <RuleForm
          key={editing === 'new' ? 'new' : editing.id}
          workspace={workspace}
          accounts={accounts}
          categories={categories}
          members={members}
          initial={editing === 'new' ? emptyDraft() : ruleToDraft(editing)}
          canChangeScope={editing === 'new'}
          submitLabel={editing === 'new' ? t('rules.create') : t('common.save')}
          onCancel={() => setEditing(null)}
          onSubmit={async ({ value }) => {
            const saved =
              editing === 'new'
                ? await browserApi.createRule(workspace.id, value)
                : await browserApi.updateRule(workspace.id, editing.id, value);
            setRules((rs) => sortRules([...rs.filter((r) => r.id !== saved.id), saved]));
            setEditing(null);
            setMessage({ tone: 'good', text: t('rules.saved', { name: saved.name }) });
            router.refresh();
          }}
        />
      ) : (
        canEdit && (
          <button type="button" className="btn-primary" onClick={() => setEditing('new')}>
            {t('rules.new')}
          </button>
        )
      )}

      <section aria-labelledby="rules-heading" className="space-y-2">
        <h2 id="rules-heading" className="text-lg font-semibold">
          {t('rules.list_title')}
        </h2>
        {rules.length === 0 ? (
          <p className="card text-sm text-muted">{t('rules.empty')}</p>
        ) : (
          <ol className="card divide-y divide-line p-0" aria-label={t('rules.list_title')}>
            {rules.map((r) => {
              const category =
                typeof r.actions.categoryId === 'string' ? categoryName(r.actions.categoryId) : null;
              const forWhom = describeFor(r.actions, t, (id) => membersById.get(id) ?? id);
              const job = jobs[r.id];
              return (
                <li key={r.id} className="flex flex-wrap items-start gap-3 px-4 py-3" data-testid="rule-row">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {r.name}
                      <span className="chip chip-muted ml-2">{t(ORIGIN_KEYS[r.origin])}</span>
                      {r.scope === 'receipt_line' && (
                        <span className="chip chip-muted ml-2">{t('rules.scope.receipt_line')}</span>
                      )}
                      {!r.enabled && <span className="chip chip-warn ml-2">{t('rules.disabled')}</span>}
                    </p>
                    <p className="text-xs text-muted">
                      {describeConditions(r.conditions, t, names)}
                      {category && ` → ${category}`}
                      {forWhom && ` · ${forWhom}`}
                    </p>
                    <p className="text-xs text-muted">
                      {t('rules.priority_hits', { priority: r.priority, hits: r.hitCount })}
                    </p>
                    {job && (
                      <p role="status" className="text-xs" data-testid="rule-apply-status">
                        {jobLine(job)}
                      </p>
                    )}
                  </div>
                  {canEdit && (
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="flex items-center gap-1 text-sm">
                        <input type="checkbox" checked={r.enabled} onChange={() => void toggle(r)} />
                        {t('rules.enabled')}
                      </label>
                      <button type="button" className="btn-secondary" onClick={() => setEditing(r)}>
                        {t('common.edit')}
                      </button>
                      {canApplyToExisting(r) && (
                        <button
                          type="button"
                          className="btn-secondary"
                          disabled={
                            !r.enabled || (job && (job.status === 'queued' || job.status === 'running'))
                          }
                          onClick={() => void apply(r)}
                        >
                          {t('rules.apply.button')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn-secondary text-bad"
                        onClick={async () => {
                          const ok = await confirm({
                            title: t('rules.delete_title'),
                            body: <p>{t('rules.confirm_delete', { name: r.name })}</p>,
                            confirmLabel: t('rules.delete_rule'),
                            danger: true,
                          });
                          if (!ok) return;
                          setRules((rs) => rs.filter((x) => x.id !== r.id));
                          void run(() => browserApi.deleteRule(workspace.id, r.id), t('rules.deleted'));
                        }}
                      >
                        {t('common.delete')}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </section>
      {dialog}
    </div>
  );
}

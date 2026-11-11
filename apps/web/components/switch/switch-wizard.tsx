'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ACCOUNT_KINDS, accountProfile, parseMoney } from '@montra/domain';
import type { MigrationAnalysisDto, MigrationSource, StartMigrationRequest } from '@montra/schemas';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage } from '@/lib/errors';
import {
  newCategoryName,
  sourceLabel,
  SWITCH_ACCEPT,
  SWITCH_SOURCES,
  switchSource,
} from '@/lib/switch-sources';
import { useI18n } from '../i18n';

type AccountTarget = StartMigrationRequest['accounts'][number]['target'];
type CategoryTarget = StartMigrationRequest['categories'][number]['target'];
type Plan = {
  accounts: Record<string, AccountTarget & { balanceText?: string }>;
  categories: Record<string, CategoryTarget>;
};

/** The defaults: matched names go to what you have; the rest are created; transfers stay uncategorized. */
function defaults(a: MigrationAnalysisDto, keep?: Plan): Plan {
  const accounts: Plan['accounts'] = {};
  for (const x of a.accounts)
    accounts[x.key] =
      keep?.accounts[x.key] ??
      (x.matchId
        ? { type: 'existing', accountId: x.matchId }
        : { type: 'new', name: x.key.slice(0, 200), kind: x.suggestedKind, balanceText: '' });
  const categories: Plan['categories'] = {};
  for (const c of a.categories)
    categories[c.name] =
      keep?.categories[c.name] ??
      (c.transfer
        ? { type: 'skip' }
        : c.matchId
          ? { type: 'existing', categoryId: c.matchId }
          : {
              type: 'new',
              name: newCategoryName(c.name, c.group),
              group: (c.group ?? 'Imported').slice(0, 200),
              kind: BigInt(c.moneyIn) > BigInt(c.moneyOut) ? 'income' : 'expense',
            });
  return { accounts, categories };
}

export function SwitchWizard({
  workspaceId,
  base,
  accounts,
  categories,
}: {
  workspaceId: string;
  base: string;
  accounts: Array<{ id: string; name: string }>;
  categories: Array<{ id: string; name: string; group: string | null; type: 'income' | 'expense' }>;
}) {
  const { t, money, date } = useI18n();
  const router = useRouter();
  const [source, setSource] = useState<MigrationSource | null>(null);
  const [files, setFiles] = useState<Array<{ fileId: string; name: string }>>([]);
  const [inverted, setInverted] = useState<string[]>([]);
  const [analysis, setAnalysis] = useState<MigrationAnalysisDto | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<'upload' | 'read' | 'start' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const app = source ? switchSource(source) : undefined;
  const appName = app ? sourceLabel(app, t) : '';

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy('upload');
    setError(null);
    try {
      const added: Array<{ fileId: string; name: string }> = [];
      for (const f of Array.from(list)) {
        const r = await browserApi.uploadFile(workspaceId, f, f.name);
        added.push({ fileId: r.duplicateOf?.fileId ?? r.fileId, name: f.name });
      }
      setFiles((all) => [...all, ...added.filter((a) => !all.some((x) => x.fileId === a.fileId))]);
    } catch (err) {
      setError(friendlyMessage(err, t));
    } finally {
      setBusy(null);
    }
  };

  const read = async (flip = inverted) => {
    if (!source || !files.length) return;
    setBusy('read');
    setError(null);
    try {
      const a = await browserApi.analyzeMigration(workspaceId, {
        source,
        fileIds: files.map((f) => f.fileId),
        inverted: flip,
      });
      setAnalysis(a);
      setPlan((p) => defaults(a, p ?? undefined));
    } catch (err) {
      setError(friendlyMessage(err, t));
    } finally {
      setBusy(null);
    }
  };

  const start = async () => {
    if (!source || !analysis || !plan) return;
    const chosen = Object.entries(plan.accounts).filter(([, v]) => v.type !== 'skip');
    if (!chosen.length) {
      setError(t('switch.nothing_to_import'));
      return;
    }
    setBusy('start');
    setError(null);
    try {
      const m = await browserApi.startMigration(workspaceId, {
        source,
        fileIds: analysis.files.filter((f) => !f.problem).map((f) => f.fileId),
        inverted,
        accounts: Object.entries(plan.accounts).map(([key, v]) => ({
          key,
          target:
            v.type === 'new'
              ? {
                  type: 'new',
                  name: v.name,
                  kind: v.kind,
                  balance: v.balanceText?.trim()
                    ? {
                        amount: parseMoney(
                          v.balanceText.replace(/,/g, '').trim(),
                          analysis.currency,
                        ).amount.toString(),
                        currency: analysis.currency,
                      }
                    : null,
                }
              : v.type === 'existing'
                ? { type: 'existing', accountId: v.accountId }
                : { type: 'skip' },
        })),
        categories: Object.entries(plan.categories).map(([name, target]) => ({ name, target })),
      });
      router.push(`${base}/switch/${m.id}`);
    } catch (err) {
      setError(friendlyMessage(err, t));
      setBusy(null);
    }
  };

  const setAccount = (key: string, v: Plan['accounts'][string]) =>
    setPlan((p) => (p ? { ...p, accounts: { ...p.accounts, [key]: v } } : p));
  const setCategory = (name: string, v: CategoryTarget) =>
    setPlan((p) => (p ? { ...p, categories: { ...p.categories, [name]: v } } : p));

  // 1. Which app.
  if (!source)
    return (
      <section aria-labelledby="pick-heading" className="card space-y-3">
        <h2 id="pick-heading" className="font-semibold">
          {t('switch.pick')}
        </h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" data-testid="switch-sources">
          {SWITCH_SOURCES.map((s) => (
            <button
              key={s.id}
              type="button"
              className="btn-secondary justify-start"
              onClick={() => setSource(s.id)}
            >
              {sourceLabel(s, t)}
            </button>
          ))}
        </div>
      </section>
    );

  return (
    <div className="space-y-6">
      {/* 2. How to export, and the upload. */}
      <section aria-labelledby="how-heading" className="card space-y-3" data-testid="switch-how">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="how-heading" className="font-semibold">
            {t('switch.how', { app: appName })}
          </h2>
          <button
            type="button"
            className="text-sm text-brand-600 underline"
            onClick={() => {
              setSource(null);
              setAnalysis(null);
              setPlan(null);
            }}
          >
            {t('switch.change_app')}
          </button>
        </div>
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          {app!.steps.map((k) => (
            <li key={k}>{t(k)}</li>
          ))}
        </ol>
        {app!.note && <p className="text-sm text-muted">{t(app!.note)}</p>}
        {app!.help && (
          <a href={app!.help} target="_blank" rel="noreferrer" className="text-sm text-brand-600 underline">
            {t('switch.help_link', { app: appName })}
          </a>
        )}
        <div className="space-y-2 border-t border-line pt-3">
          <h3 className="text-sm font-medium">{t('switch.upload')}</h3>
          <p className="text-xs text-muted">{t('switch.upload_hint')}</p>
          <label className="btn-secondary inline-flex cursor-pointer">
            {busy === 'upload' ? t('switch.uploading') : t('switch.choose_files')}
            <input
              type="file"
              multiple
              accept={SWITCH_ACCEPT}
              className="sr-only"
              onChange={(e) => void upload(e.target.files)}
              disabled={busy !== null}
            />
          </label>
          {files.length > 0 && (
            <ul className="text-sm">
              {files.map((f) => (
                <li key={f.fileId}>{f.name}</li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="btn-primary"
            disabled={!files.length || busy !== null}
            onClick={() => void read()}
          >
            {busy === 'read' ? t('switch.reading') : t('switch.read')}
          </button>
        </div>
      </section>

      {error && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}

      {/* 3. The plan. */}
      {analysis && plan && (
        <section aria-labelledby="plan-heading" className="space-y-4" data-testid="switch-plan">
          <div>
            <h2 id="plan-heading" className="text-lg font-semibold">
              {t('switch.plan_title')}
            </h2>
            <p className="text-sm text-muted">{t('switch.plan_hint')}</p>
          </div>

          <div className="card space-y-2">
            <h3 className="font-semibold">{t('switch.files')}</h3>
            <ul className="divide-y divide-line text-sm">
              {analysis.files.map((f) => (
                <li key={f.fileId} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                  <span>
                    {f.fileName}
                    <span className="block text-xs text-muted">
                      {f.problem
                        ? t(`switch.problem_${f.problem}`)
                        : `${f.template ? t('switch.recognized', { name: templateName(f.template) }) : t('switch.by_columns')} · ${t('switch.rows', { count: f.rows })}`}
                    </span>
                  </span>
                  {!f.problem && (
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={inverted.includes(f.fileId)}
                        disabled={busy !== null}
                        onChange={(e) => {
                          const next = e.target.checked
                            ? [...inverted, f.fileId]
                            : inverted.filter((x) => x !== f.fileId);
                          setInverted(next);
                          void read(next);
                        }}
                      />
                      {t('switch.inverted')}
                    </label>
                  )}
                </li>
              ))}
            </ul>
          </div>

          <div className="card space-y-2" data-testid="switch-accounts">
            <h3 className="font-semibold">{t('switch.accounts')}</h3>
            <p className="text-xs text-muted">{t('switch.accounts_hint')}</p>
            <ul className="divide-y divide-line">
              {analysis.accounts.map((a) => {
                const v = plan.accounts[a.key]!;
                return (
                  <li key={a.key} className="space-y-2 py-3 text-sm">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium">{a.key}</span>
                      <span className="text-xs text-muted">
                        {t('switch.rows', { count: a.rows })}
                        {a.from &&
                          a.to &&
                          ` · ${t('switch.account_dates', { from: date(a.from), to: date(a.to) })}`}
                        {' · '}
                        {t('switch.money_in_out', {
                          moneyIn: money(a.moneyIn, analysis.currency),
                          moneyOut: money(a.moneyOut, analysis.currency),
                        })}
                        {a.opening !== null &&
                          ` · ${
                            v.type === 'new' && accountProfile(v.kind).side === 'liability'
                              ? t('switch.opening_owed_from_file', {
                                  amount: money(a.opening.replace(/^-/, ''), analysis.currency),
                                })
                              : t('switch.opening_from_file', { amount: money(a.opening, analysis.currency) })
                          }`}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-end gap-2">
                      <select
                        className="input w-auto"
                        aria-label={a.key}
                        value={v.type}
                        onChange={(e) =>
                          setAccount(
                            a.key,
                            e.target.value === 'new'
                              ? {
                                  type: 'new',
                                  name: a.key.slice(0, 200),
                                  kind: a.suggestedKind,
                                  balanceText: '',
                                }
                              : e.target.value === 'existing'
                                ? { type: 'existing', accountId: a.matchId ?? accounts[0]?.id ?? '' }
                                : { type: 'skip' },
                          )
                        }
                      >
                        <option value="new">{t('switch.target_new')}</option>
                        {accounts.length > 0 && (
                          <option value="existing">{t('switch.target_existing')}</option>
                        )}
                        <option value="skip">{t('switch.target_skip')}</option>
                      </select>
                      {v.type === 'existing' && (
                        <select
                          className="input w-auto"
                          aria-label={t('switch.target_existing')}
                          value={v.accountId}
                          onChange={(e) => setAccount(a.key, { type: 'existing', accountId: e.target.value })}
                        >
                          {accounts.map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.name}
                            </option>
                          ))}
                        </select>
                      )}
                      {v.type === 'new' && (
                        <>
                          <label className="flex flex-col text-xs">
                            {t('switch.account_name')}
                            <input
                              className="input"
                              value={v.name}
                              maxLength={200}
                              onChange={(e) => setAccount(a.key, { ...v, name: e.target.value })}
                            />
                          </label>
                          <label className="flex flex-col text-xs">
                            {t('switch.account_kind')}
                            <select
                              className="input w-auto"
                              value={v.kind}
                              onChange={(e) =>
                                setAccount(a.key, {
                                  ...v,
                                  kind: e.target.value as (typeof ACCOUNT_KINDS)[number],
                                })
                              }
                            >
                              {ACCOUNT_KINDS.map((k) => (
                                <option key={k} value={k}>
                                  {t(`account.kind.${k}`)}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="flex flex-col text-xs" title={t('switch.balance_today_hint')}>
                            {t('switch.balance_today')}
                            <input
                              className="input num w-32"
                              inputMode="decimal"
                              value={v.balanceText ?? ''}
                              onChange={(e) => setAccount(a.key, { ...v, balanceText: e.target.value })}
                            />
                          </label>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="text-xs text-muted">{t('switch.balance_today_hint')}</p>
          </div>

          {analysis.categories.length > 0 && (
            <div className="card space-y-2" data-testid="switch-categories">
              <h3 className="font-semibold">{t('switch.categories')}</h3>
              <p className="text-xs text-muted">{t('switch.categories_hint')}</p>
              <ul className="divide-y divide-line">
                {analysis.categories.map((c) => {
                  const v = plan.categories[c.name]!;
                  return (
                    <li key={c.name} className="flex flex-wrap items-end gap-2 py-2 text-sm">
                      <span className="w-48">
                        <span className="font-medium">{c.name}</span>
                        <span className="block text-xs text-muted">
                          {[c.group, t('switch.rows', { count: c.rows })].filter(Boolean).join(' · ')}
                          {c.transfer && ` · ${t('switch.looks_like_transfer')}`}
                        </span>
                      </span>
                      <select
                        className="input w-auto"
                        aria-label={c.name}
                        value={v.type}
                        onChange={(e) =>
                          setCategory(
                            c.name,
                            e.target.value === 'new'
                              ? {
                                  type: 'new',
                                  name: newCategoryName(c.name, c.group),
                                  group: (c.group ?? 'Imported').slice(0, 200),
                                  kind: BigInt(c.moneyIn) > BigInt(c.moneyOut) ? 'income' : 'expense',
                                }
                              : e.target.value === 'existing'
                                ? { type: 'existing', categoryId: c.matchId ?? categories[0]?.id ?? '' }
                                : { type: 'skip' },
                          )
                        }
                      >
                        <option value="new">{t('switch.target_new_category')}</option>
                        {categories.length > 0 && (
                          <option value="existing">{t('switch.target_existing_category')}</option>
                        )}
                        <option value="skip">{t('switch.target_skip_category')}</option>
                      </select>
                      {v.type === 'existing' && (
                        <select
                          className="input w-auto"
                          aria-label={t('switch.target_existing_category')}
                          value={v.categoryId}
                          onChange={(e) =>
                            setCategory(c.name, { type: 'existing', categoryId: e.target.value })
                          }
                        >
                          {categories.map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.group ? `${x.group}: ${x.name}` : x.name}
                            </option>
                          ))}
                        </select>
                      )}
                      {v.type === 'new' && (
                        <>
                          <label className="flex flex-col text-xs">
                            {t('switch.category_group')}
                            <input
                              className="input"
                              value={v.group}
                              maxLength={200}
                              onChange={(e) => setCategory(c.name, { ...v, group: e.target.value })}
                            />
                          </label>
                          <label className="flex flex-col text-xs">
                            {t('switch.category_kind')}
                            <select
                              className="input w-auto"
                              value={v.kind}
                              onChange={(e) =>
                                setCategory(c.name, { ...v, kind: e.target.value as 'income' | 'expense' })
                              }
                            >
                              <option value="expense">{t('switch.kind_expense')}</option>
                              <option value="income">{t('switch.kind_income')}</option>
                            </select>
                          </label>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <button type="button" className="btn-primary" disabled={busy !== null} onClick={() => void start()}>
            {busy === 'start' ? t('switch.starting') : t('switch.start')}
          </button>
        </section>
      )}
    </div>
  );
}

/** The export a file was recognized as, by the app's name. */
function templateName(id: string): string {
  return switchSource(id)?.name || { quicken: 'Quicken', stessa: 'Stessa', qif: 'QIF', ofx: 'OFX' }[id] || id;
}

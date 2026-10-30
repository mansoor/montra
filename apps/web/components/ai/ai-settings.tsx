'use client';

import { useState, type FormEvent } from 'react';
import type { AiMode, AiSettingsDto, TestAiProviderResponse } from '@montra/schemas';
import type { UpdateAiSettingsInput } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage, toFormErrors, type FormErrors } from '@/lib/errors';
import {
  AI_MODES,
  budgetPercent,
  formatUsd,
  needsEndpoint,
  needsKey,
  parseBudget,
  thresholdFromPercent,
  USAGE_TONE,
} from '@/lib/ai';
import { percent } from '@/lib/review';
import { Field, FormError } from '../field';
import { useI18n } from '../i18n';
import { Disclaimer } from './shared';
import { localRunnerStatus, useLocalRunnerStatus } from './local-ai-runner';

/**
 * AI settings (UP-13, UP-06, AIA-08): where AI runs, with each mode's privacy disclosure next to it; provider
 * key (write-only) or local endpoint; review threshold; monthly budget and usage; document opt-in; failover.
 */
export function AiSettings({
  workspaceId,
  initial,
  isOwner,
}: {
  workspaceId: string;
  initial: AiSettingsDto;
  isOwner: boolean;
}) {
  const { t, locale } = useI18n();
  const [settings, setSettings] = useState(initial);
  const [mode, setMode] = useState<AiMode>(initial.mode);
  const [provider, setProvider] = useState(initial.provider);
  const [endpoint, setEndpoint] = useState(initial.endpoint ?? '');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState({
    small: initial.models.small ?? '',
    vision: initial.models.vision ?? '',
    large: initial.models.large ?? '',
  });
  const [threshold, setThreshold] = useState(percent(initial.threshold));
  const [budget, setBudget] = useState(
    initial.monthlyBudgetUsd === null ? '' : String(initial.monthlyBudgetUsd),
  );
  const [allowDocs, setAllowDocs] = useState(initial.allowDocumentsToLlm);
  const [failover, setFailover] = useState(initial.failover);
  const [errors, setErrors] = useState<FormErrors>({ fields: {} });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [test, setTest] = useState<TestAiProviderResponse | null>(null);
  const [testing, setTesting] = useState(false);
  const runner = useLocalRunnerStatus();
  const disclosure = (m: AiMode) => settings.disclosures.find((d) => d.mode === m);
  const pct = budgetPercent(settings);

  async function save(input: UpdateAiSettingsInput, success = t('ai.saved')) {
    setBusy(true);
    setErrors({ fields: {} });
    setNotice(null);
    try {
      const next = await browserApi.updateAiSettings(workspaceId, input);
      setSettings(next);
      setApiKey('');
      setNotice(success);
    } catch (err) {
      setErrors(toFormErrors(err, {}, t));
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const b = parseBudget(budget);
    if (!b.ok) return setErrors({ fields: { monthlyBudgetUsd: t('ai.budget_invalid') } });
    if (needsEndpoint(mode) && !endpoint.trim())
      return setErrors({ fields: { endpoint: t('ai.endpoint_required') } });
    const input: UpdateAiSettingsInput = {
      mode,
      provider: mode === 'local' ? 'openai_compatible' : provider,
      endpoint: endpoint.trim() || null,
      models: { small: models.small || null, vision: models.vision || null, large: models.large || null },
      threshold: thresholdFromPercent(threshold),
      monthlyBudgetUsd: b.value,
      allowDocumentsToLlm: allowDocs,
      failover,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    };
    await save(input);
  }

  async function onTest() {
    setTesting(true);
    setTest(null);
    try {
      setTest(await browserApi.testAiProvider(workspaceId));
    } catch (err) {
      setTest({
        ok: false,
        provider: provider,
        model: null,
        latencyMs: null,
        error: friendlyMessage(err, t),
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" aria-label={t('ai.title')} noValidate>
      <FormError message={errors.form} action={errors.action} />
      {!isOwner && <p className="text-sm text-muted">{t('ai.owner_only')}</p>}

      <fieldset className="card space-y-3" disabled={!isOwner}>
        <legend className="text-base font-semibold">{t('ai.mode')}</legend>
        <div role="radiogroup" aria-label={t('ai.mode')} className="grid gap-3 md:grid-cols-2">
          {AI_MODES.map((m) => {
            const d = disclosure(m);
            const checked = mode === m;
            return (
              <label
                key={m}
                className={`flex cursor-pointer gap-3 rounded-md border p-3 ${checked ? 'border-brand-600 bg-brand-50' : 'border-line'}`}
                data-testid={`ai-mode-${m}`}
              >
                <input
                  type="radio"
                  name="mode"
                  value={m}
                  checked={checked}
                  onChange={() => setMode(m)}
                  className="mt-1"
                />
                <span className="space-y-1">
                  <span className="block font-medium">{t(`ai.mode.${m}`)}</span>
                  <span className="block text-xs text-muted">{t(`ai.mode_hint.${m}`)}</span>
                  {d && (
                    <span className="block" data-testid={`ai-disclosure-${m}`}>
                      <span className="block text-xs font-medium">{d.title}</span>
                      <ul className="list-disc pl-4 text-xs text-muted">
                        {d.points.map((p) => (
                          <li key={p}>{p}</li>
                        ))}
                      </ul>
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {(needsKey(mode) || needsEndpoint(mode)) && (
        <fieldset className="card grid gap-3 sm:grid-cols-2" disabled={!isOwner}>
          <legend className="text-base font-semibold">{t('ai.provider')}</legend>
          {needsKey(mode) && (
            <>
              <Field id="ai-provider" label={t('ai.provider')}>
                {(p) => (
                  <select
                    {...p}
                    className="input"
                    value={provider}
                    onChange={(e) => setProvider(e.target.value as AiSettingsDto['provider'])}
                  >
                    <option value="anthropic">{t('ai.provider.anthropic')}</option>
                    <option value="openai_compatible">{t('ai.provider.openai_compatible')}</option>
                  </select>
                )}
              </Field>
              <Field
                id="ai-key"
                label={t('ai.api_key')}
                error={errors.fields.apiKey}
                hint={
                  settings.hasKey ? t('ai.key_saved', { last4: settings.keyLast4 ?? '' }) : t('ai.key_hint')
                }
              >
                {(p) => (
                  <input
                    {...p}
                    type="password"
                    autoComplete="off"
                    className="input"
                    value={apiKey}
                    placeholder={settings.hasKey ? `••••${settings.keyLast4 ?? ''}` : ''}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                )}
              </Field>
              {settings.hasKey && (
                <div className="sm:col-span-2">
                  <button
                    type="button"
                    className="btn-secondary text-bad"
                    disabled={busy}
                    onClick={() => void save({ clearKey: true }, t('ai.key_removed'))}
                  >
                    {t('ai.remove_key')}
                  </button>
                </div>
              )}
            </>
          )}
          {(needsEndpoint(mode) || provider === 'openai_compatible') && (
            <Field
              id="ai-endpoint"
              label={t('ai.endpoint')}
              error={errors.fields.endpoint}
              hint={t('ai.endpoint_hint')}
              className="sm:col-span-2"
            >
              {(p) => (
                <input
                  {...p}
                  type="url"
                  className="input"
                  placeholder="http://localhost:11434/v1"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                />
              )}
            </Field>
          )}
          {needsEndpoint(mode) && (
            <p className="text-xs text-muted sm:col-span-2" data-testid="local-runner-status">
              {t(`ai.runner.${localRunnerStatus(runner)}`)}
            </p>
          )}
        </fieldset>
      )}

      {mode !== 'off' && (
        <details className="card">
          <summary className="cursor-pointer text-sm font-medium">{t('ai.advanced')}</summary>
          <fieldset className="mt-3 grid gap-3 sm:grid-cols-3" disabled={!isOwner}>
            {(['small', 'vision', 'large'] as const).map((g) => (
              <Field key={g} id={`ai-model-${g}`} label={t(`ai.model.${g}`)} hint={t('ai.model_hint')}>
                {(p) => (
                  <input
                    {...p}
                    className="input"
                    maxLength={100}
                    value={models[g]}
                    onChange={(e) => setModels({ ...models, [g]: e.target.value })}
                  />
                )}
              </Field>
            ))}
          </fieldset>
        </details>
      )}

      <fieldset className="card grid gap-4 sm:grid-cols-2" disabled={!isOwner}>
        <legend className="text-base font-semibold">{t('ai.review_and_budget')}</legend>
        <div>
          <label htmlFor="ai-threshold" className="field-label">
            {t('ai.threshold', { percent: threshold })}
          </label>
          <input
            id="ai-threshold"
            type="range"
            min={50}
            max={99}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="w-full"
          />
          <p className="mt-1 text-xs text-muted">{t('ai.threshold_hint')}</p>
        </div>
        <Field
          id="ai-budget"
          label={t('ai.budget')}
          error={errors.fields.monthlyBudgetUsd}
          hint={t('ai.budget_hint')}
        >
          {(p) => (
            <input
              {...p}
              className="input num"
              inputMode="decimal"
              placeholder={t('ai.no_budget')}
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
            />
          )}
        </Field>
        <div className="sm:col-span-2 space-y-1" data-testid="ai-usage">
          <p className="text-sm">
            {t('ai.usage', {
              spent: formatUsd(settings.usage.spentUsd, locale),
              calls: settings.usage.calls,
              month: settings.usage.month,
            })}
          </p>
          {pct !== null && (
            <meter
              min={0}
              max={100}
              low={80}
              high={99}
              optimum={0}
              value={pct}
              className="w-full"
              aria-label={t('ai.budget_used', { percent: pct })}
            />
          )}
          {settings.usage.state !== 'ok' && (
            <p
              role="status"
              className={`rounded-md border px-3 py-2 text-sm chip-${USAGE_TONE[settings.usage.state]}`}
            >
              {t(`ai.usage_state.${settings.usage.state}`)}
            </p>
          )}
        </div>
        <label className="flex items-start gap-2 text-sm sm:col-span-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={allowDocs}
            onChange={(e) => setAllowDocs(e.target.checked)}
          />
          <span>
            {t('ai.allow_documents')}
            <span className="block text-xs text-muted">{t('ai.allow_documents_hint')}</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm sm:col-span-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={failover}
            onChange={(e) => setFailover(e.target.checked)}
          />
          <span>
            {t('ai.failover')}
            <span className="block text-xs text-muted">{t('ai.failover_hint')}</span>
          </span>
        </label>
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        {isOwner && (
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? t('common.saving') : t('common.save')}
          </button>
        )}
        <button
          type="button"
          className="btn-secondary"
          disabled={testing || settings.mode === 'off'}
          onClick={onTest}
        >
          {testing ? t('ai.testing') : t('ai.test')}
        </button>
        <span role="status" className="text-sm text-good">
          {notice}
        </span>
      </div>
      {test && (
        <p
          role="status"
          className={`text-sm ${test.ok ? 'text-good' : 'text-bad'}`}
          data-testid="ai-test-result"
        >
          {test.ok
            ? t('ai.test_ok', { model: test.model ?? test.provider, ms: test.latencyMs ?? 0 })
            : t('ai.test_failed', { error: test.error ?? '' })}
        </p>
      )}
      <Disclaimer kind="financial" />
    </form>
  );
}

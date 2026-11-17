'use client';

import Link from 'next/link';
import type { TaxFormDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { canConfirmReading, readingStage } from '@/lib/tax-forms';
import { useI18n } from '../i18n';
import { StatusLine, useAction } from '../use-action';
import { VaultBadges } from '../vault-badges';
import { useRefreshWhile } from './tax-form-drop-zone';

/**
 * How a form from a file was read (ADR-0052 §6, §7.1): its file to open beside the boxes, where the reading stands
 * (being read, couldn't be read, read and waiting to be confirmed, confirmed by a person or by the books), why it was
 * matched or the candidates to pick, a probable copy, and Confirm reading. Nothing here for a form typed in.
 */
export function TaxFormReadingPanel({
  workspaceId,
  form,
  canWrite,
  canMatchEmployer,
}: {
  workspaceId: string;
  form: TaxFormDto;
  canWrite: boolean;
  canMatchEmployer: boolean;
}) {
  const { t } = useI18n();
  const { busy, message, run } = useAction();
  const stage = readingStage(form);
  useRefreshWhile(stage === 'reading' || stage === 'waiting');
  const r = form.reading;
  if (!r || !stage) return null;
  const base = `/api/v1/workspaces/${workspaceId}/tax-forms/${form.id}/files`;
  const matched = form.targets.length > 0;
  const pickable = r.match.candidates.filter((c) => (c.employerId ? canMatchEmployer : true));

  return (
    <section className="card space-y-3" aria-labelledby="tax-reading" data-testid="tax-reading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="tax-reading" className="text-base font-semibold">
          {t('tax_forms.reading_title')}
        </h2>
        <ul className="flex flex-wrap gap-2 text-sm">
          {form.fileIds.map((id, i) => (
            <li key={id}>
              <a href={`${base}/${id}`} target="_blank" rel="noopener" className="underline">
                {t('tax_forms.open_file', { name: r.fileNames[i] ?? t('tax_forms.the_file') })}
              </a>
            </li>
          ))}
        </ul>
      </div>
      <VaultBadges workspaceId={workspaceId} fileIds={form.fileIds} />
      <p className="text-sm" data-testid="tax-reading-stage">
        {t(`tax_forms.reading_stage.${stage}`)}
        {stage === 'unread' && r.problem ? ` ${t(`tax_forms.reading_problem.${r.problem}`)}` : ''}
      </p>
      {r.droppedBoxes > 0 && (
        <p className="text-sm text-muted">{t('tax_forms.reading_dropped', { count: r.droppedBoxes })}</p>
      )}
      {r.copyOfId && (
        <p className="text-sm">
          {t('tax_forms.reading_copy')}{' '}
          <Link href={`/w/${workspaceId}/tax-forms/${r.copyOfId}`} className="underline">
            {t('tax_forms.reading_copy_open')}
          </Link>
        </p>
      )}
      {matched && r.match.automatic && r.match.reason && (
        <p className="text-sm text-muted" data-testid="tax-match-reason">
          {r.match.reason}
        </p>
      )}
      {!matched && canWrite && pickable.length > 0 && form.status !== 'reading' && (
        <div className="space-y-2" role="group" aria-label={t('tax_forms.suggested')}>
          <p className="field-label">{t('tax_forms.suggested')}</p>
          <ul className="space-y-2">
            {pickable.map((c) => (
              <li key={c.employerId ?? c.accountId} className="flex flex-wrap items-center gap-2 text-sm">
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () =>
                        browserApi.updateTaxForm(workspaceId, form.id, {
                          targets: [
                            c.employerId ? { employerId: c.employerId } : { accountId: c.accountId! },
                          ],
                          version: form.version,
                        }),
                      t('tax_forms.matched'),
                    )
                  }
                >
                  {t('tax_forms.match_to', { name: c.name })}
                </button>
                <span className="text-muted">{c.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {canWrite && canConfirmReading(form) && (
        <div className="space-y-1">
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() =>
              run(
                () => browserApi.confirmTaxFormReading(workspaceId, form.id, form.version),
                t('tax_forms.reading_confirmed'),
              )
            }
          >
            {t('tax_forms.confirm_reading')}
          </button>
          <p className="text-xs text-muted">{t('tax_forms.confirm_reading_hint')}</p>
        </div>
      )}
      <StatusLine message={message} />
    </section>
  );
}

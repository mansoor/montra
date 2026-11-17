'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { TaxFormDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { useI18n } from '../i18n';
import { formTitle, TaxFormResult } from '../tax-forms/tax-year-view';

/**
 * Review's "Tax forms to check" (ADR-0052 §7.1), below the statements and bills to file: forms that differ from the
 * books (and aren't accepted), wait for a match or a person, or couldn't be read, each with why and an Open action.
 */
export function TaxFormQueue({ workspaceId }: { workspaceId: string }) {
  const { t } = useI18n();
  const [forms, setForms] = useState<TaxFormDto[]>([]);

  useEffect(() => {
    let alive = true;
    browserApi.listTaxFormsToCheck(workspaceId).then(
      (r) => alive && setForms(r.data),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  if (forms.length === 0) return null;
  return (
    <section className="space-y-3" aria-labelledby="tax-forms-heading" data-testid="tax-form-queue">
      <div>
        <h2 id="tax-forms-heading" className="text-base font-semibold">
          {t('tax_forms.review_title')}
        </h2>
        <p className="text-sm text-muted">{t('tax_forms.review_intro')}</p>
      </div>
      <ul className="card-flush divide-y divide-line">
        {forms.map((f) => (
          <li
            key={f.id}
            className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
            data-testid="tax-form-item"
          >
            <div className="min-w-0">
              <p className="font-medium">
                {formTitle(t, f)} · {f.taxYear}
              </p>
              <p className="text-xs text-muted">{t(`tax_forms.review_why.${f.result.state}`)}</p>
            </div>
            <div className="flex items-center gap-2">
              <TaxFormResult form={f} />
              <Link
                href={`/w/${workspaceId}/tax-forms/${f.id}`}
                className="btn-secondary"
                aria-label={t('tax_forms.open_named', { name: formTitle(t, f) })}
              >
                {t('tax_forms.open')}
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

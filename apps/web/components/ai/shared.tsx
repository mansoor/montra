'use client';

import type { CategorizationDto, MerchantDto } from '@montra/schemas';
import { confidenceTone, percent } from '@/lib/review';
import { useI18n } from '../i18n';

/** Tax and financial outputs are informational only (AIA-12, NFR-14). */
export function Disclaimer({ kind }: { kind: 'tax' | 'financial' }) {
  const { t } = useI18n();
  return (
    <p className="text-xs text-muted" data-testid={`disclaimer-${kind}`}>
      {t(kind === 'tax' ? 'disclaimer.tax' : 'disclaimer.financial')}
    </p>
  );
}

/** Calibrated confidence as a colored chip ("87%"), green at or above the review threshold. */
export function ConfidenceChip({ confidence, threshold }: { confidence: number; threshold: number }) {
  const { t } = useI18n();
  const p = percent(confidence);
  return (
    <span
      className={`chip chip-${confidenceTone(confidence, threshold)}`}
      title={t('review.confidence_title', { percent: p })}
      data-testid="confidence"
    >
      <span className="sr-only">{t('review.confidence')} </span>
      {p}%
    </span>
  );
}

/** One-line reason for a category (AI-06), e.g. "Matched rule 'Shell → Fuel'". */
export function Explanation({ categorization }: { categorization: CategorizationDto | null }) {
  const { t } = useI18n();
  if (!categorization || !categorization.explanation) return null;
  return (
    <span className="block truncate text-xs text-muted" title={categorization.explanation}>
      <span className="sr-only">{t('review.why')} </span>
      {categorization.explanation}
    </span>
  );
}

/** Merchant name with a monogram, or its logo when the reference data has one (AI-07). No third-party fetches. */
export function MerchantMark({
  merchant,
  fallback,
}: {
  merchant: MerchantDto | null;
  fallback?: string | null;
}) {
  const name = merchant?.name ?? fallback ?? '';
  if (!name) return null;
  if (merchant?.logoUrl)
    // A reference-data logo URL, not user content.
    return <img src={merchant.logoUrl} alt="" className="h-6 w-6 shrink-0 rounded" />;
  const letter = name.trim().charAt(0).toUpperCase();
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded bg-brand-100 text-xs font-semibold text-brand-700"
    >
      {letter}
    </span>
  );
}

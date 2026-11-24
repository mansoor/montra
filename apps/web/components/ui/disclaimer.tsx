'use client';

import type { DisclaimerKind } from '@montra/schemas';
import { useI18n } from '../i18n';

/**
 * Tax and financial outputs are informational, not professional advice (AIA-12, NFR-14). One small line per screen
 * that shows such an output, at the end of it.
 */
export function Disclaimer({ kind }: { kind: DisclaimerKind }) {
  const { t } = useI18n();
  return (
    <p className="text-xs text-muted" data-testid={`disclaimer-${kind}`}>
      {t(kind === 'tax' ? 'disclaimer.tax' : 'disclaimer.financial')}
    </p>
  );
}

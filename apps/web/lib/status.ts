/** The status signals (OPS-03) shown inside the app. */
import type { StatusDto } from '@montra/api-client';

/**
 * Background workers that aren't picking up work: `documents` (the doc-worker, which reads scans and, unless
 * receipt images may go to the AI, receipts) and `jobs` (imports and AI reading). Message keys are
 * `status.worker.<worker>`.
 */
export function delayedWorkers(status: Pick<StatusDto, 'workers'>): (keyof StatusDto['workers'])[] {
  return (['documents', 'jobs'] as const).filter((w) => status.workers[w] === 'delayed');
}

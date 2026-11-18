import type { PlanEntitlementsDto } from '@montra/api-client';
import { customerFeatures } from '@montra/domain';

/**
 * The i18n keys for the features a plan includes, as the billing page lists them. Features not ready for customers yet
 * (`FEATURES_NOT_YET_SHOWN` in @montra/domain) stay out, though the plan has them.
 */
export function includedFeatureKeys(e: Pick<PlanEntitlementsDto, 'features'>): string[] {
  return customerFeatures(e.features).map((f) => `billing.feature.${f}`);
}

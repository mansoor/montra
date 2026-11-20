import { describe, expect, it } from 'vitest';
import { includedFeatureKeys } from './billing';

// What the billing page says a plan includes (ADR-0049 §1).
describe('includedFeatureKeys', () => {
  it('lists a plan’s features, the Family Document Vault included now that it sends documents (ADR-0054 PR 3)', () => {
    expect(
      includedFeatureKeys({
        features: ['payroll', 'staffTime', 'scans', 'voice', 'ownStorage', 'familyVault'],
      }),
    ).toEqual([
      'billing.feature.payroll',
      'billing.feature.staffTime',
      'billing.feature.scans',
      'billing.feature.voice',
      'billing.feature.ownStorage',
      'billing.feature.familyVault',
    ]);
    expect(includedFeatureKeys({ features: ['familyVault'] })).toEqual(['billing.feature.familyVault']);
  });

  it('leaves bank feeds out until they sync (ADR-0055 §11)', () => {
    expect(includedFeatureKeys({ features: ['ownStorage', 'bankFeeds'] })).toEqual([
      'billing.feature.ownStorage',
    ]);
  });
});

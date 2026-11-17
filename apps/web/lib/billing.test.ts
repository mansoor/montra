import { describe, expect, it } from 'vitest';
import { includedFeatureKeys } from './billing';

// What the billing page says a plan includes (ADR-0049 §1).
describe('includedFeatureKeys', () => {
  it('lists a plan’s features, but not the Family Document Vault until it can be connected (ADR-0054)', () => {
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
    ]);
    expect(includedFeatureKeys({ features: ['familyVault'] })).toEqual([]);
  });
});

import { DEFAULT_POLICY, normalizePolicy, personalWords, type PasswordPolicy } from '@montra/password';
import 'server-only';
import { ApiClient } from '@montra/api-client';
import type { NewPassword } from '@/components/kratos/flow-form';
import { staticT as t } from './i18n-static';
import { API_URL } from './session';

/** The service's password policy (ADR-0043), or the default when the API can't be reached; the gateway still checks. */
export async function passwordPolicy(): Promise<PasswordPolicy> {
  try {
    // Public: sign-up shows it before anyone is signed in.
    return normalizePolicy(await new ApiClient({ baseUrl: API_URL }).passwordPolicy());
  } catch {
    return DEFAULT_POLICY;
  }
}

/** What a new-password field needs: the policy, the person's own words, and the meter's wording. */
export async function newPasswordProps(
  person: { email?: string | null; name?: string | null } = {},
): Promise<NewPassword> {
  const policy = await passwordPolicy();
  const levels = [0, 1, 2, 3, 4].map((n) => t(`auth.password_strength_${n}`));
  return {
    policy,
    words: personalWords(person),
    labels: {
      strength: t('auth.password_strength'),
      levels,
      needs: t('auth.password_needs', { min: policy.minLength, level: levels[policy.minScore]! }),
      tooShort: t('auth.password_too_short', { min: policy.minLength }),
      tooWeak: t('auth.password_too_weak'),
    },
  };
}

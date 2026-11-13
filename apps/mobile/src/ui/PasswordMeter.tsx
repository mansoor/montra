import { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import {
  checkPassword,
  DEFAULT_POLICY,
  normalizePolicy,
  personalWords,
  type PasswordCheck,
  type PasswordPolicy,
} from '@montra/password';
import type { Api } from '../api/client';
import { t } from '../i18n';
import { useTheme } from './theme';

/** The service's password policy (ADR-0043), or the default while it loads or when offline; the gateway checks anyway. */
export function usePasswordPolicy(api: Api): PasswordPolicy {
  const [policy, setPolicy] = useState<PasswordPolicy>(DEFAULT_POLICY);
  useEffect(() => {
    let alive = true;
    api
      .passwordPolicy()
      .then((p) => alive && setPolicy(normalizePolicy(p)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api]);
  return policy;
}

/** Scores a new password as it's typed, against the policy and the person's own email and name. */
export function usePasswordCheck(
  password: string,
  policy: PasswordPolicy,
  person: { email?: string | null; name?: string | null },
): PasswordCheck | null {
  const words = useMemo(() => personalWords(person), [person]);
  const [check, setCheck] = useState<PasswordCheck | null>(null);
  useEffect(() => {
    if (!password) {
      setCheck(null);
      return;
    }
    const timer = setTimeout(() => setCheck(checkPassword(password, policy, words)), 150);
    return () => clearTimeout(timer);
  }, [password, policy, words]);
  return check;
}

/** Four bars, the level, why it's weak, and what's needed (AUTH-02). */
export function PasswordMeter({ check, policy }: { check: PasswordCheck | null; policy: PasswordPolicy }) {
  const th = useTheme();
  const score = check?.strength.score ?? 0;
  const colour = score >= 3 ? th.success : score === 2 ? th.warning : th.danger;
  const levels = [0, 1, 2, 3, 4].map((n) => t(`auth.password_strength_${n}`));
  return (
    <View style={{ gap: th.space(1) }} testID="password-meter" accessibilityLiveRegion="polite">
      <View
        style={{ flexDirection: 'row', gap: 4 }}
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        {[0, 1, 2, 3].map((i) => (
          <View
            key={i}
            style={{
              flex: 1,
              height: 6,
              borderRadius: 3,
              backgroundColor: check && score > i ? colour : th.border,
            }}
          />
        ))}
      </View>
      {check ? (
        <Text style={{ fontSize: th.font.small, color: th.muted }}>
          {t('auth.password_strength')}:{' '}
          <Text style={{ color: check.ok ? th.success : th.danger }}>{levels[score]}</Text>
          {check.strength.warning ? ` · ${check.strength.warning}` : ''}
        </Text>
      ) : null}
      <Text style={{ fontSize: th.font.small, color: th.muted }}>
        {t('auth.password_needs', { min: policy.minLength, level: levels[policy.minScore]! })}
      </Text>
    </View>
  );
}

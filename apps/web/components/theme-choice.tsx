'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';
import { apply, readChoice, storeChoice, type ThemeChoice } from '@/lib/theme';
import { useI18n } from './i18n';

function subscribe(cb: () => void) {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const onSystem = () => {
    if (readChoice() === 'system') apply('system');
    cb();
  };
  media.addEventListener('change', onSystem);
  window.addEventListener('storage', onSystem);
  window.addEventListener('montra-theme', cb);
  return () => {
    media.removeEventListener('change', onSystem);
    window.removeEventListener('storage', onSystem);
    window.removeEventListener('montra-theme', cb);
  };
}

export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribe, readChoice, () => 'system');
}

/** Keeps a "system" theme in step with the OS while any page is open. */
export function ThemeFollower() {
  useThemeChoice();
  useEffect(() => apply(readChoice()), []);
  return null;
}

const OPTIONS: { value: ThemeChoice; icon: typeof Sun; key: string }[] = [
  { value: 'light', icon: Sun, key: 'theme.light' },
  { value: 'dark', icon: Moon, key: 'theme.dark' },
  { value: 'system', icon: Monitor, key: 'theme.system' },
];

/** Light / Dark / System as a segmented control. `compact` shows icons only (labels stay for screen readers). */
export function ThemeChoiceControl({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const choice = useThemeChoice();
  return (
    <div className="segmented" role="group" aria-label={t('theme.label')}>
      {OPTIONS.map(({ value, icon: Icon, key }) => (
        <button
          key={value}
          type="button"
          aria-pressed={choice === value}
          onClick={() => storeChoice(value)}
          title={t(key)}
        >
          <Icon aria-hidden size={14} strokeWidth={1.8} />
          <span className={compact ? 'sr-only' : undefined}>{t(key)}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Light / dark / system theme. The choice lives in this browser only (localStorage); <html> always carries a
 * concrete data-theme so CSS never has to guess. THEME_INIT runs inline in <head> before first paint.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

export const THEME_KEY = 'montra.theme';

/** Inline script for <head>: applies the stored or system theme before the page paints (no flash). */
export const THEME_INIT = `(function(){try{var c=localStorage.getItem('${THEME_KEY}');var t=c==='light'||c==='dark'?c:(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');var r=document.documentElement;r.setAttribute('data-theme',t);r.style.colorScheme=t;}catch(e){}})();`;

export function readChoice(): ThemeChoice {
  try {
    const c = localStorage.getItem(THEME_KEY);
    return c === 'light' || c === 'dark' ? c : 'system';
  } catch {
    return 'system';
  }
}

export function resolve(choice: ThemeChoice): Theme {
  if (choice !== 'system') return choice;
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

export function apply(choice: ThemeChoice): void {
  const theme = resolve(choice);
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme;
}

export function storeChoice(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Private mode or blocked storage: the choice applies to this page only.
  }
  apply(choice);
  window.dispatchEvent(new Event('montra-theme'));
}

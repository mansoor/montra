/** Design tokens (08 §1): the web app's palette (app/globals.css), light and dark, AA contrast on surfaces. */
import { useColorScheme } from 'react-native';

export interface Theme {
  dark: boolean;
  bg: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  primary: string;
  onPrimary: string;
  danger: string;
  success: string;
  warning: string;
  space: (n: number) => number;
  /** The smallest tappable height: compact, but no smaller than a finger needs (44 pt, Apple's minimum). */
  tap: number;
  /** Edge padding of a screen. */
  pad: number;
  radius: number;
  font: { body: number; small: number; title: number; amount: number };
}

const base = {
  space: (n: number) => n * 4,
  tap: 44,
  pad: 12,
  radius: 10,
  font: { body: 15, small: 13, title: 20, amount: 34 },
};

export const light: Theme = {
  ...base,
  dark: false,
  bg: '#faf8f4',
  surface: '#ffffff',
  border: '#e6e0d6',
  text: '#1c1a17',
  muted: '#5e574e',
  primary: '#1f5d4c',
  onPrimary: '#ffffff',
  danger: '#962d2d',
  success: '#1f6a3f',
  warning: '#8a4b08',
};

export const dark: Theme = {
  ...base,
  dark: true,
  bg: '#1e2633',
  surface: '#263142',
  border: '#3a4759',
  text: '#e8edf4',
  muted: '#a3afc0',
  primary: '#6db89e',
  onPrimary: '#0f2620',
  danger: '#f2a0a0',
  success: '#7ccf9b',
  warning: '#f0b46b',
};

export const useTheme = (): Theme => (useColorScheme() === 'dark' ? dark : light);

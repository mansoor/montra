/** Design tokens (08 §1): light and dark palettes with AA contrast for text on surfaces. */
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
  radius: number;
  font: { body: number; small: number; title: number; amount: number };
}

const base = {
  space: (n: number) => n * 4,
  radius: 12,
  font: { body: 16, small: 13, title: 22, amount: 40 },
};

export const light: Theme = {
  ...base,
  dark: false,
  bg: '#f6f7f9',
  surface: '#ffffff',
  border: '#d7dbe0',
  text: '#14171a',
  muted: '#5b6570',
  primary: '#1f5fbf',
  onPrimary: '#ffffff',
  danger: '#b3261e',
  success: '#1e7a3c',
  warning: '#8a5a00',
};

export const dark: Theme = {
  ...base,
  dark: true,
  bg: '#0f1214',
  surface: '#1a1f23',
  border: '#2e353b',
  text: '#eef1f4',
  muted: '#a7b0b9',
  primary: '#7fb0ff',
  onPrimary: '#0b1a33',
  danger: '#ffb4ab',
  success: '#7ddc95',
  warning: '#f3c35b',
};

export const useTheme = (): Theme => (useColorScheme() === 'dark' ? dark : light);

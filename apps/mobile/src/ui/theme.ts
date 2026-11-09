/** Design tokens (08 §1): the web app's palette (app/globals.css), light and dark, AA contrast on surfaces. */
import { Platform, useColorScheme, type ViewStyle } from 'react-native';
import { darkPalette, lightPalette, type Palette } from './palette';

export interface Theme extends Palette {
  dark: boolean;
  /** Dims the screen behind a panel. */
  scrim: string;
  space: (n: number) => number;
  /** The smallest tappable height: compact, but no smaller than a finger needs (44 pt, Apple's minimum). */
  tap: number;
  /** Edge padding of a screen. */
  pad: number;
  /** Controls: buttons, fields, chips. */
  radius: number;
  /** Cards and panels. */
  radiusLg: number;
  font: { body: number; small: number; title: number; amount: number; display: number };
  /** Soft depth for cards in light mode; dark mode separates with a hairline instead, as shadows don't show. */
  raised: ViewStyle;
}

const base = {
  space: (n: number) => n * 4,
  tap: 44,
  pad: 12,
  radius: 12,
  radiusLg: 16,
  font: { body: 15, small: 13, title: 20, amount: 34, display: 28 },
};

const shadow: ViewStyle = Platform.select({
  android: { elevation: 2 },
  default: {
    shadowColor: '#000',
    shadowOpacity: 0.07,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
  },
});

export const light: Theme = {
  ...base,
  ...lightPalette,
  dark: false,
  scrim: 'rgba(28, 26, 23, 0.45)',
  raised: shadow,
};

export const dark: Theme = {
  ...base,
  ...darkPalette,
  dark: true,
  scrim: 'rgba(0, 0, 0, 0.55)',
  raised: { borderWidth: 1, borderColor: '#33405280' },
};

export const useTheme = (): Theme => (useColorScheme() === 'dark' ? dark : light);

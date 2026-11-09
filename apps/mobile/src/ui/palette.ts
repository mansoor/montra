/**
 * The colours, light and dark (08 §1): the web app's palette (app/globals.css) plus tinted fills. Kept free of React
 * Native so a test can check every text-on-fill pair for AA contrast.
 */
export interface Palette {
  bg: string;
  surface: string;
  /** A quieter fill inside a surface: inputs, chips, secondary buttons. */
  surfaceAlt: string;
  border: string;
  text: string;
  muted: string;
  primary: string;
  onPrimary: string;
  /** Tinted fills behind icons and info banners; body text stays AA on them. */
  primarySoft: string;
  danger: string;
  dangerSoft: string;
  success: string;
  warning: string;
  warningSoft: string;
}

export const lightPalette: Palette = {
  bg: '#f6f3ee',
  surface: '#ffffff',
  surfaceAlt: '#f0ece5',
  border: '#e6e0d6',
  text: '#1c1a17',
  muted: '#5e574e',
  primary: '#1f5d4c',
  onPrimary: '#ffffff',
  primarySoft: '#e2eee9',
  danger: '#962d2d',
  dangerSoft: '#f7e4e2',
  success: '#1f6a3f',
  warning: '#8a4b08',
  warningSoft: '#f8ecda',
};

export const darkPalette: Palette = {
  bg: '#1a212c',
  surface: '#243041',
  surfaceAlt: '#2c394c',
  border: '#3a4759',
  text: '#e8edf4',
  muted: '#a3afc0',
  primary: '#6db89e',
  onPrimary: '#0f2620',
  primarySoft: '#21423a',
  danger: '#f2a0a0',
  dangerSoft: '#4a2b30',
  success: '#7ccf9b',
  warning: '#f0b46b',
  warningSoft: '#47392a',
};

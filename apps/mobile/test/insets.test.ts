import { describe, expect, it } from 'vitest';
import { screenInsets } from '../src/ui/insets';

describe('keeping screens clear of the system bars', () => {
  const device = { top: 32, bottom: 48 };

  it('ends a pushed screen above the navigation bar, with no extra space under its title bar', () => {
    expect(screenInsets(['transaction', '[id]'], device)).toEqual({ top: 0, bottom: 48 });
    expect(screenInsets(['receipts', '[id]'], device)).toEqual({ top: 0, bottom: 48 });
  });

  it('leaves a tab to its tab bar, which sits above the navigation bar already', () => {
    expect(screenInsets(['(tabs)', 'transactions'], device)).toEqual({ top: 32, bottom: 0 });
  });

  it('keeps sign-in, which has no title bar, below the status bar', () => {
    expect(screenInsets(['sign-in'], device)).toEqual({ top: 32, bottom: 48 });
    expect(screenInsets([], device)).toEqual({ top: 32, bottom: 48 });
  });
});

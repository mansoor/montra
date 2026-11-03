import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Colours live only in the token blocks of app/globals.css, so both themes stay consistent: components use the
// token-backed Tailwind names (bg-surface, text-muted, …) or var(--token).
const ROOT = join(import.meta.dirname, '..');
const COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch)\(/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) return [];
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

describe('colour guard', () => {
  it('keeps colour literals out of components', () => {
    const offenders = ['app', 'components', 'lib']
      .flatMap((d) => files(join(ROOT, d)))
      .flatMap((f) =>
        readFileSync(f, 'utf8')
          .split('\n')
          .map((line, i) => ({ line, at: `${relative(ROOT, f)}:${i + 1}` }))
          .filter(({ line }) => COLOUR.test(line) && !/https?:\/\//.test(line))
          .map(({ at, line }) => `${at}  ${line.trim()}`),
      );
    expect(offenders).toEqual([]);
  });

  it('defines every token in both themes', () => {
    const css = readFileSync(join(ROOT, 'app/globals.css'), 'utf8');
    const block = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      return css.slice(start, css.indexOf('}', start));
    };
    const names = (b: string) => [...b.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]).sort();
    const light = names(block(':root'));
    const dark = names(block(":root[data-theme='dark']"));
    expect(dark).toEqual(light);
    // No colour literal outside the two token blocks.
    const rest = css.replace(block(':root'), '').replace(block(":root[data-theme='dark']"), '');
    expect(rest.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
  });
});

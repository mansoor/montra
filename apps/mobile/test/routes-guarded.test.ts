/**
 * Every screen but sign-in needs a signed-in session and its sync engine. The root layout guards them with
 * `Stack.Protected`; a route left out of that block would be reachable signed out, and the first screen of a fresh
 * install threw "useSync outside SyncProvider" before the guard existed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const appDir = join(__dirname, '..', 'app');

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name.startsWith('(') ? [name] : routes(path);
    if (!name.endsWith('.tsx') || name === '_layout.tsx') return [];
    return [
      relative(appDir, path)
        .replace(/\\/g, '/')
        .replace(/\.tsx$/, ''),
    ];
  });
}

const layout = readFileSync(join(appDir, '_layout.tsx'), 'utf8');
const blocks = [
  ...layout.matchAll(/<Stack\.Protected guard=\{(!?signedIn)\}>([\s\S]*?)<\/Stack\.Protected>/g),
];
const declared = (guard: string) =>
  [...(blocks.find((b) => b[1] === guard)?.[2] ?? '').matchAll(/<Stack\.Screen name="([^"]+)"/g)].map(
    (m) => m[1],
  );

describe('root layout guards (AUTH-01)', () => {
  it('shows only sign-in to someone signed out', () => {
    expect(declared('!signedIn')).toEqual(['sign-in', 'sign-up', 'forgot-password']);
  });

  it('guards every other route behind sign-in', () => {
    const all = new Set(routes(appDir)); // a group such as (tabs) counts as one route
    for (const open of ['sign-in', 'sign-up', 'forgot-password']) all.delete(open);
    expect(new Set(declared('signedIn'))).toEqual(all);
  });

  it('declares nothing outside the guards', () => {
    const inside = blocks.map((b) => b[0]).join('');
    const outside = [...layout.matchAll(/<Stack\.Screen name="([^"]+)"/g)].filter(
      (m) => !inside.includes(m[0]),
    );
    expect(outside.map((m) => m[1])).toEqual([]);
  });
});

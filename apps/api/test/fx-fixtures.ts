import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HttpGet } from '../src/fx/sources.js';

export const fxFixture = (name: string) => readFileSync(join(__dirname, 'fixtures/fx', name), 'utf8');

/** Serves the FX fixture files by URL; `fail` makes a source answer HTTP 503. Nothing touches the network. */
export function fixtureHttp(fail: { ecb?: boolean; oxr?: boolean } = {}) {
  const urls: string[] = [];
  const get: HttpGet = async (url) => {
    urls.push(url);
    const file = url.includes('openexchangerates')
      ? fail.oxr
        ? null
        : 'oxr-latest.json'
      : fail.ecb
        ? null
        : url.slice(url.lastIndexOf('/') + 1);
    return file
      ? { ok: true, status: 200, text: async () => fxFixture(file) }
      : { ok: false, status: 503, text: async () => 'unavailable' };
  };
  return { get, urls };
}

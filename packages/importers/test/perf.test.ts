import { describe, expect, it } from 'vitest';
import { analyze, parseDelimited } from '../src/index.js';

describe('performance (NFR-07)', () => {
  it('parses and analyzes a 5,000-row statement in well under 10 s', () => {
    const lines = ['Date,Description,Amount,Balance'];
    let balance = 1_000_000;
    for (let i = 0; i < 5000; i++) {
      const amount = ((i * 7919) % 20000) - 12000;
      balance += amount;
      const d = new Date(Date.UTC(2026, 0, 1) + Math.floor(i / 20) * 86_400_000).toISOString().slice(0, 10);
      lines.push(
        `${d},"MERCHANT ${i % 97} #${i} SAN FRANCISCO CA",${(amount / 100).toFixed(2)},${(balance / 100).toFixed(2)}`,
      );
    }
    const started = performance.now();
    const a = analyze([parseDelimited(lines.join('\n'))], {
      fileType: 'csv',
      currency: 'USD',
      accountType: 'asset',
    });
    const ms = performance.now() - started;
    expect(a.parsed.rows).toHaveLength(5000);
    expect(a.balance.status).toBe('ok');
    expect(ms).toBeLessThan(10_000);
    console.log(`5,000 rows analyzed in ${ms.toFixed(0)} ms`);
  });
});

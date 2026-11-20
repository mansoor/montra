/**
 * The synthetic SimpleFIN on its own, for the web's e2e run (apps/web/playwright.config.ts): a fixed port, `GET /__token`
 * for a new setup token, and dates relative to today so a first sync always finds them. Never used anywhere real; the
 * API reaches it only with SIMPLEFIN_ALLOW_LOCAL_HTTP=on, which production refuses.
 */
import { startFakeSimpleFin } from './simplefin.js';

const day = (back: number) => Math.floor((Date.now() - back * 86_400_000) / 1000);

const fake = await startFakeSimpleFin({
  port: Number(process.env.E2E_SIMPLEFIN_PORT ?? 4655),
  tokenRoute: true,
});
fake.accounts[0]!.balanceDate = day(1);
fake.accounts[0]!.balance = '2460.00';
fake.accounts[0]!.transactions = [
  { id: 'T-1', posted: day(20), amount: '-40.00', description: 'Zelle Payment To SAM EXAMPLE' },
  { id: 'T-2', posted: day(5), amount: '2500.00', description: 'ACME CORP PAYROLL' },
  { id: 'T-P', posted: 0, amount: '-12.50', description: 'COFFEE (pending)', pending: true },
];
fake.accounts[1]!.balance = '-500.00';
fake.accounts[1]!.balanceDate = day(1);
fake.accounts[1]!.transactions = [
  { id: 'C-1', posted: day(10), amount: '-310.20', description: 'GROCERY MART' },
];
console.log(`fake SimpleFIN on ${fake.url}`);

/**
 * Key wrapping from the command line (ADR-0050 §3). See docs/runbooks/key-wrapping.md.
 *
 *   rewrap [--dry-run] [--batch 200]   moves the wrapped keys from KMS_PREVIOUS_MODE to KMS_MODE
 *   check [--batch 200]                unwraps every stored key with KMS_MODE and reports any it can't (a restore
 *                                      drill, or the end of a move); writes nothing
 *
 *   pnpm --filter @montra/api crypto:rewrap [-- --dry-run]       pnpm --filter @montra/api crypto:check
 *   node dist/crypto-cli.js rewrap|check …                        (in the API image; `docker compose run --rm crypto …`)
 *
 * Run it with the service's settings plus DATABASE_ADMIN_URL (or DATABASE_ADMIN_URL_FILE): it reads every workspace's
 * keys, past row level security. A rewrap can be stopped and run again; what's already moved is skipped, and the
 * services keep running, unwrapping with either mode meanwhile.
 */
import pg from 'pg';
import { loadConfig } from './config.js';
import { MovingKms, createKms } from './crypto/kms.js';
import { checkKeys, rewrapKeys } from './crypto/rewrap.js';
import { secretFromEnv } from './secret-files.js';

const USAGE = 'Usage: crypto-cli rewrap [--dry-run] [--batch N] | check [--batch N]';
const args = process.argv.slice(2).filter((a) => a !== '--');
const command = args.shift();
const dryRun = args.includes('--dry-run');
const batchAt = args.indexOf('--batch');
const batchSize = batchAt >= 0 ? Number(args[batchAt + 1]) : 200;
if ((command !== 'rewrap' && command !== 'check') || !Number.isInteger(batchSize) || batchSize < 1) {
  console.error(USAGE);
  process.exit(1);
}

const config = loadConfig();
const kms = createKms(config);
const url = secretFromEnv('DATABASE_ADMIN_URL');
if (!url) {
  console.error('DATABASE_ADMIN_URL (or DATABASE_ADMIN_URL_FILE) is required');
  process.exit(1);
}

async function rewrap(pool: pg.Pool): Promise<number> {
  if (!(kms instanceof MovingKms)) {
    console.error(
      `Nothing to move from: set KMS_PREVIOUS_MODE to the mode the keys are wrapped with now (KMS_MODE=${config.KMS_MODE} is where they go).`,
    );
    return 1;
  }
  console.log(
    `Moving wrapped keys from ${config.KMS_PREVIOUS_MODE} to ${config.KMS_MODE}${dryRun ? ' (dry run: nothing is written)' : ''}`,
  );
  const counts = await rewrapKeys(pool, kms.current, kms.previous, {
    batchSize,
    dryRun,
    log: (line) => console.log(line),
  });
  let failed = 0;
  for (const c of counts) {
    console.log(
      `${c.name}: ${c.done} already ${config.KMS_MODE}, ${c.rewrapped} ${dryRun ? 'to move' : 'moved'}, ${c.failed} failed`,
    );
    failed += c.failed;
  }
  if (failed > 0) {
    console.error(`${failed} key(s) weren't moved. Run again; if they still fail, see the lines above.`);
    return 1;
  }
  if (!dryRun) {
    console.log(`Done. Every key is wrapped with ${config.KMS_MODE}: remove KMS_PREVIOUS_MODE and redeploy.`);
  }
  return 0;
}

async function check(pool: pg.Pool): Promise<number> {
  // During a move, check the new mode alone: that's what has to work once KMS_PREVIOUS_MODE is gone.
  const adapter = kms instanceof MovingKms ? kms.current : kms;
  console.log(`Unwrapping every stored key with KMS_MODE=${config.KMS_MODE}`);
  const counts = await checkKeys(pool, adapter, { batchSize, log: (line) => console.log(line) });
  let failed = 0;
  for (const c of counts) {
    console.log(`${c.name}: ${c.ok} unwrap, ${c.failed} don't`);
    failed += c.failed;
  }
  if (failed > 0) {
    console.error(`${failed} key(s) don't unwrap with ${config.KMS_MODE}: what they protect can't be read.`);
    return 1;
  }
  console.log('Every key unwraps.');
  return 0;
}

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  process.exitCode = command === 'rewrap' ? await rewrap(pool) : await check(pool);
} finally {
  await pool.end();
}

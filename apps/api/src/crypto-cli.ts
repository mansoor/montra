/**
 * Moves the wrapped keys from one key-wrapping mode to another (ADR-0050 §3):
 *   pnpm --filter @montra/api crypto:rewrap [-- --dry-run] [--batch 200]
 *   node dist/crypto-cli.js rewrap [--dry-run] [--batch 200]      (in the API image)
 *
 * Run it with the service's settings, where KMS_MODE is the new mode and KMS_PREVIOUS_MODE the old one, plus
 * DATABASE_ADMIN_URL (or DATABASE_ADMIN_URL_FILE). The services keep running: they unwrap with either while it runs.
 * It can be stopped and run again; what's already moved is skipped. See docs/runbooks/key-wrapping.md.
 */
import pg from 'pg';
import { loadConfig } from './config.js';
import { MovingKms, createKms } from './crypto/kms.js';
import { rewrapKeys } from './crypto/rewrap.js';
import { secretFromEnv } from './secret-files.js';

const args = process.argv.slice(2).filter((a) => a !== '--');
const command = args[0] === 'rewrap' ? args.shift() : 'rewrap';
const dryRun = args.includes('--dry-run');
const batchAt = args.indexOf('--batch');
const batchSize = batchAt >= 0 ? Number(args[batchAt + 1]) : 200;
if (command !== 'rewrap' || !Number.isInteger(batchSize) || batchSize < 1) {
  console.error('Usage: crypto:rewrap [--dry-run] [--batch N]');
  process.exit(1);
}

const config = loadConfig();
const kms = createKms(config);
if (!(kms instanceof MovingKms)) {
  console.error(
    `Nothing to move from: set KMS_PREVIOUS_MODE to the mode the keys are wrapped with now (KMS_MODE=${config.KMS_MODE} is where they go).`,
  );
  process.exit(1);
}
const url = secretFromEnv('DATABASE_ADMIN_URL');
if (!url) {
  console.error('DATABASE_ADMIN_URL (or DATABASE_ADMIN_URL_FILE) is required');
  process.exit(1);
}

console.log(
  `Moving wrapped keys from ${config.KMS_PREVIOUS_MODE} to ${config.KMS_MODE}${dryRun ? ' (dry run: nothing is written)' : ''}`,
);
const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
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
    process.exitCode = 1;
  } else if (!dryRun) {
    console.log(`Done. Every key is wrapped with ${config.KMS_MODE}: remove KMS_PREVIOUS_MODE and redeploy.`);
  }
} finally {
  await pool.end();
}

import { readFileSync } from 'node:fs';
import { migrate, resetDatabase } from './migrate.js';
import { loadReferenceData } from './reference/load.js';

// ADR-0050 §2: the owner's URL can come from a file, as Docker and Kubernetes secrets do.
const urlFile = process.env.DATABASE_ADMIN_URL_FILE;
if (urlFile && process.env.DATABASE_ADMIN_URL)
  throw new Error('Set DATABASE_ADMIN_URL or DATABASE_ADMIN_URL_FILE, not both');
const url =
  (urlFile ? readFileSync(urlFile, 'utf8').trim() : process.env.DATABASE_ADMIN_URL) ??
  'postgres://montra_owner:montra_owner@localhost:5432/montra';
const command = process.argv[2] ?? 'migrate';

if (command === 'reset') {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to reset a production database');
  await resetDatabase(url);
}
if (command === 'migrate' || command === 'reset') {
  const { applied, skipped } = await migrate(url, (m) => console.log(m));
  console.log(`migrations: ${applied.length} applied, ${skipped.length} already applied`);
  const ref = await loadReferenceData(url);
  console.log(`reference data: ${ref.merchants} merchants, ${ref.currencies} currencies`);
} else {
  console.error(`unknown command: ${command} (use migrate | reset)`);
  process.exit(1);
}

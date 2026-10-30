import { migrate, resetDatabase } from './migrate.js';

const url = process.env.DATABASE_ADMIN_URL ?? 'postgres://montra_owner:montra_owner@localhost:5432/montra';
const command = process.argv[2] ?? 'migrate';

if (command === 'reset') {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to reset a production database');
  await resetDatabase(url);
}
if (command === 'migrate' || command === 'reset') {
  const { applied, skipped } = await migrate(url, (m) => console.log(m));
  console.log(`migrations: ${applied.length} applied, ${skipped.length} already applied`);
} else {
  console.error(`unknown command: ${command} (use migrate | reset)`);
  process.exit(1);
}

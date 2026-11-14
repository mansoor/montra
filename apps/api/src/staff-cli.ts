/**
 * Adds someone to the staff console, or changes their role (ADR-0020 §9): pnpm --filter @montra/api staff:add <email> <support|admin>
 * Needs DATABASE_ADMIN_URL (or DATABASE_ADMIN_URL_FILE): nothing the running service can reach is allowed to make someone staff.
 */
import pg from 'pg';
import { secretFromEnv } from './secret-files.js';

const [email, role] = process.argv.slice(2);
if (!email || (role !== 'support' && role !== 'admin')) {
  console.error('Usage: staff:add <email> <support|admin>');
  process.exit(1);
}
const url = secretFromEnv('DATABASE_ADMIN_URL');
if (!url) {
  console.error('DATABASE_ADMIN_URL (or DATABASE_ADMIN_URL_FILE) is required');
  process.exit(1);
}
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const { rowCount } = await client.query(
    `insert into app.staff_user (user_id, role)
     select id, $2 from app.app_user where email = $1 and deleted_at is null
     on conflict (user_id) do update set role = excluded.role`,
    [email, role],
  );
  if (!rowCount) {
    console.error(`No account for ${email}. They need to sign in once first.`);
    process.exitCode = 1;
  } else {
    console.log(`${email} is now ${role}.`);
  }
} finally {
  await client.end();
}

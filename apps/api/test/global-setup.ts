import { migrate, resetDatabase } from '@montra/db';
import { ADMIN_URL } from './env.js';

export default async function setup(): Promise<void> {
  await resetDatabase(ADMIN_URL);
  await migrate(ADMIN_URL);
}

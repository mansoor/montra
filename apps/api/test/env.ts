export const ADMIN_URL =
  process.env.API_DATABASE_ADMIN_URL ?? 'postgres://montra_owner:montra_owner@localhost:5432/montra_test_api';
export const APP_URL =
  process.env.API_DATABASE_URL ?? 'postgres://montra_app:montra_app@localhost:5432/montra_test_api';

import { sql } from 'kysely';

/**
 * RCP-10, BAK-09: a new receipt's or stored file's retention date, `years` (FILE_RETENTION_YEARS) from today. The
 * hourly retention job (`OwnershipService.retention`) removes it once the date has passed.
 */
export const retainUntil = (years: number) =>
  sql<string>`(current_date + make_interval(years => ${years}))::date`;

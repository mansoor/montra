import type { z } from 'zod';

/** Validates untrusted input against a contract schema; ZodErrors become 400 problems. */
export const parse = <S extends z.ZodType>(schema: S, value: unknown): z.output<S> => schema.parse(value);

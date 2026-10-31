import { z } from 'zod';

export const PROMPT_VERSION = 'ping.v1';

export const SYSTEM = 'This is a connection test. Reply with {"ok": true}.';

export const Output = z.object({ ok: z.boolean() });
export type Output = z.infer<typeof Output>;

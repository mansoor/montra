import { v7 } from 'uuid';

/** Time-ordered UUIDv7, generated in the app so mobile can create ids offline (design 03). */
export const newId = (): string => v7();

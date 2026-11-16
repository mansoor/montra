/**
 * How billers are matched to payees, payments and scanned bills (ADR-0048 §4). Kept apart from `BillersService` so the
 * bill filing service can use it without importing the service that injects it.
 */
import { normalizeDescription, similarity } from '@montra/importers';

/** A payee this close to the biller's name is the biller (payee keys are normalized the same way). */
const SAME_PAYEE = 0.6;

/** The key a biller's payments and bills are matched by: its name normalized like a payee. */
export const billerKey = (name: string): string => normalizeDescription(name) || name.trim().toUpperCase();

/** Whether a transaction's payee key is this biller's. */
export const isBillerPayee = (billerKeyValue: string, payeeKey: string): boolean =>
  payeeKey.startsWith(billerKeyValue) || similarity(payeeKey, billerKeyValue) >= SAME_PAYEE;

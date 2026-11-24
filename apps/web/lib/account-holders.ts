/**
 * An account's holders (ACC-15) and its full number (ACC-16) on the web: the shaping is shared with the phone
 * (@montra/domain); who may manage the number is here. The API is the authority (the holder limit is its
 * ACCOUNT_MAX_HOLDERS setting).
 */
import type { MemberRole } from '@montra/api-client';
import { isAdminRole } from './settings';

export {
  accountNumberInput,
  holderDrafts,
  holdersChanged,
  holdersLine,
  holdersToSave,
  type HolderDraft,
} from '@montra/domain';

/** Owners and admins type in, remove and show the full number, as the API allows. */
export const canManageAccountNumber = (role: MemberRole | null | undefined): boolean =>
  role != null && isAdminRole(role);

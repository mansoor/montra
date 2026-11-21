/**
 * OPS-04: whether this app is too old for the server it connects to, and where to get a newer one. The server says
 * the oldest version it serves (`GET /v1/app/requirements`, asked on start and on coming back to the app) and refuses
 * older ones with 426; the update screen then sends the person to the update link.
 */
import { isVersionBelow } from '@montra/domain';
import type { AppRequirementsDto } from '@montra/schemas';

/** Where to get the app when the server didn't say: the project's releases, until the app is in the stores. */
export const DEFAULT_UPDATE_URL = 'https://github.com/mansoor/montra/releases/latest';

export interface UpdateNeeded {
  /** The oldest version the server serves; null when a 426 arrived before the server said which. */
  minVersion: string | null;
  url: string;
}

/** What the server's requirements mean for this app: null when it's new enough. */
export function updateNeeded(appVersion: string, req: AppRequirementsDto | null): UpdateNeeded | null {
  if (!req || !isVersionBelow(appVersion, req.minVersion)) return null;
  return { minVersion: req.minVersion, url: httpsOrDefault(req.updateUrl) };
}

/** After a 426 (the server refused this version): what's known so far, filled in once the requirements arrive. */
export function refused(current: UpdateNeeded | null): UpdateNeeded {
  return current ?? { minVersion: null, url: DEFAULT_UPDATE_URL };
}

/** Only an https link is opened; anything else falls back to the project's releases. */
function httpsOrDefault(url: string | undefined): string {
  return url && /^https:\/\//i.test(url) ? url : DEFAULT_UPDATE_URL;
}

/** iOS and Android are the platforms the server keeps a minimum for. */
export const checksVersion = (os: string): os is 'ios' | 'android' => os === 'ios' || os === 'android';

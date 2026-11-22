/**
 * Renders a screen the way the app's root layout does: toasts and the real `SessionProvider` (with the API client and
 * SecureStore mocked), and the screen only once the saved session has been read.
 */
import type { ReactElement, ReactNode } from 'react';
import { render } from '@testing-library/react-native';
import type { MemberRole, MeDto, WorkspaceDto } from '@montra/schemas';
import { SessionProvider, useSession } from '../../src/session/SessionProvider';
import { ToastHost } from '../../src/ui/components';
import { api } from './api';
import { setItemAsync } from './secure-store';

export const WS = 'ws-1';

export const me = (over: Partial<MeDto> = {}): MeDto => ({
  id: 'user-1',
  email: 'ada@example.com',
  displayName: 'Ada',
  locale: 'en-US',
  timeZone: 'America/Los_Angeles',
  dateFormat: null,
  weekStart: 1,
  emailVerified: true,
  ...over,
});

export const workspace = (role: MemberRole, over: Partial<WorkspaceDto> = {}): WorkspaceDto => ({
  id: WS,
  name: 'Home',
  baseCurrency: 'USD',
  timeZone: 'America/Los_Angeles',
  role,
  entities: [
    {
      id: 'ent-personal',
      type: 'personal',
      name: 'Personal',
      functionalCurrency: 'USD',
      lockedThrough: null,
      color: null,
      access: role === 'viewer' ? 'read' : 'write',
    },
  ],
  security: { mfaPolicy: 'standard', idleTimeoutMinutes: 15 },
  accountantSeesTaxForms: false,
  ...over,
});

/** A saved session, as after signing in on this phone: the session opens this workspace with this role. */
export async function signedInAs(role: MemberRole, who: MeDto = me()): Promise<void> {
  await setItemAsync('montra.session.v1', `dev:${who.email}`);
  await setItemAsync('montra.workspace.v1', WS);
  api.me.mockResolvedValue(who);
  api.workspaces.mockResolvedValue([workspace(role)]);
}

/** Holds the screen back while the session is still being read, as the app's start screen does. */
function Ready({ children }: { children: ReactNode }) {
  const { state } = useSession();
  return state.status === 'loading' ? null : <>{children}</>;
}

export function renderScreen(ui: ReactElement) {
  return render(
    <ToastHost>
      <SessionProvider>
        <Ready>{ui}</Ready>
      </SessionProvider>
    </ToastHost>,
  );
}

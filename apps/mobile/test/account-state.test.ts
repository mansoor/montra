import { describe, expect, it } from 'vitest';
import { TransportError } from '@montra/sync';
import { ApiError } from '../src/api/client';
import {
  closedCopy,
  closedFrom,
  closedOf,
  otherWorkspaces,
  strongerClosed,
  supportAddress,
} from '../src/features/account-state';

describe('a closed account or workspace (ADR-0049 §4, BAK-09)', () => {
  it('knows the three refusals, from the API client or the sync engine', () => {
    expect(closedFrom(new ApiError(403, 'account.suspended', 'Suspended.'))).toEqual({
      kind: 'suspended',
      message: 'Suspended.',
    });
    expect(closedFrom(new TransportError(403, 'workspace.suspended', 'Closed.', false))).toEqual({
      kind: 'workspace',
      message: 'Closed.',
    });
    expect(closedFrom(new ApiError(403, 'account.deleting', 'Deleting.'))?.kind).toBe('deleting');
    expect(closedOf('account.deleting')).toEqual({ kind: 'deleting', message: '' });
  });

  it('ignores everything else, so a plain refusal or an outage never closes the app', () => {
    expect(closedFrom(new ApiError(403, 'forbidden', 'No'))).toBeNull();
    expect(closedFrom(new ApiError(401, 'account.suspended', 'x'))).toBeNull();
    expect(closedFrom(new ApiError(0, 'network', 'offline'))).toBeNull();
    expect(closedFrom(new Error('boom'))).toBeNull();
    expect(closedFrom(null)).toBeNull();
    expect(closedOf('mfa.required')).toBeNull();
  });

  it('lets a whole-account refusal replace a workspace one, but keeps the first otherwise', () => {
    const ws = { kind: 'workspace' as const, message: 'w' };
    const suspended = { kind: 'suspended' as const, message: 's' };
    const deleting = { kind: 'deleting' as const, message: 'd' };
    expect(strongerClosed(null, ws)).toBe(ws);
    expect(strongerClosed(ws, suspended)).toBe(suspended);
    expect(strongerClosed(suspended, ws)).toBe(suspended);
    expect(strongerClosed(suspended, deleting)).toBe(suspended);
    expect(strongerClosed(ws, { kind: 'workspace', message: 'again' })).toBe(ws);
  });

  it('finds the support address in the server’s sentence', () => {
    expect(supportAddress('This workspace is closed for now. Contact support at help@example.test.')).toBe(
      'help@example.test',
    );
    expect(supportAddress('Contact support at Support.Team@mail.example.test')).toBe(
      'Support.Team@mail.example.test',
    );
    expect(supportAddress('This workspace is closed for now. Contact support.')).toBeNull();
    expect(supportAddress('')).toBeNull();
  });

  it('offers the other workspaces only when just this one is closed', () => {
    const list = [
      { id: 'a', name: 'Home' },
      { id: 'b', name: 'Shop' },
    ];
    expect(otherWorkspaces({ kind: 'workspace', message: '' }, list, 'a')).toEqual([
      { id: 'b', name: 'Shop' },
    ]);
    expect(otherWorkspaces({ kind: 'suspended', message: '' }, list, 'a')).toEqual([]);
    expect(otherWorkspaces({ kind: 'deleting', message: '' }, list, 'a')).toEqual([]);
    expect(otherWorkspaces(null, list, 'a')).toEqual([]);
  });

  it('says it in the web’s words', () => {
    expect(closedCopy('suspended')).toEqual({ title: 'closed.account_title', body: 'closed.account_body' });
    expect(closedCopy('workspace')).toEqual({
      title: 'closed.workspace_title',
      body: 'closed.workspace_body',
    });
    expect(closedCopy('deleting')).toEqual({
      title: 'account_deleting.title',
      body: 'account_deleting.hint',
    });
  });
});

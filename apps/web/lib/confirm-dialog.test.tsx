// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog, useConfirm } from '@/components/ui/confirm-dialog';

// jsdom has <dialog> but not its modal methods: these do what the browser does that the component relies on.
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const proto = HTMLDialogElement.prototype;
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  proto.close = function (this: HTMLDialogElement) {
    if (!this.open) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const dialog = () => host.querySelector('dialog')!;
const button = (name: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === name) as HTMLButtonElement;
/** Esc on a modal dialog: the browser fires `cancel`, and closes it unless that's prevented. */
const pressEscape = () => {
  const cancel = new Event('cancel', { cancelable: true });
  dialog().dispatchEvent(cancel);
  if (!cancel.defaultPrevented) dialog().close();
};

function Harness({ danger = true, busy = false }: { danger?: boolean; busy?: boolean }) {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <output>{log.join(',')}</output>
      <ConfirmDialog
        open={open}
        title="Delete this account?"
        body={<p>It can’t be undone.</p>}
        confirmLabel="Delete account"
        danger={danger}
        busy={busy}
        onConfirm={() => {
          setLog((l) => [...l, 'confirm']);
          setOpen(false);
        }}
        onCancel={() => {
          setLog((l) => [...l, 'cancel']);
          setOpen(false);
        }}
      />
    </>
  );
}

const open = () => {
  const trigger = button('Open');
  trigger.focus();
  act(() => trigger.click());
  return trigger;
};
const log = () => host.querySelector('output')!.textContent;

describe('ConfirmDialog', () => {
  it('opens as a labelled alert dialog, with focus on Cancel when it destroys something', () => {
    act(() => root.render(<Harness />));
    expect(dialog().open).toBe(false);
    open();
    expect(dialog().open).toBe(true);
    expect(dialog().getAttribute('role')).toBe('alertdialog');
    const title = document.getElementById(dialog().getAttribute('aria-labelledby')!);
    expect(title?.textContent).toBe('Delete this account?');
    expect(document.getElementById(dialog().getAttribute('aria-describedby')!)?.textContent).toBe(
      'It can’t be undone.',
    );
    expect(document.activeElement).toBe(button('Cancel'));
    expect(button('Delete account').className).toContain('btn-danger');
  });

  it('focuses the confirm button when nothing is destroyed', () => {
    act(() => root.render(<Harness danger={false} />));
    open();
    expect(document.activeElement).toBe(button('Delete account'));
    expect(button('Delete account').className).toContain('btn-primary');
  });

  it('cancels, and gives focus back to what opened it', () => {
    act(() => root.render(<Harness />));
    const trigger = open();
    act(() => button('Cancel').click());
    expect(log()).toBe('cancel');
    expect(dialog().open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('confirms', () => {
    act(() => root.render(<Harness />));
    const trigger = open();
    act(() => button('Delete account').click());
    expect(log()).toBe('confirm');
    expect(dialog().open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('takes Esc as Cancel', () => {
    act(() => root.render(<Harness />));
    open();
    act(() => pressEscape());
    expect(log()).toBe('cancel');
    expect(dialog().open).toBe(false);
  });

  it('ignores Esc and both buttons while busy', () => {
    act(() => root.render(<Harness busy />));
    open();
    act(() => pressEscape());
    expect(dialog().open).toBe(true);
    expect(log()).toBe('');
    expect(button('Cancel').disabled).toBe(true);
    expect(button('Delete account').disabled).toBe(true);
    expect(dialog().getAttribute('aria-busy')).toBe('true');
  });
});

describe('useConfirm', () => {
  function Asker({ action, onAnswer }: { action?: () => Promise<unknown>; onAnswer: (ok: boolean) => void }) {
    const { confirm, dialog: view } = useConfirm();
    return (
      <>
        <button
          type="button"
          onClick={() =>
            void confirm({ title: 'Remove it?', confirmLabel: 'Remove', danger: true, action }).then(onAnswer)
          }
        >
          Open
        </button>
        {view}
      </>
    );
  }

  it('resolves false on Cancel and Esc, true on confirm', async () => {
    const answers: boolean[] = [];
    act(() => root.render(<Asker onAnswer={(ok) => answers.push(ok)} />));
    open();
    await act(async () => button('Cancel').click());
    open();
    await act(async () => pressEscape());
    open();
    await act(async () => button('Remove').click());
    expect(answers).toEqual([false, false, true]);
    expect(dialog().open).toBe(false);
  });

  it('stays open and busy while the action runs, then closes', async () => {
    let finish!: () => void;
    const action = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const answers: boolean[] = [];
    act(() => root.render(<Asker action={action} onAnswer={(ok) => answers.push(ok)} />));
    open();
    await act(async () => button('Remove').click());
    expect(action).toHaveBeenCalledOnce();
    expect(dialog().open).toBe(true);
    expect(button('Remove').disabled).toBe(true);
    expect(answers).toEqual([]);
    await act(async () => finish());
    expect(dialog().open).toBe(false);
    expect(answers).toEqual([true]);
  });

  it('doesn’t run the action on Cancel', async () => {
    const action = vi.fn(async () => {});
    act(() => root.render(<Asker action={action} onAnswer={() => {}} />));
    open();
    await act(async () => button('Cancel').click());
    expect(action).not.toHaveBeenCalled();
  });
});

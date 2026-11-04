'use client';

import { CircleHelp } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { browserApi } from '@/lib/browser-api';
import { recentClientLogs } from '@/lib/client-log';
import { HELP_ARTICLES, searchHelp, TOUR_STEPS } from '@/lib/help-content';
import { useI18n } from './i18n';
import { StatusLine, useAction } from './use-action';

/** Past 1.5 MB, base64 goes over what the API takes. */
const MAX_SCREENSHOT_BYTES = 1_500_000;
const TOUR_KEY = 'montra.tour.step';
const TOUR_EVENT = 'montra:tour';

export function HelpLink({ workspaceId }: { workspaceId: string }) {
  const { t } = useI18n();
  return (
    <Link href={`/w/${workspaceId}/help`} className="icon-btn" aria-label={t('help.title')}>
      <CircleHelp aria-hidden size={18} strokeWidth={1.8} />
    </Link>
  );
}

/** The help center's list, narrowing as you type. Articles open on the public pages, so links work for anyone. */
export function HelpSearch() {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const found = query ? searchHelp(query) : HELP_ARTICLES;
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="field-label">{t('help.search')}</span>
        <input className="input" type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {found.length === 0 && (
        <p className="text-sm text-muted" role="status">
          {t('help.nothing')}
        </p>
      )}
      <ul className="grid gap-3 sm:grid-cols-2">
        {found.map((a) => (
          <li key={a.slug}>
            <Link
              className="card block h-full hover:border-brand-600"
              href={`/help/${a.slug}`}
              data-testid="help-article"
            >
              <span className="block text-sm font-semibold">{a.title}</span>
              <span className="block text-sm text-muted">{a.summary}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

const readTour = (): number | null => {
  try {
    const v = window.localStorage.getItem(TOUR_KEY);
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
};

const writeTour = (step: number | null) => {
  try {
    if (step === null) window.localStorage.removeItem(TOUR_KEY);
    else window.localStorage.setItem(TOUR_KEY, String(step));
  } catch {
    // No storage, as in a private window: the tour just ends when the page changes.
  }
  window.dispatchEvent(new Event(TOUR_EVENT));
};

export function StartTourButton({ workspaceId }: { workspaceId: string }) {
  const { t } = useI18n();
  const router = useRouter();
  return (
    <button
      type="button"
      className="btn-secondary"
      onClick={() => {
        writeTour(0);
        router.push(`/w/${workspaceId}${TOUR_STEPS[0]!.path}`);
      }}
    >
      {t('help.take_tour')}
    </button>
  );
}

/** OPS-09: a walk through the main screens, only when someone asks for one. It never opens by itself over their work. */
export function Tour({ workspaceId }: { workspaceId: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const [step, setStep] = useState<number | null>(null);
  useEffect(() => {
    const sync = () => setStep(readTour());
    sync();
    window.addEventListener(TOUR_EVENT, sync);
    return () => window.removeEventListener(TOUR_EVENT, sync);
  }, []);
  const current = step === null ? undefined : TOUR_STEPS[step];
  if (!current || step === null) return null;
  const last = step === TOUR_STEPS.length - 1;
  return (
    <aside
      className="card fixed right-4 bottom-4 left-4 z-40 space-y-2 shadow-lg sm:left-auto sm:w-80"
      aria-label={t('help.tour')}
      data-testid="tour"
    >
      <p className="text-xs text-muted">{t('help.tour_step', { n: step + 1, of: TOUR_STEPS.length })}</p>
      <h2 className="text-sm font-semibold">{current.title}</h2>
      <p className="text-sm text-muted">{current.body}</p>
      <div className="flex justify-between gap-2">
        <button type="button" className="text-sm underline" onClick={() => writeTour(null)}>
          {t(last ? 'help.tour_done' : 'help.tour_skip')}
        </button>
        {!last && (
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              writeTour(step + 1);
              router.push(`/w/${workspaceId}${TOUR_STEPS[step + 1]!.path}`);
            }}
          >
            {t('help.tour_next')}
          </button>
        )}
      </div>
    </aside>
  );
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('read'));
    reader.readAsDataURL(file);
  });
}

/** OPS-09: a question or a bug report. A screenshot and logs go only if the person chooses to send them. */
export function ContactForm({ workspaceId }: { workspaceId: string }) {
  const { run, busy, message, setMessage, t } = useAction();
  const [kind, setKind] = useState<'question' | 'bug'>('question');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [logs, setLogs] = useState(true);
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [formKey, setFormKey] = useState(0);
  return (
    <form
      key={formKey}
      className="card max-w-xl space-y-3"
      aria-label={t('help.contact')}
      onSubmit={async (e) => {
        e.preventDefault();
        if (screenshot && screenshot.size > MAX_SCREENSHOT_BYTES) {
          setMessage({ tone: 'bad', text: t('help.screenshot_big') });
          return;
        }
        const encoded = screenshot ? await toBase64(screenshot) : undefined;
        const sent = await run(
          () =>
            browserApi.createSupportRequest({
              kind,
              subject,
              body,
              workspaceId,
              ...(encoded ? { screenshot: encoded } : {}),
              ...(logs
                ? {
                    context: {
                      path: window.location.pathname,
                      userAgent: navigator.userAgent.slice(0, 500),
                      logs: recentClientLogs(),
                    },
                  }
                : {}),
            }),
          t('help.sent'),
        );
        if (sent) {
          setSubject('');
          setBody('');
          setScreenshot(null);
          setFormKey((k) => k + 1);
        }
      }}
    >
      <label className="block">
        <span className="field-label">{t('help.kind')}</span>
        <select
          className="input"
          value={kind}
          onChange={(e) => setKind(e.target.value as 'question' | 'bug')}
        >
          <option value="question">{t('help.kind_question')}</option>
          <option value="bug">{t('help.kind_bug')}</option>
        </select>
      </label>
      <label className="block">
        <span className="field-label">{t('help.subject')}</span>
        <input
          className="input"
          required
          maxLength={200}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
      </label>
      <label className="block">
        <span className="field-label">{t('help.body')}</span>
        <textarea
          className="input min-h-32"
          required
          maxLength={5000}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      <label className="block">
        <span className="field-label">{t('help.screenshot')}</span>
        <input
          className="input"
          type="file"
          accept="image/png,image/jpeg"
          onChange={(e) => setScreenshot(e.target.files?.[0] ?? null)}
        />
        <span className="mt-1 block text-xs text-muted">{t('help.screenshot_hint')}</span>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={logs} onChange={(e) => setLogs(e.target.checked)} />
        {t('help.include_logs')}
      </label>
      <button type="submit" className="btn-primary" disabled={busy || !subject.trim() || !body.trim()}>
        {t('help.send')}
      </button>
      <StatusLine message={message} />
    </form>
  );
}

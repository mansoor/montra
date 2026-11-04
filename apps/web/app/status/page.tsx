import type { Metadata } from 'next';
import type { StatusDto } from '@montra/api-client';
import { getPublicI18n } from '@/lib/i18n-public';
import { API_URL } from '@/lib/session';
import { PublicShell } from '@/components/public-shell';

export const metadata: Metadata = { title: 'Status' };
export const dynamic = 'force-dynamic';

async function read(): Promise<StatusDto> {
  try {
    const res = await fetch(`${API_URL}/v1/status`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (res.ok) return (await res.json()) as StatusDto;
  } catch {
    // If the API can't be reached, that's the answer.
  }
  return { status: 'down', checkedAt: new Date().toISOString(), notices: [] };
}

/** OPS-03: open to anyone. Hosted separately, this would still answer when the rest is down; see docs/runbooks. */
export default async function StatusPage() {
  const status = await read();
  const { t } = getPublicI18n();
  const when = (iso: string) => new Date(iso).toUTCString();
  return (
    <PublicShell>
      <h1 className="page-title">{t('status.title')}</h1>
      <p
        className={`card text-base font-semibold ${status.status === 'operational' ? 'text-good' : 'text-bad'}`}
        role="status"
        data-testid="status-now"
      >
        {t(`status.${status.status}`)}
      </p>
      {status.notices.length === 0 && <p className="text-sm text-muted">{t('status.no_notices')}</p>}
      {status.notices.map((n) => (
        <article key={n.id} className="card space-y-1" data-testid="status-notice">
          <h2 className="text-sm font-semibold">{n.title}</h2>
          {n.body && <p className="text-sm">{n.body}</p>}
          {n.startsAt && <p className="text-xs text-muted">{when(n.startsAt)}</p>}
        </article>
      ))}
      <p className="text-xs text-muted">{t('status.checked', { at: when(status.checkedAt) })}</p>
    </PublicShell>
  );
}

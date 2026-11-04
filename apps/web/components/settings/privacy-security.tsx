'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { AiSettingsDto, SecurityEventDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { useI18n } from '../i18n';
import { StatusLine, useAction } from '../use-action';

/** AUTH-12: what's happened to this account. */
export function SecurityActivity({ events }: { events: SecurityEventDto[] }) {
  const { t, locale } = useI18n();
  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <section className="card space-y-3" aria-labelledby="security-title">
      <h2 id="security-title" className="text-base font-semibold">
        {t('security.title')}
      </h2>
      <p className="text-sm text-muted">{t('security.hint')}</p>
      {events.length === 0 ? (
        <p className="text-sm text-muted">{t('security.empty')}</p>
      ) : (
        <ul className="divide-y divide-line">
          {events.map((e) => (
            <li
              key={e.id}
              className="flex flex-wrap justify-between gap-2 py-2 text-sm"
              data-testid="security-event"
            >
              <span>{t(`security.kind_${e.kind}`)}</span>
              <span className="text-muted">{when.format(new Date(e.at))}</span>
            </li>
          ))}
        </ul>
      )}
      <Link className="text-sm underline" href="/settings/security">
        {t('security.manage')}
      </Link>
    </section>
  );
}

/** NFR-05, UP-06: what happens to your data, in plain words, for each AI choice. */
export function PrivacyPanel({
  disclosures,
  currentMode,
}: {
  disclosures: AiSettingsDto['disclosures'];
  currentMode: AiSettingsDto['mode'];
}) {
  const { t } = useI18n();
  const { workspaceId } = useParams<{ workspaceId: string }>();
  return (
    <div className="space-y-5">
      <section className="card space-y-2" aria-labelledby="privacy-title">
        <h2 id="privacy-title" className="text-base font-semibold">
          {t('privacy.title')}
        </h2>
        <ul className="list-inside list-disc space-y-1 text-sm">
          <li>{t('privacy.promise_1')}</li>
          <li>{t('privacy.promise_2')}</li>
          <li>{t('privacy.promise_3')}</li>
        </ul>
        <Link className="text-sm underline" href={`/w/${workspaceId}/settings?tab=data`}>
          {t('privacy.data_settings')}
        </Link>
      </section>
      <section className="space-y-3" aria-labelledby="privacy-ai">
        <h2 id="privacy-ai" className="text-base font-semibold">
          {t('privacy.ai_title')}
        </h2>
        {disclosures.map((d) => (
          <div key={d.mode} className="card" data-testid="privacy-mode">
            <h3 className="text-sm font-semibold">
              {d.title}{' '}
              {d.mode === currentMode && <span className="chip chip-good">{t('privacy.current')}</span>}
            </h3>
            <ul className="mt-1 list-inside list-disc text-sm text-muted">
              {d.points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ))}
        <Link className="text-sm underline" href={`/w/${workspaceId}/settings?tab=ai`}>
          {t('privacy.ai_settings')}
        </Link>
      </section>
    </div>
  );
}

/** UP-10: the tax package from where someone doing their taxes already is. */
export function TaxPackageButton({
  workspaceId,
  entityId,
  year,
}: {
  workspaceId: string;
  entityId: string;
  year: number;
}) {
  const { run, busy, message, t } = useAction();
  return (
    <span className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="btn-secondary"
        disabled={busy}
        onClick={() =>
          run(
            () => browserApi.createTaxPackage(workspaceId, { entityId, year }),
            t('data.tax_package_started'),
          )
        }
      >
        {t('data.tax_package_make')}
      </button>
      {message && (
        <Link className="text-sm underline" href={`/w/${workspaceId}/settings?tab=data`}>
          {t('settings.tab.data')}
        </Link>
      )}
      <StatusLine message={message} />
    </span>
  );
}

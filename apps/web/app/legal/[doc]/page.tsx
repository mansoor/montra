import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getPublicI18n } from '@/lib/i18n-public';
import { LEGAL_REVIEWED, legalDoc } from '@/lib/legal-content';
import { PublicShell } from '@/components/public-shell';

export const metadata: Metadata = { title: 'Legal' };

/** OPS-11. A draft says it's a draft until someone qualified has read it. */
export default async function LegalPage({ params }: { params: Promise<{ doc: string }> }) {
  const doc = legalDoc((await params).doc);
  if (!doc) notFound();
  const { t } = getPublicI18n();
  return (
    <PublicShell>
      <h1 className="page-title">{doc.title}</h1>
      {!LEGAL_REVIEWED && (
        <p className="card text-sm text-warn" role="note" data-testid="legal-draft">
          {t('legal.draft')}
        </p>
      )}
      {doc.sections.map((s) => (
        <section key={s.heading} className="space-y-2">
          <h2 className="text-base font-semibold">{s.heading}</h2>
          {s.paragraphs.map((p) => (
            <p key={p} className="text-sm">
              {p}
            </p>
          ))}
        </section>
      ))}
    </PublicShell>
  );
}

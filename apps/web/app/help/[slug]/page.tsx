import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPublicI18n } from '@/lib/i18n-public';
import { helpArticle } from '@/lib/help-content';
import { PublicShell } from '@/components/public-shell';

export const metadata: Metadata = { title: 'Help' };

export default async function HelpArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const article = helpArticle((await params).slug);
  if (!article) notFound();
  const { t } = getPublicI18n();
  return (
    <PublicShell>
      <Link className="text-sm text-muted hover:underline" href="/help">
        ← {t('help.title')}
      </Link>
      <h1 className="page-title">{article.title}</h1>
      {article.sections.map((s, i) => (
        <section key={s.heading ?? i} className="space-y-2">
          {s.heading && <h2 className="text-base font-semibold">{s.heading}</h2>}
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

'use client';

import { ChevronLeft, ChevronRight, ExternalLink, Maximize2, Minus, Plus } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../i18n';

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/**
 * The receipt as captured, beside the data read from it (RCP-06): one page at a time on white "paper" (never
 * themed), with page turning and zoom. Images render as <img>; a file the browser can't show as an image (a
 * PDF invoice) falls back to the browser's own PDF viewer. Files come through the authenticated /api proxy.
 */
export function ReceiptViewer({ pages }: { pages: { src: string; alt: string }[] }) {
  const { t } = useI18n();
  const [index, setIndex] = useState(0);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [pdf, setPdf] = useState<Record<number, boolean>>({});
  const page = pages[index];
  if (!page) return null;
  const step = (d: number) => {
    const current = zoom === 'fit' ? 1 : zoom;
    const i = ZOOMS.findIndex((z) => z >= current);
    const next = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (i === -1 ? ZOOMS.length - 1 : i) + d))]!;
    setZoom(next);
  };
  const isPdf = pdf[index] === true;

  return (
    <div className="card-flush flex h-full min-h-[420px] flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-line px-2 py-1.5">
        {pages.length > 1 && (
          <>
            <button
              type="button"
              className="icon-btn size-8"
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              disabled={index === 0}
              aria-label={t('viewer.previous')}
            >
              <ChevronLeft aria-hidden size={16} />
            </button>
            <span className="num px-1 text-xs text-muted">
              {t('viewer.page_of', { n: index + 1, total: pages.length })}
            </span>
            <button
              type="button"
              className="icon-btn size-8"
              onClick={() => setIndex((i) => Math.min(pages.length - 1, i + 1))}
              disabled={index === pages.length - 1}
              aria-label={t('viewer.next')}
            >
              <ChevronRight aria-hidden size={16} />
            </button>
          </>
        )}
        {!isPdf && (
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              className="icon-btn size-8"
              aria-pressed={zoom === 'fit'}
              onClick={() => setZoom('fit')}
              aria-label={t('viewer.fit')}
              title={t('viewer.fit')}
            >
              <Maximize2 aria-hidden size={15} />
            </button>
            <button
              type="button"
              className="icon-btn size-8"
              onClick={() => step(-1)}
              aria-label={t('viewer.zoom_out')}
            >
              <Minus aria-hidden size={16} />
            </button>
            <span className="num w-12 text-center text-xs text-muted" aria-live="polite">
              {zoom === 'fit' ? t('viewer.fit_short') : `${Math.trunc(zoom * 100)}%`}
            </span>
            <button
              type="button"
              className="icon-btn size-8"
              onClick={() => step(1)}
              aria-label={t('viewer.zoom_in')}
            >
              <Plus aria-hidden size={16} />
            </button>
          </div>
        )}
        <a
          href={page.src}
          target="_blank"
          rel="noreferrer"
          className={`icon-btn size-8 ${isPdf ? 'ml-auto' : ''}`}
          aria-label={t('viewer.open_original')}
          title={t('viewer.open_original')}
        >
          <ExternalLink aria-hidden size={15} />
        </a>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-sunken p-3" data-testid="receipt-viewer">
        {isPdf ? (
          <iframe
            src={page.src}
            title={page.alt}
            className="h-full min-h-[60vh] w-full rounded-[var(--radius-s)] bg-[var(--paper)]"
          />
        ) : (
          // A plain <img>: the file is private and served through the authenticated /api proxy.
          <img
            key={page.src}
            src={page.src}
            alt={page.alt}
            onError={() => setPdf((p) => ({ ...p, [index]: true }))}
            className="mx-auto block max-w-none border border-line bg-[var(--paper)] shadow-sm"
            style={
              zoom === 'fit' ? { width: '100%', height: 'auto' } : { width: `${zoom * 100}%`, height: 'auto' }
            }
          />
        )}
      </div>
    </div>
  );
}

import type { Metadata } from 'next';
import Link from 'next/link';
import { todayIn } from '@montra/domain';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { shiftDays, shiftMonth } from '@/lib/planning';
import { calendarBooks, calendarTotals, visibleItems } from '@/lib/calendar';
import { DateText } from '@/components/i18n';
import { Money } from '@/components/money';
import { CalendarBooks } from '@/components/planning/calendar-books';
import { PageHeader } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'Calendar' };
export const dynamic = 'force-dynamic';

/**
 * Bills, paydays and goal due dates by day (FLOW-05, UP-14). With more than one book, a Books list filters the calendar
 * by book, as Google Calendar's calendars: each item carries its book's colour and a word for its kind, and amounts
 * stay green coming in and red going out.
 */
export default async function CalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ month?: string }>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  const workspace = await load((api) => api.getWorkspace(workspaceId));
  const today = todayIn(workspace.timeZone);
  const month = /^\d{4}-\d{2}-01$/.test(sp.month ?? '') ? sp.month! : `${today.slice(0, 7)}-01`;
  const end = shiftDays(shiftMonth(month, 1), -1);
  const books = calendarBooks(workspace.entities);
  const filtered = books.length > 1;
  const [cal, prefs] = await Promise.all([
    load((api) => api.getCalendar(workspaceId, { from: month, to: end })),
    filtered
      ? load((api) => api.getCalendarBooks(workspaceId))
      : Promise.resolve({ hiddenEntityIds: [] as string[] }),
  ]);
  const hidden = prefs.hiddenEntityIds;
  const shown = visibleItems(cal.items, hidden);
  const bookOf = new Map(books.map((b) => [b.id, b]));
  const { t, locale } = await getI18n();
  // Month heading in the user's language ("November 2026"); dates are calendar dates, so format in UTC.
  const monthLabel = new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${month}T00:00:00Z`));

  // Weeks start on Monday; pad the first week with the previous month's days.
  const first = new Date(`${month}T00:00:00Z`).getUTCDay();
  const lead = (first + 6) % 7;
  const start = shiftDays(month, -lead);
  const days = Array.from({ length: Math.ceil((lead + Number(end.slice(8))) / 7) * 7 }, (_, i) =>
    shiftDays(start, i),
  );
  const byDay = new Map<string, typeof shown>();
  for (const i of shown) byDay.set(i.date, [...(byDay.get(i.date) ?? []), i]);
  const totals = calendarTotals(shown);
  const ccy = shown[0]?.currency ?? workspace.baseCurrency;
  const weekdays = [0, 1, 2, 3, 4, 5, 6].map((d) => t(`calendar.weekday_${d}`));

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('nav.calendar')}
        subtitle={
          <>
            {t('calendar.coming_in')} <Money amount={totals.in} currency={ccy} /> · {t('calendar.going_out')}{' '}
            <Money amount={totals.out} currency={ccy} />
          </>
        }
        actions={
          <div className="flex items-center gap-1">
            <Link href={`?month=${shiftMonth(month, -1)}`} className="btn-ghost">
              ←
            </Link>
            <span className="min-w-36 text-center font-semibold">{monthLabel}</span>
            <Link href={`?month=${shiftMonth(month, 1)}`} className="btn-ghost">
              →
            </Link>
          </div>
        }
      />
      <div className="space-y-4">
        {filtered && <CalendarBooks workspaceId={workspaceId} books={books} hidden={hidden} />}
        <div className="card-flush">
          <div className="hidden grid-cols-7 border-b border-line bg-canvas md:grid">
            {weekdays.map((w) => (
              <div key={w} className="section-h px-2 py-2">
                {w}
              </div>
            ))}
          </div>
          <ol className="grid md:grid-cols-7">
            {days.map((d) => {
              const items = byDay.get(d) ?? [];
              const inMonth = d >= month && d <= end;
              if (!inMonth && items.length === 0) {
                return (
                  <li
                    key={d}
                    aria-hidden
                    className="hidden min-h-24 border-b border-line bg-sunken/40 md:block md:border-r"
                  />
                );
              }
              return (
                <li
                  key={d}
                  className={`min-h-24 border-b border-line p-2 md:border-r ${d === today ? 'bg-brand-50' : ''} ${items.length === 0 ? 'hidden md:block' : ''}`}
                >
                  <div className={`text-xs font-semibold ${d === today ? 'text-brand-600' : 'text-muted'}`}>
                    <time dateTime={d}>
                      <span className="md:hidden">
                        <DateText date={d} />
                      </span>
                      <span className="hidden md:inline">{Number(d.slice(8))}</span>
                    </time>
                  </div>
                  <ul className="mt-1 space-y-1">
                    {items.map((i, n) => {
                      const book = filtered ? bookOf.get(i.entityId) : undefined;
                      return (
                        <li
                          key={n}
                          className={`text-xs ${book ? 'border-l-4 pl-1.5' : ''}`}
                          style={book ? { borderLeftColor: book.color } : undefined}
                          data-testid="calendar-item"
                        >
                          <span className="block truncate font-semibold" title={i.name}>
                            {i.name}
                          </span>
                          {book && (
                            <span className="sr-only">{t('calendar.in_book', { name: book.name })}</span>
                          )}
                          <span className="flex flex-wrap items-center gap-1">
                            <span className="text-[10px] font-medium uppercase tracking-wide text-muted">
                              {t(`calendar.kind_${i.kind}`)}
                            </span>
                            {BigInt(i.amount) !== 0n && (
                              <Money amount={i.amount} currency={i.currency} signed />
                            )}
                            {i.status !== 'upcoming' && (
                              <span className={`chip ${i.status === 'paid' ? 'chip-good' : 'chip-bad'}`}>
                                {t(`calendar.status_${i.status}`)}
                              </span>
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
      {cal.items.length === 0 ? (
        <p className="text-sm text-muted">{t('calendar.empty')}</p>
      ) : (
        shown.length === 0 && <p className="text-sm text-muted">{t('calendar.empty_shown')}</p>
      )}
    </div>
  );
}

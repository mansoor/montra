'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { catalogs, createTranslator, type Translator } from '@montra/i18n';
import { makeFormatters, type Formatters } from '@/lib/format';

export interface I18n extends Formatters {
  t: Translator['t'];
}

function build(locale: string, dateFormat: string | null): I18n {
  const translator = createTranslator(locale, catalogs);
  return { ...makeFormatters(locale, dateFormat), t: translator.t };
}

const DEFAULT = build('en-US', null);
const Context = createContext<I18n>(DEFAULT);

/** Provides the signed-in user's locale and date format to client components (TZ-06, CUR-10). */
export function I18nProvider({
  locale,
  dateFormat,
  children,
}: {
  locale: string;
  dateFormat: string | null;
  children: ReactNode;
}) {
  const value = useMemo(() => build(locale, dateFormat), [locale, dateFormat]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export const useI18n = (): I18n => useContext(Context);

/** A calendar date in the user's format, with the ISO value for machines. */
export function DateText({ date }: { date: string }) {
  const { date: format } = useI18n();
  return <time dateTime={date}>{format(date)}</time>;
}

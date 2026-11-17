/**
 * Tax forms' shared pieces on the phone (ADR-0052 §7.2): a form's title and result in words and colour, and Review's
 * "Tax forms to check", read online like statements and bills to file. Each opens the form's own screen, where its
 * checks and actions are.
 */
import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import type { TaxFormDto } from '@montra/schemas';
import { fmtMoney, t } from '../i18n';
import { resultLabel, resultTone, showsTaxForms, titleOf, type Tone } from '../features/tax-forms';
import { useTaxFormsToCheck } from '../features/use-tax-forms';
import { useSession } from '../session/SessionProvider';
import { Body, Row, Small } from './components';
import { useTheme, type Theme } from './theme';

export const toneColor = (th: Theme, tone: Tone): string =>
  tone === 'good' ? th.success : tone === 'warn' ? th.warning : th.muted;

/** "W-2 from Acme Corp", "1099-INT", or a file's name until it's read. */
export function taxFormTitle(form: Pick<TaxFormDto, 'kind' | 'issuerName' | 'reading'>): string {
  const title = titleOf(form);
  if ('fileName' in title) return title.fileName || t('tax_forms.kind_unknown');
  const kind = t(title.kindKey);
  return title.issuer ? t('tax_forms.title_from', { kind, issuer: title.issuer }) : kind;
}

/** Matches the books · Differs by $412.50 · Not tracked in the books · Needs a match … */
export function resultText(form: Pick<TaxFormDto, 'result'>): string {
  const r = resultLabel(form.result);
  return r.amount === null ? t(r.key) : t(r.key, { amount: fmtMoney(r.amount, 'USD') });
}

export function TaxFormResult({ form }: { form: Pick<TaxFormDto, 'result'> }) {
  const th = useTheme();
  return <Small color={toneColor(th, resultTone(form.result.state))}>{resultText(form)}</Small>;
}

/**
 * Review's "Tax forms to check" (§7.2): forms that differ (and aren't accepted), wait for a match or a person, or
 * couldn't be read, each with why; tapping one opens it. Its count keeps the Review badge current.
 */
export function TaxFormReview() {
  const th = useTheme();
  const router = useRouter();
  const { state: session, api } = useSession();
  const badge = useTaxFormsToCheck();
  const ws = session.status === 'signed_in' ? session.workspace : null;
  const shown = ws !== null && showsTaxForms(ws);
  const wsId = ws?.id ?? '';
  const [forms, setForms] = useState<TaxFormDto[]>([]);
  const { set } = badge;

  useFocusEffect(
    useCallback(() => {
      if (!shown) return;
      let alive = true;
      api.taxFormsToCheck(wsId).then(
        (list) => {
          if (!alive) return;
          setForms(list);
          set(list.length);
        },
        // Offline: nothing to show; the badge keeps its last count.
        () => undefined,
      );
      return () => {
        alive = false;
      };
    }, [api, wsId, shown, set]),
  );

  if (!shown || forms.length === 0) return null;
  return (
    <View style={{ gap: th.space(1) }} testID="tax-form-review">
      <Body style={{ fontWeight: '700' }}>{t('tax_forms.review_title')}</Body>
      {forms.map((f, i) => (
        <Row
          key={f.id}
          testID="tax-form-review-item"
          title={`${taxFormTitle(f)} · ${f.taxYear}`}
          subtitle={t(`tax_forms.review_why.${f.result.state}`)}
          last={i === forms.length - 1}
          onPress={() => router.push(`/tax-forms/${f.id}`)}
        />
      ))}
    </View>
  );
}

/**
 * Tax forms on the phone (ADR-0052 §7.2, TAX-09): a year's forms expected against those received, grouped by person,
 * each with its result, read live and kept on the device for offline viewing like account details. Scan a form from
 * here (not the Add wheel: it's a once-a-year task). Typing a form in and "Won't come" are on the web.
 */
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { TaxFormDto, TaxYearDto } from '@montra/schemas';
import { fmtMoney, t } from '../../src/i18n';
import { localDay } from '../../src/features/statements';
import {
  anyReading,
  byPerson,
  defaultTaxYear,
  expectedTone,
  showsTaxForms,
  yearCacheName,
  yearChoices,
  yearSections,
} from '../../src/features/tax-forms';
import { useCached } from '../../src/features/use-cached';
import { useAbilities, useSession } from '../../src/session/SessionProvider';
import { useLocal } from '../../src/sync/SyncProvider';
import {
  Banner,
  Body,
  Button,
  Card,
  Disclaimer,
  Row,
  Screen,
  SectionLabel,
  Segmented,
  Small,
  Title,
} from '../../src/ui/components';
import { TaxFormResult, taxFormTitle, toneColor } from '../../src/ui/TaxForms';
import { useTheme } from '../../src/ui/theme';

export default function TaxForms() {
  const th = useTheme();
  const router = useRouter();
  const { state: session, api } = useSession();
  const can = useAbilities();
  const ws = session.status === 'signed_in' ? session.workspace : null;
  const shown = ws !== null && showsTaxForms(ws);
  const wsId = ws?.id ?? '';
  const today = localDay(new Date().toISOString());
  const params = useLocalSearchParams<{ year?: string }>();
  const [year, setYear] = useState(() => Number(params.year) || defaultTaxYear(today));
  const [refreshing, setRefreshing] = useState(false);
  const cached = useCached<TaxYearDto>(wsId, yearCacheName(year), () => api.taxYear(wsId, year), shown);
  const data = cached.data?.year === year ? cached.data : null;
  const { reload } = cached;

  // A form being read changes on the server; look again every few seconds until none is.
  const reading = data ? anyReading(data.forms) : false;
  useEffect(() => {
    if (!reading) return;
    const timer = setInterval(() => void reload(), 5000);
    return () => clearInterval(timer);
  }, [reading, reload]);

  const people = useLocal((s) => s.getReference('members'));
  const members = useMemo(() => new Map((people ?? []).map((m) => [m.id, m.name])), [people]);

  if (!shown)
    return (
      <Screen testID="tax-forms">
        <Card>
          <Body muted>
            {ws && ws.role === 'viewer' ? t('tax_forms.not_for_viewers') : t('tax_forms.us_only')}
          </Body>
        </Card>
      </Screen>
    );

  return (
    <Screen
      testID="tax-forms"
      refreshing={refreshing}
      onRefresh={() => {
        setRefreshing(true);
        void reload().finally(() => setRefreshing(false));
      }}
    >
      <Small>{t('tax_forms.subtitle')}</Small>
      <Segmented
        label={t('tax_forms.year_picker')}
        options={yearChoices(today, year).map((y) => ({ value: String(y), label: String(y) }))}
        value={String(year)}
        onChange={(v) => setYear(Number(v))}
      />
      {can.record ? (
        <Button
          icon="scan"
          label={t('mobile.tax_forms.scan')}
          disabled={cached.stale}
          onPress={() => router.push({ pathname: '/tax-forms/scan', params: { year: String(year) } })}
          testID="tax-forms-scan"
        />
      ) : null}
      {cached.stale ? (
        <Banner tone="warning" text={data ? t('mobile.tax_forms.offline') : t('mobile.plan.offline_empty')} />
      ) : null}
      {cached.error ? <Banner tone="danger" text={cached.error} /> : null}
      {data ? (
        <YearList data={data} names={members} onOpen={(f) => router.push(`/tax-forms/${f.id}`)} />
      ) : null}
      {data ? <Small>{t('mobile.tax_forms.more_on_web')}</Small> : null}
      {data ? <Disclaimer kind="tax" /> : null}
      {!data && !cached.stale && !cached.error ? <Body muted>…</Body> : null}
      <View style={{ height: th.space(2) }} />
    </Screen>
  );
}

function YearList({
  data,
  names,
  onOpen,
}: {
  data: TaxYearDto;
  names: ReadonlyMap<string, string>;
  onOpen: (form: TaxFormDto) => void;
}) {
  const th = useTheme();
  const forms = new Map(data.forms.map((f) => [f.id, f]));
  const { reading, unexpected } = yearSections(data);
  const groups = byPerson(data.expected, names);
  const waiverReason = (id: string | null) => data.waivers.find((w) => w.id === id)?.reason ?? 'other';
  return (
    <>
      {reading.length > 0 ? (
        <Card style={{ paddingVertical: 0, gap: 0 }} testID="tax-forms-reading">
          <SectionLabel>{t('tax_forms.being_read')}</SectionLabel>
          {reading.map((f, i) => (
            <Row
              key={f.id}
              title={taxFormTitle(f)}
              right={<TaxFormResult form={f} />}
              onPress={() => onOpen(f)}
              last={i === reading.length - 1}
              testID="tax-form-reading-row"
            />
          ))}
        </Card>
      ) : null}

      <Title>{t('tax_forms.expected_title')}</Title>
      <Small>{t('tax_forms.expected_intro')}</Small>
      {groups.length === 0 ? (
        <Card>
          <Body muted>{t('tax_forms.expected_none')}</Body>
        </Card>
      ) : (
        groups.map((g) => (
          <Card key={g.personMemberId ?? 'household'} style={{ paddingVertical: 0, gap: 0 }}>
            <SectionLabel>{g.name ?? t('tax_forms.household')}</SectionLabel>
            {g.items.map((e, i) => {
              const form = e.formId ? forms.get(e.formId) : undefined;
              const state =
                e.state === 'waived'
                  ? `${t('tax_forms.expected_state.waived')}: ${t(`tax_forms.waiver_reason.${waiverReason(e.waiverId)}`)}`
                  : t(`tax_forms.expected_state.${e.state}`);
              return (
                <Row
                  key={`${e.kind}:${e.employerId ?? e.accountId}`}
                  testID="tax-form-expected"
                  title={`${t(`tax_forms.kind.${e.kind}`)} · ${e.name}`}
                  subtitle={`${t(`tax_forms.expected_because.${e.kind}`)} ${fmtMoney(e.amount, 'USD')}`}
                  right={
                    <View style={{ alignItems: 'flex-end', gap: 2, maxWidth: '45%' }}>
                      <Small color={toneColor(th, expectedTone(e.state))}>{state}</Small>
                      {e.state === 'received' && form ? <TaxFormResult form={form} /> : null}
                    </View>
                  }
                  onPress={e.state === 'received' && form ? () => onOpen(form) : undefined}
                  last={i === g.items.length - 1}
                />
              );
            })}
          </Card>
        ))
      )}

      <Title>{t('tax_forms.unexpected_title')}</Title>
      {unexpected.length === 0 ? (
        <Small>{t('tax_forms.unexpected_none')}</Small>
      ) : (
        <Card style={{ paddingVertical: 0, gap: 0 }}>
          {unexpected.map((f, i) => (
            <Row
              key={f.id}
              testID="tax-form-received"
              title={taxFormTitle(f)}
              subtitle={f.personMemberId ? names.get(f.personMemberId) : undefined}
              right={<TaxFormResult form={f} />}
              onPress={() => onOpen(f)}
              last={i === unexpected.length - 1}
            />
          ))}
        </Card>
      )}
    </>
  );
}

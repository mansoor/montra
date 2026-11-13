/**
 * The mileage log on the phone (BIZ-07): logging a trip right after driving it is the case for having this here. Each trip
 * gets the IRS rate for its date from the server. Needs a connection, like budget writes. A trip has a driver (BIZ-19):
 * only the owner's are the deduction, and someone else's is reimbursed on the web.
 */
import { useCallback, useEffect, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { calendarDate } from '@montra/domain';
import type { MileageSummaryDto, PayrollPersonDto } from '@montra/schemas';
import { normalizeMiles } from '../../src/features/business';
import { fmtDate, fmtMoney, t } from '../../src/i18n';
import { useAbilities, useSession } from '../../src/session/SessionProvider';
import { Banner, Body, Button, Card, Field, Row, Screen, Segmented, Small } from '../../src/ui/components';
import { NotAllowed } from '../../src/ui/NotAllowed';

const todayLocal = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export default function Mileage() {
  const { entityId } = useLocalSearchParams<{ entityId: string }>();
  const { state: session, api } = useSession();
  const can = useAbilities();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const [summary, setSummary] = useState<MileageSummaryDto | null>(null);
  const [date, setDate] = useState(todayLocal);
  const [miles, setMiles] = useState('');
  const [purpose, setPurpose] = useState('');
  const [people, setPeople] = useState<PayrollPersonDto[]>([]);
  const [driver, setDriver] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSummary(await api.mileage(ws, entityId));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, ws, entityId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Drivers other than the owner. Payroll needs write access to the business; without it, only the owner's trips.
  useEffect(() => {
    if (!ws || !entityId) return;
    api.payrollPeople(ws, entityId).then(
      (list) => setPeople(list.filter((p) => !p.endDate)),
      () => setPeople([]),
    );
  }, [api, ws, entityId]);

  const add = async () => {
    const m = normalizeMiles(miles);
    if (!m) return setError(t('mileage.miles_hint'));
    if (!purpose.trim()) return setError(t('mobile.business.purpose_required'));
    setBusy(true);
    setError(null);
    try {
      const trip = await api.createMileageTrip(ws, {
        entityId,
        date: calendarDate(date.trim()),
        miles: m,
        purpose: purpose.trim(),
        driverPersonId: driver || null,
      });
      setNotice(t('mileage.added', { rate: trip.centsPerMile }));
      setMiles('');
      setPurpose('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!can.record || !can.writes(entityId))
    return (
      <Screen>
        <NotAllowed />
      </Screen>
    );
  return (
    <Screen testID="mileage">
      {error ? <Banner tone="danger" text={error} /> : null}
      {notice ? <Banner text={notice} /> : null}
      <Card>
        <Field label={t('mileage.date')} value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" />
        <Field
          label={t('mileage.miles')}
          value={miles}
          onChangeText={setMiles}
          keyboardType="decimal-pad"
          testID="mileage-miles"
        />
        <Field
          label={t('mileage.purpose')}
          value={purpose}
          onChangeText={setPurpose}
          testID="mileage-purpose"
        />
        {people.length > 0 ? (
          people.length <= 3 ? (
            <Segmented
              label={t('mileage.driver')}
              value={driver}
              options={[
                { value: '', label: t('mileage.driver_owner') },
                ...people.map((p) => ({ value: p.id, label: p.displayName })),
              ]}
              onChange={setDriver}
            />
          ) : (
            <>
              <Small>{t('mileage.driver')}</Small>
              {[{ id: '', displayName: t('mileage.driver_owner') }, ...people].map((p, i) => (
                <Row
                  key={p.id || 'owner'}
                  title={p.displayName}
                  right={p.id === driver ? <Small>✓</Small> : undefined}
                  last={i === people.length}
                  onPress={() => setDriver(p.id)}
                />
              ))}
            </>
          )
        ) : null}
        <Button label={t('mileage.add')} busy={busy} onPress={() => void add()} testID="mileage-add" />
        <Small>{t('mileage.deduction_note')}</Small>
        {driver ? <Small>{t('mileage.driver_note')}</Small> : null}
      </Card>
      {summary ? (
        <>
          <Card testID="mileage-totals">
            <Small>{t('mileage.total_miles', { year: summary.year })}</Small>
            <Body style={{ fontWeight: '700' }}>{summary.miles}</Body>
            <Small>{t('mileage.total_deduction', { year: summary.year })}</Small>
            <Body style={{ fontWeight: '700' }}>{fmtMoney(summary.deduction, summary.currency)}</Body>
          </Card>
          {summary.trips.map((r) => (
            <Row
              key={r.id}
              title={r.purpose}
              subtitle={[
                fmtDate(r.date),
                r.miles,
                t('mileage.cents', { rate: r.centsPerMile }),
                r.driver === 'person' ? r.driverName : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              right={<Small>{fmtMoney(r.deduction, summary.currency)}</Small>}
              testID="mileage-trip"
            />
          ))}
        </>
      ) : null}
    </Screen>
  );
}

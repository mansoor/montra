/**
 * Submitting a reimbursement from the phone (PRL-11, PRL-22): who paid, what for, how much, and a photo of the receipt.
 * Someone who can write to the business approves it on the web. Needs a connection; the photo is deleted from the phone
 * once it's uploaded.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Image, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as DocumentPicker from 'expo-document-picker';
import { calendarDate } from '@montra/domain';
import type { CategoryDto, PayrollPersonDto } from '@montra/schemas';
import { dollarsToMinor } from '../../src/features/payroll';
import { t } from '../../src/i18n';
import { removePage } from '../../src/receipts/files';
import { useAbilities, useSession } from '../../src/session/SessionProvider';
import { useLocal } from '../../src/sync/SyncProvider';
import { CategoryPicker } from '../../src/ui/CategoryPicker';
import { Banner, Body, Button, Card, Field, Row, Screen, Segmented, Small } from '../../src/ui/components';
import { NotAllowed } from '../../src/ui/NotAllowed';
import { useTheme } from '../../src/ui/theme';

type Photo = { uri: string; name: string; type: string; shot: boolean };

const todayLocal = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export default function Reimbursement() {
  const th = useTheme();
  const router = useRouter();
  const { entityId } = useLocalSearchParams<{ entityId: string }>();
  const { state: session, api } = useSession();
  const can = useAbilities();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const all = useLocal((s) => s.getReference('categories')) ?? [];
  const categories = useMemo(
    () => (all as CategoryDto[]).filter((c) => c.entityId === entityId && c.type === 'expense'),
    [all, entityId],
  );
  const [people, setPeople] = useState<PayrollPersonDto[] | null>(null);
  const [personId, setPersonId] = useState('');
  const [date, setDate] = useState(todayLocal);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<CategoryDto | null>(null);
  const [picking, setPicking] = useState(false);
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [camera, setCamera] = useState(false);
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.payrollPeople(ws, entityId).then(
      (list) => {
        const current = list.filter((p) => p.status !== 'ended');
        setPeople(current);
        setPersonId((id) => id || current[0]?.id || '');
      },
      (err: Error & { code?: string }) =>
        setError(err.code === 'payroll.no_access' ? t('payroll.no_access') : err.message),
    );
  }, [api, ws, entityId]);

  const shoot = async () => {
    if (!cameraRef.current) return;
    const pic = await cameraRef.current.takePictureAsync({ quality: 0.8, shutterSound: false });
    if (!pic) return;
    setPhoto({ uri: pic.uri, name: 'receipt.jpg', type: 'image/jpeg', shot: true });
    setCamera(false);
  };

  const pick = async () => {
    const r = await DocumentPicker.getDocumentAsync({
      type: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
      copyToCacheDirectory: true,
    });
    if (r.canceled || !r.assets[0]?.mimeType) return;
    const a = r.assets[0];
    setPhoto({ uri: a.uri, name: a.name, type: a.mimeType!, shot: false });
  };

  const submit = async () => {
    const minor = dollarsToMinor(amount);
    if (!personId) return setError(t('mobile.payroll.pick_person'));
    if (!minor) return setError(t('mobile.payroll.amount_hint'));
    if (!description.trim()) return setError(t('mobile.payroll.what_for'));
    if (!category) return setError(t('mobile.payroll.pick_category'));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) return setError(t('mobile.payroll.date_hint'));
    setBusy(true);
    setError(null);
    try {
      const fileIds: string[] = [];
      if (photo) {
        const f = await api.uploadReimbursementReceipt(ws, entityId, photo);
        fileIds.push(f.fileId);
      }
      await api.createReimbursement(ws, {
        entityId,
        personId,
        spentOn: calendarDate(date.trim()),
        description: description.trim(),
        amount: minor,
        expenseAccountId: category.id,
        fileIds,
      });
      if (photo?.shot) await removePage(photo.uri);
      router.back();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!can.setUp || !can.writes(entityId))
    return (
      <Screen>
        <NotAllowed />
      </Screen>
    );
  if (camera) {
    return (
      <Screen testID="reimbursement-camera">
        {permission?.granted ? (
          <>
            <View style={{ height: 420, borderRadius: th.radius, overflow: 'hidden' }}>
              <CameraView ref={cameraRef} style={{ flex: 1 }} facing="back" />
            </View>
            <Button
              label={t('mobile.receipts.shoot')}
              onPress={() => void shoot()}
              testID="reimbursement-shoot"
            />
          </>
        ) : (
          <>
            <Body>{t('mobile.payroll.camera_permission')}</Body>
            <Button label={t('mobile.common.retry')} onPress={() => void requestPermission()} />
          </>
        )}
        <Button kind="secondary" label={t('common.cancel')} onPress={() => setCamera(false)} />
      </Screen>
    );
  }

  return (
    <Screen testID="reimbursement">
      {error ? <Banner tone="danger" text={error} /> : null}
      <Small>{t('payroll.claim.hint')}</Small>
      {people && people.length > 0 ? (
        <Card>
          {people.length <= 4 ? (
            <Segmented
              label={t('payroll.claim.person')}
              value={personId}
              options={people.map((p) => ({ value: p.id, label: p.displayName }))}
              onChange={setPersonId}
            />
          ) : (
            people.map((p, i) => (
              <Row
                key={p.id}
                title={p.displayName}
                right={p.id === personId ? <Small>✓</Small> : undefined}
                last={i === people.length - 1}
                onPress={() => setPersonId(p.id)}
              />
            ))
          )}
          <Field
            label={t('payroll.claim.spent_on')}
            value={date}
            onChangeText={setDate}
            placeholder="YYYY-MM-DD"
          />
          <Field
            label={t('payroll.claim.amount')}
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            testID="reimbursement-amount"
          />
          <Field
            label={t('payroll.claim.description')}
            value={description}
            onChangeText={setDescription}
            maxLength={500}
            testID="reimbursement-description"
          />
          <Row
            title={category?.name ?? t('mobile.payroll.pick_category')}
            subtitle={t('payroll.claim.category')}
            onPress={() => setPicking(true)}
            last
          />
        </Card>
      ) : null}
      {people && people.length === 0 ? <Body muted>{t('mobile.payroll.nobody')}</Body> : null}
      {photo ? (
        <Card>
          {photo.type.startsWith('image/') ? (
            <Image
              source={{ uri: photo.uri }}
              accessibilityLabel={t('payroll.claim.receipt')}
              style={{ height: 220, borderRadius: th.radius }}
              resizeMode="contain"
            />
          ) : (
            <Body>{photo.name}</Body>
          )}
          <Button kind="secondary" label={t('payroll.remove')} onPress={() => setPhoto(null)} />
        </Card>
      ) : (
        <View style={{ gap: th.space(2) }}>
          <Button
            kind="secondary"
            icon="receipt"
            label={t('mobile.payroll.take_photo')}
            onPress={() => setCamera(true)}
          />
          <Button kind="secondary" label={t('mobile.receipts.pick')} onPress={() => void pick()} />
        </View>
      )}
      <Button
        label={t('payroll.claim.submit')}
        busy={busy}
        disabled={!people?.length}
        onPress={() => void submit()}
        testID="reimbursement-submit"
      />
      <CategoryPicker
        visible={picking}
        categories={categories}
        kind="expense"
        onPick={(c) => {
          setCategory(c);
          setPicking(false);
        }}
        onClose={() => setPicking(false)}
      />
    </Screen>
  );
}

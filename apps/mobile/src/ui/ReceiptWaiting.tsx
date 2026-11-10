/**
 * A purchase that's worth a receipt and has none (UP-09, RCP-11): what and when, why it's listed, Add (the camera,
 * linked to it) and Not needed (gone for good). Used by the Home card and the Receipts screen.
 */
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { ReceiptRecommendationDto } from '@montra/schemas';
import { fmtDate, fmtMoney, t } from '../i18n';
import { Body, Button, Small } from './components';
import { haptic } from './haptics';
import { Icon } from './icons';
import { useTheme } from './theme';

export function ReceiptWaitingRow({
  item,
  onDismiss,
  last,
}: {
  item: ReceiptRecommendationDto;
  onDismiss: (transactionId: string) => void;
  last?: boolean;
}) {
  const th = useTheme();
  const router = useRouter();
  return (
    <View
      testID="receipt-waiting"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: th.space(2),
        paddingVertical: th.space(1),
        borderBottomWidth: last ? 0 : 1,
        borderColor: th.border,
      }}
    >
      <View style={{ flex: 1 }}>
        <Body>{item.merchant || item.payee || '—'}</Body>
        <Small>
          {fmtDate(item.date)} · {fmtMoney(item.amount.amount, item.amount.currency)} ·{' '}
          {t(`mobile.receipts.reason.${item.reason}`)}
        </Small>
      </View>
      <Button
        kind="secondary"
        icon="scan"
        label={t('mobile.receipts.add')}
        onPress={() =>
          router.push({ pathname: '/receipt-capture', params: { transactionId: item.transactionId } })
        }
      />
      <Pressable
        onPress={() => {
          haptic.select();
          onDismiss(item.transactionId);
        }}
        accessibilityRole="button"
        accessibilityLabel={`${t('mobile.receipts.not_needed')}: ${item.merchant || item.payee || ''}`}
        hitSlop={6}
        style={{ minWidth: th.tap, minHeight: th.tap, alignItems: 'center', justifyContent: 'center' }}
      >
        <Icon name="close" size={18} color={th.muted} />
      </Pressable>
    </View>
  );
}

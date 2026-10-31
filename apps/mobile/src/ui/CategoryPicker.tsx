/** Category picker with type-ahead (used by review, quick add and the editor). Categories come from the offline store. */
import { useMemo, useState } from 'react';
import { FlatList, Modal, View } from 'react-native';
import type { CategoryDto } from '@montra/schemas';
import { t } from '../i18n';
import { Button, Field, Row, Small } from './components';
import { useTheme } from './theme';

export function CategoryPicker({
  visible,
  categories,
  kind,
  onPick,
  onClose,
}: {
  visible: boolean;
  categories: readonly CategoryDto[];
  /** Show income or expense categories first for the sign of the transaction. */
  kind?: 'income' | 'expense';
  onPick: (c: CategoryDto) => void;
  onClose: () => void;
}) {
  const th = useTheme();
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return [...categories]
      .filter((c) => !s || c.name.toLowerCase().includes(s) || (c.group ?? '').toLowerCase().includes(s))
      .sort((a, b) => Number(kind ? b.type === kind : 0) - Number(kind ? a.type === kind : 0));
  }, [categories, q, kind]);
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet">
      <View style={{ flex: 1, backgroundColor: th.bg, padding: th.space(4), gap: th.space(3) }}>
        <Field
          label={t('mobile.txn.category')}
          value={q}
          onChangeText={setQ}
          autoFocus
          testID="category-search"
        />
        <FlatList
          data={list}
          keyExtractor={(c) => c.id}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <Row
              title={item.name}
              subtitle={item.group ?? undefined}
              onPress={() => {
                setQ('');
                onPick(item);
              }}
              testID={`category-${item.name}`}
            />
          )}
          ListEmptyComponent={<Small>{t('mobile.txn.empty')}</Small>}
        />
        <Button kind="secondary" label={t('mobile.common.cancel')} onPress={onClose} />
      </View>
    </Modal>
  );
}

/**
 * Category picker with type-ahead (used by review, quick add and the editor). Categories come from the offline store.
 * "Add a category" at the bottom creates one on the server (ACC-11), waits for the sync to bring it, and picks it.
 */
import { useEffect, useMemo, useState } from 'react';
import { FlatList, Modal, ScrollView, View } from 'react-native';
import type { CategoryDto, CategoryGroupDto } from '@montra/schemas';
import { defaultEntityId, groupChoices, nameTaken, suggestedName } from '../features/categories';
import { t } from '../i18n';
import { useAbilities, useSession } from '../session/SessionProvider';
import { useLocal, useSync } from '../sync/SyncProvider';
import { Banner, Button, Field, Row, Segmented, Small, Title } from './components';
import { Icon } from './icons';
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
  const canAdd = useAbilities().setUp;
  const [adding, setAdding] = useState(false);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return [...categories]
      .filter((c) => !s || c.name.toLowerCase().includes(s) || (c.group ?? '').toLowerCase().includes(s))
      .sort((a, b) => Number(kind ? b.type === kind : 0) - Number(kind ? a.type === kind : 0));
  }, [categories, q, kind]);
  const close = () => {
    setAdding(false);
    onClose();
  };
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close} presentationStyle="pageSheet">
      <View style={{ flex: 1, backgroundColor: th.bg, padding: th.pad, gap: th.space(2) }}>
        {adding ? (
          <AddCategory
            initialName={suggestedName(q)}
            kind={kind ?? 'expense'}
            categories={categories}
            onAdded={(c) => {
              setAdding(false);
              setQ('');
              onPick(c);
            }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <>
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
              ListFooterComponent={
                // Adding a category is setting the books up: not for members (AUTH-18).
                !canAdd ? undefined : (
                  <Row
                    icon="add"
                    title={
                      q.trim()
                        ? t('mobile.categories.add_named', { name: suggestedName(q) })
                        : t('mobile.categories.add')
                    }
                    onPress={() => setAdding(true)}
                    testID="category-add"
                    last
                  />
                )
              }
            />
            <Button kind="secondary" label={t('mobile.common.cancel')} onPress={close} />
          </>
        )}
      </View>
    </Modal>
  );
}

/** The new category's name, kind, books and group. Needs a connection: the server makes it, then the sync brings it. */
function AddCategory({
  initialName,
  kind: initialKind,
  categories,
  onAdded,
  onCancel,
}: {
  initialName: string;
  kind: 'income' | 'expense';
  categories: readonly CategoryDto[];
  onAdded: (c: CategoryDto) => void;
  onCancel: () => void;
}) {
  const th = useTheme();
  const { state: session, api } = useSession();
  const { state: sync, refresh } = useSync();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const entities = useLocal((s) => s.getReference('entities')) ?? [];
  const [name, setName] = useState(initialName);
  const [kind, setKind] = useState(initialKind);
  const [entityId, setEntityId] = useState<string | null>(null);
  const [groups, setGroups] = useState<CategoryGroupDto[] | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const online = sync?.online !== false;
  const books = entityId ?? defaultEntityId(entities, categories);
  const entity = entities.find((e) => e.id === books);

  useEffect(() => {
    if (!books || !online) return;
    let live = true;
    setGroups(null);
    api.categoryGroups(ws, books).then(
      (g) => live && setGroups(g),
      (err: unknown) => live && setError((err as Error).message),
    );
    return () => {
      live = false;
    };
  }, [api, ws, books, online]);

  const choices = groups && entity ? groupChoices(groups, entity.type, kind) : [];
  const group = choices.find((g) => g.id === groupId) ?? choices[0];
  const taken = books ? nameTaken(categories, books, kind, name) : false;

  const save = async () => {
    if (!books || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createCategory(ws, {
        entityId: books,
        name: name.trim(),
        type: kind,
        groupId: group?.id,
      });
      // Bring it into the offline store, so it shows in every picker from now on.
      await refresh();
      onAdded(created);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ gap: th.space(3), paddingBottom: th.space(6) }}
      keyboardShouldPersistTaps="handled"
      testID="category-add-form"
    >
      <Title>{t('mobile.categories.add_title')}</Title>
      {!online ? <Banner tone="warning" text={t('mobile.categories.offline')} /> : null}
      <Field
        label={t('mobile.categories.name')}
        value={name}
        onChangeText={setName}
        autoFocus
        maxLength={80}
        testID="category-new-name"
      />
      {taken ? <Small color={th.warning}>{t('mobile.categories.taken')}</Small> : null}
      <Segmented
        label={t('mobile.categories.kind')}
        value={kind}
        onChange={(k) => {
          setKind(k);
          setGroupId(null);
        }}
        options={[
          { value: 'expense', label: t('mobile.categories.kind_expense') },
          { value: 'income', label: t('mobile.categories.kind_income') },
        ]}
      />
      {entities.length > 1 ? (
        <View>
          <Small>{t('mobile.categories.books')}</Small>
          {entities.map((e) => (
            <Row
              key={e.id}
              title={e.name}
              right={e.id === books ? <Icon name="check" size={18} color={th.primary} /> : undefined}
              onPress={() => {
                setEntityId(e.id);
                setGroupId(null);
              }}
            />
          ))}
        </View>
      ) : null}
      {choices.length > 1 ? (
        <View>
          <Small>{t('mobile.categories.group')}</Small>
          {choices.map((g) => (
            <Row
              key={g.id}
              title={g.name}
              right={g.id === group?.id ? <Icon name="check" size={18} color={th.primary} /> : undefined}
              onPress={() => setGroupId(g.id)}
            />
          ))}
        </View>
      ) : null}
      {error ? <Banner tone="danger" text={error} /> : null}
      <Button
        label={t('mobile.categories.save')}
        busy={busy}
        disabled={!online || !books || !name.trim() || taken}
        onPress={() => void save()}
        testID="category-new-save"
      />
      <Button kind="secondary" label={t('mobile.common.cancel')} onPress={onCancel} />
    </ScrollView>
  );
}

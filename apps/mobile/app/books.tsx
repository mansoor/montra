/**
 * Books and entities (OPS-13; ACC-01, BIZ-01, FLOW-05), as on the web's Settings → Entities: add business or rental
 * books, rename and archive them, and pick each book's colour on the calendar. Owners and admins change them, as the API
 * allows; everyone else sees the list. The personal books take only a colour. The plan may not include more books, and
 * the API says so. Closing and reopening a period (DE-09) stays on the web.
 */
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { fmtDate, t } from '../src/i18n';
import type { EntityDetailDto } from '../src/api/client';
import {
  NEW_BOOK_TYPES,
  archiveBooks,
  colorChoices,
  colorChosen,
  errorText,
  newBooks,
  renameBooks,
  settingsAbilities,
  type NewBookType,
} from '../src/features/settings-edit';
import { useSession } from '../src/session/SessionProvider';
import {
  Banner,
  Body,
  Button,
  Card,
  Chips,
  Field,
  Screen,
  SectionLabel,
  Segmented,
  Small,
  useToast,
} from '../src/ui/components';
import { haptic } from '../src/ui/haptics';
import { useTheme } from '../src/ui/theme';

type Run = (fn: () => Promise<unknown>, done: string) => Promise<boolean>;

export default function Books() {
  const session = useSession();
  const { state, api } = session;
  const ws = state.status === 'signed_in' ? state.workspace.id : '';
  const role = state.status === 'signed_in' ? state.workspace.role : 'viewer';
  const canEdit = settingsAbilities(role).books;
  const toast = useToast();
  const [books, setBooks] = useState<EntityDetailDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState<NewBookType>('business');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!ws) return;
    try {
      setBooks(await api.entities(ws));
    } catch (err) {
      setError(errorText(err, t));
    }
  }, [api, ws]);
  useEffect(() => {
    void reload();
  }, [reload]);

  /** Runs one change, says how it went, and reads the books again here and in the session (pickers, calendar). */
  const run: Run = async (fn, done) => {
    setError(null);
    try {
      await fn();
      haptic.success();
      toast.show(done);
      await reload();
      void session.refresh();
      return true;
    } catch (err) {
      setError(errorText(err, t));
      return false;
    }
  };

  const add = async () => {
    const built = newBooks(type, name);
    if (!built.ok) return setError(t(built.error));
    setBusy(true);
    const ok = await run(
      () => api.createEntity(ws, built.value),
      t('entities.added', { name: built.value.name }),
    );
    setBusy(false);
    if (ok) setName('');
  };

  return (
    <Screen testID="books">
      {error ? <Banner tone="danger" text={error} /> : null}
      {!canEdit ? <Small>{t('mobile.settings.books_read_only')}</Small> : null}
      {(books ?? []).map((b) =>
        canEdit ? (
          <BookCard key={b.id} book={b} all={books ?? []} ws={ws} run={run} />
        ) : (
          <Card key={b.id} testID="books-item">
            <Body>{b.name}</Body>
            <BookLine book={b} />
          </Card>
        ),
      )}
      {canEdit ? (
        <Card testID="books-add">
          <SectionLabel>{t('entities.add_books')}</SectionLabel>
          <Segmented
            label={t('entities.add')}
            value={type}
            onChange={setType}
            options={NEW_BOOK_TYPES.map((v) => ({ value: v, label: t(`entity.type.${v}`) }))}
          />
          <Field
            label={t('fields.name')}
            value={name}
            onChangeText={setName}
            maxLength={200}
            testID="books-add-name"
          />
          <Button
            label={t('entities.add_books')}
            busy={busy}
            disabled={!name.trim()}
            onPress={() => void add()}
            testID="books-add-save"
          />
        </Card>
      ) : null}
    </Screen>
  );
}

/** Type, currency, archived, and whether the books are closed (DE-09, changed on the web). */
function BookLine({ book }: { book: EntityDetailDto }) {
  return (
    <Small>
      {[
        t(`entity.type.${book.type}`),
        book.functionalCurrency,
        book.archived ? t('common.archived') : null,
        book.lockedThrough
          ? t('entities.closed_through', { date: fmtDate(book.lockedThrough) })
          : t('entities.open'),
      ]
        .filter(Boolean)
        .join(' · ')}
    </Small>
  );
}

function BookCard({
  book,
  all,
  ws,
  run,
}: {
  book: EntityDetailDto;
  all: EntityDetailDto[];
  ws: string;
  run: Run;
}) {
  const th = useTheme();
  const { api } = useSession();
  const [name, setName] = useState(book.name);
  const [busy, setBusy] = useState(false);
  const rename = renameBooks(book, name);
  const archive = archiveBooks(book);
  const colors = colorChoices(all, book);
  const chosen = colorChosen(book);

  const go = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    await run(fn, done);
    setBusy(false);
  };

  return (
    <Card testID="books-item">
      {book.type === 'personal' ? <Body>{book.name}</Body> : null}
      <BookLine book={book} />
      {book.type !== 'personal' ? (
        <>
          <Field
            label={t('fields.name')}
            value={name}
            onChangeText={setName}
            maxLength={200}
            testID={`books-name-${book.id}`}
          />
          <View style={{ flexDirection: 'row', gap: th.space(2) }}>
            <View style={{ flex: 1 }}>
              <Button
                kind="secondary"
                label={t('common.rename')}
                busy={busy}
                disabled={!rename}
                onPress={() =>
                  rename && void go(() => api.updateEntity(ws, book.id, rename), t('common.renamed'))
                }
                testID={`books-rename-${book.id}`}
              />
            </View>
            {archive ? (
              <View style={{ flex: 1 }}>
                <Button
                  kind="secondary"
                  label={t(archive.label)}
                  busy={busy}
                  onPress={() => void go(() => api.updateEntity(ws, book.id, archive.patch), t(archive.done))}
                  testID={`books-archive-${book.id}`}
                />
              </View>
            ) : null}
          </View>
        </>
      ) : null}
      <Small>{t('entities.color')}</Small>
      <Chips
        label={t('entities.color')}
        disabled={busy}
        value={chosen ?? 'auto'}
        options={colors.map((c) => ({
          value: c.value ?? 'auto',
          label: c.labelKey ? t(c.labelKey) : (c.label ?? ''),
          swatch: c.hex,
        }))}
        onChange={(v) => {
          const color = v === 'auto' ? null : v;
          if (color === chosen) return;
          void go(() => api.updateEntity(ws, book.id, { color }), t('entities.color_saved'));
        }}
        testID={`books-color-${book.id}`}
      />
    </Card>
  );
}

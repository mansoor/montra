'use client';

import { useCallback, useEffect, useState } from 'react';
import type { PhoneStatusDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage } from '@/lib/errors';
import { ErrorWithAction } from '../field';
import { useI18n } from '../i18n';
import { useConfirm } from '../ui/confirm-dialog';

/**
 * The mobile number (ADR-0049 §6), confirmed by a code the API texts: Kratos's own texted code can't be entered, as
 * its settings flow never names the verification flow the code belongs to. Adding, changing and removing it need a
 * recent sign-in; the error offers the way to give one.
 */
export function PhoneNumber() {
  const { t } = useI18n();
  const { confirm, dialog } = useConfirm();
  const [status, setStatus] = useState<PhoneStatusDto | null>(null);
  const [number, setNumber] = useState('');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await browserApi.getPhone();
      setStatus(s);
      setSentTo(s.pending?.phone ?? null);
    } catch (err) {
      setError(err);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!status) return error ? <ErrorWithAction message={friendlyMessage(error, t)} error={error} /> : null;

  return (
    <div className="space-y-3" data-testid="phone-number">
      <p className="text-sm">
        {status.phone
          ? t(status.verified ? 'phone.current_verified' : 'phone.current_unverified', {
              phone: status.phone,
            })
          : t('phone.none')}
      </p>
      {note && (
        <p role="status" className="text-sm text-good">
          {note}
        </p>
      )}
      {error ? <ErrorWithAction message={friendlyMessage(error, t)} error={error} /> : null}

      {sentTo ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const s = await browserApi.confirmPhone(code.trim());
              setStatus(s);
              setSentTo(null);
              setCode('');
              setNumber('');
              setNote(t('phone.confirmed'));
            });
          }}
        >
          <p className="text-sm text-muted">{t('phone.sent', { phone: sentTo })}</p>
          <label className="block text-sm">
            {t('phone.code')}
            <input
              className="input mt-1 block w-40"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="btn-primary" disabled={busy || code.trim().length !== 6}>
              {t('phone.confirm')}
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setSentTo(null)}>
              {t('phone.change')}
            </button>
          </div>
        </form>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const sent = await browserApi.startPhoneVerification(number);
              setSentTo(sent.phone);
            });
          }}
        >
          <label className="block text-sm">
            {t('phone.title')}
            <input
              className="input mt-1 block w-64"
              type="tel"
              autoComplete="tel"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="+1 415 555 0123"
              required
            />
          </label>
          <p className="text-xs text-muted">{t('phone.hint')}</p>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="btn-primary" disabled={busy || !number.trim()}>
              {t('phone.send')}
            </button>
            {status.phone && (
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const ok = await confirm({
                      title: t('phone.remove_title'),
                      body: <p>{t('phone.remove_confirm')}</p>,
                      confirmLabel: t('phone.remove'),
                      danger: true,
                    });
                    if (!ok) return;
                    setStatus(await browserApi.removePhone());
                    setNote(t('phone.removed'));
                  })
                }
              >
                {t('phone.remove')}
              </button>
            )}
          </div>
        </form>
      )}
      {dialog}
    </div>
  );
}

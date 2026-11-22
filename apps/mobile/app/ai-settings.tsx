/**
 * Where AI runs (OPS-13; UP-13, UP-06), as on the web's Settings → AI: each mode with its privacy disclosure next to
 * it. Owners and admins change it; everyone else sees it. A mode that needs a key, a model server's URL or Azure's
 * deployment is offered once that has been entered on the web (typing keys on a phone is left to the web), checked as the
 * web checks before saving. The review thresholds, budget and document choices stay on the web.
 */
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import type { AiMode, AiSettingsDto } from '@montra/schemas';
import {
  AI_MODES,
  aiModeBlocked,
  aiModeRequest,
  errorText,
  settingsAbilities,
} from '../src/features/settings-edit';
import { t } from '../src/i18n';
import { useSession } from '../src/session/SessionProvider';
import { Banner, Body, Card, Screen, Small, useToast } from '../src/ui/components';
import { haptic } from '../src/ui/haptics';
import { useTheme } from '../src/ui/theme';

export default function AiSettings() {
  const th = useTheme();
  const { state, api } = useSession();
  const ws = state.status === 'signed_in' ? state.workspace.id : '';
  const role = state.status === 'signed_in' ? state.workspace.role : 'viewer';
  const canEdit = settingsAbilities(role).ai;
  const toast = useToast();
  const [settings, setSettings] = useState<AiSettingsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<AiMode | null>(null);

  useEffect(() => {
    if (!ws) return;
    api.aiSettings(ws).then(setSettings, (err: unknown) => setError(errorText(err, t)));
  }, [api, ws]);

  const choose = async (mode: AiMode) => {
    if (!settings || mode === settings.mode || saving) return;
    setSaving(mode);
    setError(null);
    try {
      setSettings(await api.updateAiSettings(ws, aiModeRequest(mode)));
      haptic.success();
      toast.show(t('ai.saved'));
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setSaving(null);
    }
  };

  return (
    <Screen testID="ai-settings">
      {error ? <Banner tone="danger" text={error} /> : null}
      {settings?.problem ? <Banner tone="warning" text={t('mobile.settings.ai_problem')} /> : null}
      {!canEdit ? <Small>{t('ai.owner_only')}</Small> : null}
      {settings ? (
        <View accessibilityRole="radiogroup" accessibilityLabel={t('ai.mode')} style={{ gap: th.space(2) }}>
          {AI_MODES.map((m) => {
            const on = settings.mode === m;
            const blocked = on ? null : aiModeBlocked(m, settings);
            const disabled = !canEdit || Boolean(blocked) || saving !== null;
            const disclosure = settings.disclosures.find((d) => d.mode === m);
            return (
              <Pressable
                key={m}
                onPress={() => void choose(m)}
                disabled={disabled}
                accessibilityRole="radio"
                accessibilityState={{ checked: on, disabled, busy: saving === m }}
                accessibilityLabel={t(`ai.mode.${m}`)}
                accessibilityHint={blocked ? t('mobile.settings.ai_set_up_on_web') : t(`ai.mode_hint.${m}`)}
                testID={`ai-mode-${m}`}
              >
                <Card
                  style={{
                    borderWidth: 2,
                    borderColor: on ? th.primary : 'transparent',
                    opacity: blocked || (!canEdit && !on) ? 0.6 : 1,
                  }}
                >
                  <Body style={{ fontWeight: '600' }}>{t(`ai.mode.${m}`)}</Body>
                  <Small>{t(`ai.mode_hint.${m}`)}</Small>
                  {disclosure ? (
                    <View testID={`ai-disclosure-${m}`} style={{ gap: th.space(1) }}>
                      <Small color={th.text}>{disclosure.title}</Small>
                      {disclosure.points.map((p) => (
                        <Small key={p}>{`• ${p}`}</Small>
                      ))}
                    </View>
                  ) : null}
                  {blocked && canEdit ? (
                    <Small color={th.warning}>
                      {`${t(blocked)} ${t('mobile.settings.ai_set_up_on_web')}`}
                    </Small>
                  ) : null}
                </Card>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      <Small>{t('mobile.settings.ai_more_on_web')}</Small>
    </Screen>
  );
}

import Link from 'next/link';
import type { BusinessProfileDto } from '@montra/api-client';
import { getI18n } from '@/lib/i18n-server';

/** BIZ-21: the entity type and the federal return it files, on Overview and Taxes, linking to where they're set. */
export async function EntityTypeLine({
  workspaceId,
  profile,
}: {
  workspaceId: string;
  profile: BusinessProfileDto;
}) {
  const { t } = await getI18n();
  const settings = `/w/${workspaceId}/business/${profile.entityId}/settings#legal`;
  return (
    <p className="text-sm text-muted" data-testid="entity-type">
      {profile.businessType ? (
        <>
          {t(`setup.type.${profile.businessType}`)}
          {' · '}
          {profile.returnForm
            ? t('setup.files', { form: t(`setup.form.${profile.returnForm}`) })
            : t('setup.form_unknown')}
        </>
      ) : (
        t('setup.type_unset_line')
      )}{' '}
      <Link href={settings} className="underline">
        {t('setup.change')}
      </Link>
    </p>
  );
}

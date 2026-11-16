'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { AccountDto } from '@montra/api-client';
import type { BillerDto, IntakeDto } from '@montra/schemas';
import { browserApi } from '@/lib/browser-api';
import { useI18n } from '../i18n';
import { IntakeCard } from '../intakes/intake-card';

/**
 * Statements and bills that couldn't be filed automatically (ADR-0051 §5), above the transactions to review. Picking
 * the account or biller finishes one and teaches the match memory; a statement then opens in its import preview.
 */
export function DocumentQueue({
  workspaceId,
  role,
  accounts,
}: {
  workspaceId: string;
  role: string | undefined;
  accounts: AccountDto[];
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [items, setItems] = useState<IntakeDto[]>([]);
  const [billers, setBillers] = useState<BillerDto[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const open = await browserApi.listIntakes(workspaceId).catch(() => [] as IntakeDto[]);
    setItems(open);
    if (open.some((i) => i.kind === 'bill'))
      setBillers(await browserApi.listBillers(workspaceId).catch(() => [] as BillerDto[]));
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (items.length === 0 && !notice) return null;
  return (
    <section className="space-y-3" aria-labelledby="intakes-heading" data-testid="document-queue">
      <div>
        <h2 id="intakes-heading" className="text-base font-semibold">
          {t('intakes.title_review')}
        </h2>
        <p className="text-sm text-muted">{t('intakes.review_intro', { count: 3 })}</p>
      </div>
      {notice && (
        <p role="status" className="text-sm text-good">
          {notice}
        </p>
      )}
      <ul className="space-y-3">
        {items.map((i) => (
          <IntakeCard
            key={i.id}
            workspaceId={workspaceId}
            role={role}
            intake={i}
            accounts={accounts.filter((a) => a.type === 'asset' || a.type === 'liability')}
            billers={billers}
            onDone={(done) => {
              setItems((list) => list.filter((x) => x.id !== done.id));
              if (done.kind === 'statement' && done.status === 'done' && done.importBatchId)
                router.push(`/w/${workspaceId}/imports/${done.importBatchId}`);
              else
                setNotice(
                  done.status === 'dismissed'
                    ? t('intakes.dismissed')
                    : t('intakes.filed', { name: done.targetName ?? '' }),
                );
            }}
          />
        ))}
      </ul>
    </section>
  );
}

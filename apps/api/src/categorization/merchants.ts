import { Injectable } from '@nestjs/common';
import type { Trx } from '@montra/db';
import { matchMerchant, type MerchantRef } from '@montra/importers';
import type { MerchantDto } from '@montra/schemas';

interface Entry extends MerchantRef {
  mcc: string | null;
  logoUrl: string | null;
}

const TTL_MS = 10 * 60_000;

/** Reference merchants (OPS-05) cached in memory for enrichment (AI-07) and category hints. */
@Injectable()
export class MerchantDirectory {
  private cache: { at: number; list: Entry[]; byKey: Map<string, MerchantDto | null> } | null = null;

  async load(trx: Trx) {
    if (!this.cache || Date.now() - this.cache.at > TTL_MS) {
      const rows = await trx
        .selectFrom('ref.merchant')
        .select(['id', 'display_name', 'match_key', 'category_hint', 'mcc', 'logo_url'])
        .execute();
      this.cache = {
        at: Date.now(),
        list: rows.map((m) => ({
          id: m.id,
          displayName: m.display_name,
          matchKey: m.match_key,
          categoryHint: m.category_hint,
          mcc: m.mcc,
          logoUrl: m.logo_url,
        })),
        byKey: new Map(),
      };
    }
    const c = this.cache;
    return {
      list: c.list as readonly MerchantRef[],
      match: (key: string): Entry | null => (key ? (matchMerchant(key, c.list) as Entry | null) : null),
      lookup: (key: string): MerchantDto | null => {
        if (c.byKey.has(key)) return c.byKey.get(key)!;
        const m = matchMerchant(key, c.list) as Entry | null;
        const dto = m ? { name: m.displayName, mcc: m.mcc, logoUrl: m.logoUrl } : null;
        if (c.byKey.size < 50_000) c.byKey.set(key, dto);
        return dto;
      },
    };
  }
}

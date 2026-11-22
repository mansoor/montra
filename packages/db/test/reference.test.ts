import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadReferenceData } from '../src/reference/load.js';
import { MERCHANTS } from '../src/reference/merchants.js';
import { US_MILEAGE_RATES, US_TAX_LINES } from '../src/reference/tax.js';
import { ADMIN_URL } from './env.js';

// OPS-05: the loader runs on every deploy. It puts shipped content back, except on rows staff saved in the console.
let client: pg.Client;

beforeAll(async () => {
  client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  await loadReferenceData(ADMIN_URL);
});
afterAll(() => client.end());

const one = async (text: string, values: unknown[]) => (await client.query(text, values)).rows[0];

describe('reference data loader (OPS-05)', () => {
  const merchant = MERCHANTS[0]!;
  const otherMerchant = MERCHANTS[1]!;
  const line = US_TAX_LINES[0]!;
  const otherLine = US_TAX_LINES[1]!;
  const rate = US_MILEAGE_RATES[0]!;
  const otherRate = US_MILEAGE_RATES[1]!;

  it('keeps what staff saved through a deploy, and restores rows nobody saved', async () => {
    // Saved in the console (the API sets staff_edited_at).
    await client.query(
      `update ref.merchant set display_name = 'Staff name', staff_edited_at = now() where id = $1`,
      [merchant.id],
    );
    await client.query(
      `update ref.tax_line set label = 'Staff label', deductible_bps = 2500, staff_edited_at = now()
        where country = 'US' and code = $1`,
      [line.code],
    );
    await client.query(
      `update ref.mileage_rate set tenths_of_cent = 999, staff_edited_at = now()
        where country = 'US' and effective_from = $1`,
      [rate.effectiveFrom],
    );
    // Changed some other way (by hand, say): the shipped content comes back.
    await client.query(`update ref.merchant set display_name = 'Drifted' where id = $1`, [otherMerchant.id]);
    await client.query(`update ref.tax_line set label = 'Drifted' where country = 'US' and code = $1`, [
      otherLine.code,
    ]);
    await client.query(
      `update ref.mileage_rate set tenths_of_cent = 1 where country = 'US' and effective_from = $1`,
      [otherRate.effectiveFrom],
    );

    await loadReferenceData(ADMIN_URL);

    expect(await one(`select display_name from ref.merchant where id = $1`, [merchant.id])).toEqual({
      display_name: 'Staff name',
    });
    expect(
      await one(`select label, deductible_bps from ref.tax_line where country = 'US' and code = $1`, [
        line.code,
      ]),
    ).toEqual({ label: 'Staff label', deductible_bps: 2500 });
    expect(
      await one(`select tenths_of_cent from ref.mileage_rate where country = 'US' and effective_from = $1`, [
        rate.effectiveFrom,
      ]),
    ).toEqual({ tenths_of_cent: 999 });

    expect(await one(`select display_name from ref.merchant where id = $1`, [otherMerchant.id])).toEqual({
      display_name: otherMerchant.name,
    });
    expect(
      await one(`select label from ref.tax_line where country = 'US' and code = $1`, [otherLine.code]),
    ).toEqual({ label: otherLine.label });
    expect(
      await one(`select tenths_of_cent from ref.mileage_rate where country = 'US' and effective_from = $1`, [
        otherRate.effectiveFrom,
      ]),
    ).toEqual({ tenths_of_cent: otherRate.tenthsOfCent });

    // Clearing the mark hands the row back to the shipped data.
    await client.query(`update ref.merchant set staff_edited_at = null where id = $1`, [merchant.id]);
    await loadReferenceData(ADMIN_URL);
    expect(await one(`select display_name from ref.merchant where id = $1`, [merchant.id])).toEqual({
      display_name: merchant.name,
    });
  });

  it('skips a shipped merchant whose match text a staff-saved merchant holds, rather than failing the deploy', async () => {
    const shipped = MERCHANTS[2]!;
    await client.query(`delete from ref.merchant where id = $1`, [shipped.id]);
    await client.query(
      `insert into ref.merchant (id, display_name, match_key, category_hint, staff_edited_at)
       values ('staff-made', 'Staff made', $1, null, now())`,
      [shipped.key],
    );
    await expect(loadReferenceData(ADMIN_URL)).resolves.toMatchObject({ merchants: MERCHANTS.length });
    expect(
      (await client.query(`select id from ref.merchant where match_key = $1`, [shipped.key])).rows,
    ).toEqual([{ id: 'staff-made' }]);
    // Once staff remove theirs, the next deploy brings the shipped one back.
    await client.query(`delete from ref.merchant where id = 'staff-made'`);
    await loadReferenceData(ADMIN_URL);
    expect(await one(`select id from ref.merchant where match_key = $1`, [shipped.key])).toEqual({
      id: shipped.id,
    });
  });
});

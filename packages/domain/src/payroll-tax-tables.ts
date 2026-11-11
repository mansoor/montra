/**
 * Yearly payroll tax tables (ADR-0034 §7). Each year is transcribed from the agencies' publications and checked by the
 * tests against their worked examples; a new year is a reviewed change here, not data loaded at run time.
 *
 * - Federal: IRS Publication 15-T (2026), "Percentage Method Tables for Automated Payroll Systems" (annual), and
 *   Worksheet 1A line 1g. Social Security wage base: SSA, announced 2025-10-24.
 * - California: EDD "California Withholding Schedules for 2026", Method B, tables 1–4 and the annual, semi-monthly,
 *   monthly and biweekly rate tables (5–7, 17–22, 26–28); EDD 2026 rates for SDI, UI and ETT.
 */

/** A row of a percentage-method table: over `over`, the tax is `base` plus `rate` (ppm) of the excess. */
export interface TaxBracket {
  over: bigint;
  base: bigint;
  rate: bigint;
}

type Column = 'single' | 'married01' | 'married2' | 'headOfHousehold';

/** One payroll period's Method B tables. */
export interface CaPeriodTables {
  lowIncome: Record<Column, bigint>;
  standardDeduction: Record<Column, bigint>;
  /** Table 2, for 1 to 10 additional allowances. */
  estimatedDeduction: readonly bigint[];
  /** Table 4, for 1 to 10 allowances. */
  exemptionAllowance: readonly bigint[];
  rates: Record<'single' | 'married' | 'head_of_household', readonly TaxBracket[]>;
}

export interface PayrollTaxYear {
  year: number;
  federal: {
    standard: Record<'single' | 'married_jointly' | 'head_of_household', readonly TaxBracket[]>;
    step2: Record<'single' | 'married_jointly' | 'head_of_household', readonly TaxBracket[]>;
    line1gMarried: bigint;
    line1gOther: bigint;
  };
  fica: {
    ssRate: bigint;
    ssWageBase: bigint;
    medicareRate: bigint;
    addlMedicareRate: bigint;
    addlMedicareThreshold: bigint;
  };
  futa: {
    wageBase: bigint;
    /** 6.0% less the full 5.4% credit. */
    netRate: bigint;
    /** Credit reductions by state (Form 940 Schedule A). `provisional` until the Department of Labor's final list. */
    creditReduction: Record<string, { rate: bigint; provisional: boolean }>;
  };
  california: {
    periods: Record<'biweekly' | 'semimonthly' | 'monthly' | 'annual', CaPeriodTables>;
    sdiRate: bigint;
    /** Null: no wage limit. */
    sdiWageLimit: bigint | null;
    uiWageBase: bigint;
    ettRate: bigint;
    /** The rate a new employer pays until the EDD assigns one. */
    newEmployerUiRate: bigint;
  };
}

/** "206583.50" → 20658350n. Strings, so no float ever holds money. */
function usd(s: string): bigint {
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole!) * 100n + BigInt((frac + '00').slice(0, 2));
}

/** A percent as parts per million: "10.23" → 102300n. */
function pct(s: string): bigint {
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole!) * 10_000n + BigInt((frac + '0000').slice(0, 4));
}

/** Rows as [over, base, percent]. */
const table = (rows: readonly (readonly [string, string, string])[]): TaxBracket[] =>
  rows.map(([over, base, rate]) => ({ over: usd(over), base: usd(base), rate: pct(rate) }));

const FEDERAL_RATES = ['0', '10', '12', '22', '24', '32', '35', '37'] as const;
const federal = (rows: readonly (readonly [string, string])[]): TaxBracket[] =>
  table(rows.map(([over, base], i) => [over, base, FEDERAL_RATES[i]!] as const));

const CA_RATES = ['1.1', '2.2', '4.4', '6.6', '8.8', '10.23', '11.33', '12.43', '13.53', '14.63'] as const;
const ca = (rows: readonly (readonly [string, string])[]): TaxBracket[] =>
  table(rows.map(([over, base], i) => [over, base, CA_RATES[i]!] as const));

const columns = (single: string, married2: string): Record<Column, bigint> => ({
  single: usd(single),
  married01: usd(single),
  married2: usd(married2),
  headOfHousehold: usd(married2),
});

const amounts = (list: string): bigint[] => list.split(' ').map(usd);

const Y2026: PayrollTaxYear = {
  year: 2026,
  federal: {
    standard: {
      married_jointly: federal([
        ['0', '0'],
        ['19300', '0'],
        ['44100', '2480'],
        ['120100', '11600'],
        ['230700', '35932'],
        ['422850', '82048'],
        ['531750', '116896'],
        ['788000', '206583.50'],
      ]),
      single: federal([
        ['0', '0'],
        ['7500', '0'],
        ['19900', '1240'],
        ['57900', '5800'],
        ['113200', '17966'],
        ['209275', '41024'],
        ['263725', '58448'],
        ['648100', '192979.25'],
      ]),
      head_of_household: federal([
        ['0', '0'],
        ['15550', '0'],
        ['33250', '1770'],
        ['83000', '7740'],
        ['121250', '16155'],
        ['217300', '39207'],
        ['271750', '56631'],
        ['656150', '191171'],
      ]),
    },
    step2: {
      married_jointly: federal([
        ['0', '0'],
        ['16100', '0'],
        ['28500', '1240'],
        ['66500', '5800'],
        ['121800', '17966'],
        ['217875', '41024'],
        ['272325', '58448'],
        ['400450', '103291.75'],
      ]),
      single: federal([
        ['0', '0'],
        ['8050', '0'],
        ['14250', '620'],
        ['33250', '2900'],
        ['60900', '8983'],
        ['108938', '20512'],
        ['136163', '29224'],
        ['328350', '96489.63'],
      ]),
      head_of_household: federal([
        ['0', '0'],
        ['12075', '0'],
        ['20925', '885'],
        ['45800', '3870'],
        ['64925', '8077.50'],
        ['112950', '19603.50'],
        ['140175', '28315.50'],
        ['332375', '95585.50'],
      ]),
    },
    line1gMarried: usd('12900'),
    line1gOther: usd('8600'),
  },
  fica: {
    ssRate: pct('6.2'),
    ssWageBase: usd('184500'),
    medicareRate: pct('1.45'),
    addlMedicareRate: pct('0.9'),
    addlMedicareThreshold: usd('200000'),
  },
  futa: {
    wageBase: usd('7000'),
    netRate: pct('0.6'),
    // The Department of Labor's January 2026 list of potential reductions; final after November 10, 2026.
    creditReduction: { CA: { rate: pct('1.5'), provisional: true } },
  },
  california: {
    periods: {
      biweekly: {
        lowIncome: columns('727', '1454'),
        standardDeduction: columns('219', '439'),
        estimatedDeduction: amounts('38 77 115 154 192 231 269 308 346 385'),
        exemptionAllowance: amounts('6.47 12.95 19.42 25.89 32.37 38.84 45.31 51.78 58.26 64.73'),
        rates: {
          single: ca([
            ['0', '0'],
            ['426', '4.69'],
            ['1010', '17.54'],
            ['1594', '43.24'],
            ['2214', '84.16'],
            ['2798', '135.55'],
            ['14288', '1310.98'],
            ['17146', '1634.79'],
            ['28576', '3055.54'],
            ['38462', '4393.12'],
          ]),
          married: ca([
            ['0', '0'],
            ['852', '9.37'],
            ['2020', '35.07'],
            ['3188', '86.46'],
            ['4428', '168.30'],
            ['5596', '271.08'],
            ['28576', '2621.93'],
            ['34292', '3269.55'],
            ['38462', '3787.88'],
            ['57150', '6316.37'],
          ]),
          head_of_household: ca([
            ['0', '0'],
            ['852', '9.37'],
            ['2020', '35.07'],
            ['2604', '60.77'],
            ['3224', '101.69'],
            ['3808', '153.08'],
            ['19432', '1751.42'],
            ['23318', '2191.70'],
            ['38462', '4074.10'],
            ['38862', '4128.22'],
          ]),
        },
      },
      semimonthly: {
        lowIncome: columns('787', '1575'),
        standardDeduction: columns('238', '476'),
        estimatedDeduction: amounts('42 83 125 167 208 250 292 333 375 417'),
        exemptionAllowance: amounts('7.01 14.03 21.04 28.05 35.06 42.08 49.09 56.10 63.11 70.13'),
        rates: {
          single: ca([
            ['0', '0'],
            ['462', '5.08'],
            ['1094', '18.98'],
            ['1727', '46.83'],
            ['2398', '91.12'],
            ['3030', '146.74'],
            ['15478', '1420.17'],
            ['18574', '1770.95'],
            ['30956', '3310.03'],
            ['41667', '4759.23'],
          ]),
          married: ca([
            ['0', '0'],
            ['924', '10.16'],
            ['2188', '37.97'],
            ['3454', '93.67'],
            ['4796', '182.24'],
            ['6060', '293.47'],
            ['30956', '2840.33'],
            ['37148', '3541.88'],
            ['41667', '4103.59'],
            ['61913', '6842.87'],
          ]),
          head_of_household: ca([
            ['0', '0'],
            ['924', '10.16'],
            ['2189', '37.99'],
            ['2822', '65.84'],
            ['3492', '110.06'],
            ['4125', '165.76'],
            ['21050', '1897.19'],
            ['25260', '2374.18'],
            ['41667', '4413.57'],
            ['42101', '4472.29'],
          ]),
        },
      },
      monthly: {
        lowIncome: columns('1575', '3149'),
        standardDeduction: columns('476', '951'),
        estimatedDeduction: amounts('83 167 250 333 417 500 583 667 750 833'),
        exemptionAllowance: amounts('14.03 28.05 42.08 56.10 70.13 84.15 98.18 112.20 126.23 140.25'),
        rates: {
          single: ca([
            ['0', '0'],
            ['924', '10.16'],
            ['2188', '37.97'],
            ['3454', '93.67'],
            ['4796', '182.24'],
            ['6060', '293.47'],
            ['30956', '2840.33'],
            ['37148', '3541.88'],
            ['61912', '6620.05'],
            ['83334', '9518.45'],
          ]),
          married: ca([
            ['0', '0'],
            ['1848', '20.33'],
            ['4376', '75.95'],
            ['6908', '187.36'],
            ['9592', '364.50'],
            ['12120', '586.96'],
            ['61912', '5680.68'],
            ['74296', '7083.79'],
            ['83334', '8207.21'],
            ['123826', '13685.78'],
          ]),
          head_of_household: ca([
            ['0', '0'],
            ['1848', '20.33'],
            ['4378', '75.99'],
            ['5644', '131.69'],
            ['6984', '220.13'],
            ['8250', '331.54'],
            ['42100', '3794.40'],
            ['50520', '4748.39'],
            ['83334', '8827.17'],
            ['84202', '8944.61'],
          ]),
        },
      },
      annual: {
        lowIncome: columns('18896', '37791'),
        standardDeduction: columns('5706', '11412'),
        estimatedDeduction: amounts('1000 2000 3000 4000 5000 6000 7000 8000 9000 10000'),
        exemptionAllowance: amounts(
          '168.30 336.60 504.90 673.20 841.50 1009.80 1178.10 1346.40 1514.70 1683.00',
        ),
        rates: {
          single: ca([
            ['0', '0'],
            ['11079', '121.87'],
            ['26264', '455.94'],
            ['41452', '1124.21'],
            ['57542', '2186.15'],
            ['72724', '3522.17'],
            ['371479', '34084.81'],
            ['445771', '42502.09'],
            ['742953', '79441.81'],
            ['1000000', '114220.27'],
          ]),
          married: ca([
            ['0', '0'],
            ['22158', '243.74'],
            ['52528', '911.88'],
            ['82904', '2248.42'],
            ['115084', '4372.30'],
            ['145448', '7044.33'],
            ['742958', '68169.60'],
            ['891542', '85004.17'],
            ['1000000', '98485.50'],
            ['1485906', '164228.58'],
          ]),
          head_of_household: ca([
            ['0', '0'],
            ['22173', '243.90'],
            ['52530', '911.75'],
            ['67716', '1579.93'],
            ['83805', '2641.80'],
            ['98990', '3978.08'],
            ['505208', '45534.18'],
            ['606251', '56982.35'],
            ['1000000', '105925.35'],
            ['1010417', '107334.77'],
          ]),
        },
      },
    },
    sdiRate: pct('1.3'),
    sdiWageLimit: null,
    uiWageBase: usd('7000'),
    ettRate: pct('0.1'),
    newEmployerUiRate: pct('3.4'),
  },
};

export const PAYROLL_TAX_TABLES: Readonly<Record<number, PayrollTaxYear>> = { 2026: Y2026 };

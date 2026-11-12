import { describe, expect, it } from 'vitest';
import {
  caSickDefaultPolicy,
  caSickLeaveRule,
  calendarDate as d,
  deemedHoursMilli,
  planLeave,
  sickPolicyShortfalls,
  sickUsableFrom,
  type LeavePolicy,
  type LeaveState,
  type LeaveUse,
} from '../src/index.js';

const h = (hours: number) => BigInt(hours * 1000);
const STATE: LeaveState = {
  balance: 0n,
  balanceAtYearStart: 0n,
  usedThisYear: 0n,
  grantDone: false,
  carryoverDone: false,
};
const USE: LeaveUse = {
  year: 2026,
  workedMilli: 0n,
  usedMilli: 0n,
  payoutMilli: 0n,
  vested: false,
  usableFrom: null,
  periodStart: d('2026-11-01'),
};
const NONE: LeavePolicy = {
  method: 'none',
  accrueMilli: null,
  perHoursMilli: null,
  grantMilli: null,
  maxBalanceMilli: null,
  carryoverMaxMilli: null,
  useCapMilli: null,
};
const RULE_2026 = caSickLeaveRule(d('2026-11-11'));
const SICK = caSickDefaultPolicy(RULE_2026);

describe('California paid sick leave rules (dated table)', () => {
  it('uses SB 616’s 40 hours / 5 days from 2024', () => {
    expect(RULE_2026.from).toBe('2024-01-01');
    expect(RULE_2026.minHoursMilli).toBe(40000n);
    expect(RULE_2026.minDays).toBe(5);
    expect(RULE_2026.accrualCapHoursMilli).toBe(80000n);
    expect(RULE_2026.useCapHoursMilli).toBe(40000n);
    expect(RULE_2026.usableFromDay).toBe(90);
  });

  it('uses the 2015 rule (24 hours / 3 days) before 2024', () => {
    const r = caSickLeaveRule(d('2023-12-31'));
    expect(r.minHoursMilli).toBe(24000n);
    expect(r.accrualCapHoursMilli).toBe(48000n);
  });

  it('defaults to 1 hour per 30 worked, capped at 80 hours, 40 usable a year', () => {
    expect(SICK).toMatchObject({
      method: 'accrual',
      accrueMilli: 1000n,
      perHoursMilli: 30000n,
      maxBalanceMilli: 80000n,
      useCapMilli: 40000n,
      carryoverMaxMilli: null,
    });
    expect(sickPolicyShortfalls(SICK, RULE_2026)).toEqual([]);
  });

  it('flags a policy below the minimum', () => {
    expect(sickPolicyShortfalls({ ...SICK, accrueMilli: 1000n, perHoursMilli: 40000n }, RULE_2026)).toEqual([
      'accrual_rate',
    ]);
    expect(sickPolicyShortfalls({ ...SICK, maxBalanceMilli: h(48) }, RULE_2026)).toEqual(['balance_cap']);
    expect(sickPolicyShortfalls({ ...SICK, useCapMilli: h(24) }, RULE_2026)).toEqual(['use_cap']);
    expect(sickPolicyShortfalls({ ...SICK, carryoverMaxMilli: h(40) }, RULE_2026)).toEqual(['carryover']);
    expect(sickPolicyShortfalls({ ...SICK, method: 'none' }, RULE_2026)).toEqual(['method']);
    expect(sickPolicyShortfalls({ ...SICK, method: 'grant', grantMilli: h(24) }, RULE_2026)).toEqual([
      'grant',
    ]);
  });

  it('accepts a more generous policy', () => {
    expect(sickPolicyShortfalls({ ...SICK, accrueMilli: 1000n, perHoursMilli: 20000n }, RULE_2026)).toEqual(
      [],
    );
    expect(sickPolicyShortfalls({ ...SICK, maxBalanceMilli: null, useCapMilli: null }, RULE_2026)).toEqual(
      [],
    );
    expect(
      sickPolicyShortfalls(
        { ...NONE, method: 'grant', grantMilli: h(40), carryoverMaxMilli: 0n, useCapMilli: h(40) },
        RULE_2026,
      ),
    ).toEqual([]);
  });

  it('counts the hire date as day 1 for the 90th day', () => {
    expect(sickUsableFrom(d('2026-01-01'), RULE_2026)).toBe('2026-03-31');
    expect(sickUsableFrom(null, RULE_2026)).toBeNull();
  });
});

describe('hours an exempt employee is deemed to work', () => {
  it('is 40 a week', () => {
    expect(deemedHoursMilli('biweekly', 0n)).toBe(80000n);
    expect(deemedHoursMilli('semimonthly', 0n)).toBe(86667n);
    expect(deemedHoursMilli('monthly', 0n)).toBe(173333n);
  });

  it('leaves out leave taken, never below zero', () => {
    expect(deemedHoursMilli('biweekly', h(16))).toBe(64000n);
    expect(deemedHoursMilli('biweekly', h(100))).toBe(0n);
  });
});

describe('accrual', () => {
  it('earns 1 hour per 30 worked, to the thousandth', () => {
    const p = planLeave(SICK, STATE, { ...USE, workedMilli: h(80) });
    // 80 / 30 = 2.6667 hours
    expect(p.entries).toEqual([{ source: 'accrual', hoursMilli: 2667n, leaveYear: null }]);
    expect(p.after).toBe(2667n);
    expect(p.accrued).toBe(2667n);
  });

  it('stops at the cap', () => {
    const p = planLeave(SICK, { ...STATE, balance: h(79) }, { ...USE, workedMilli: h(80) });
    expect(p.accrued).toBe(1000n);
    expect(p.after).toBe(h(80));
  });

  it('accrues nothing at the cap', () => {
    const p = planLeave(SICK, { ...STATE, balance: h(80) }, { ...USE, workedMilli: h(80) });
    expect(p.entries).toEqual([]);
    expect(p.after).toBe(h(80));
  });

  it('measures the cap after the hours used on the same paycheck', () => {
    const p = planLeave(SICK, { ...STATE, balance: h(80) }, { ...USE, workedMilli: h(60), usedMilli: h(8) });
    // 80 - 8 = 72, then 2 hours accrue (60 / 30) → 74.
    expect(p.after).toBe(h(74));
    expect(p.entries.map((e) => e.source)).toEqual(['used', 'accrual']);
  });

  it('accrues vacation at the business’s own rate', () => {
    const vacation: LeavePolicy = { ...NONE, method: 'accrual', accrueMilli: h(1), perHoursMilli: h(26) };
    // 80 hours / 26 = 3.0769 hours
    expect(planLeave(vacation, STATE, { ...USE, workedMilli: h(80) }).after).toBe(3077n);
  });

  it('with no policy, only use moves the balance', () => {
    const p = planLeave(NONE, { ...STATE, balance: h(10) }, { ...USE, workedMilli: h(80), usedMilli: h(4) });
    expect(p.after).toBe(h(6));
    expect(p.accrued).toBe(0n);
  });
});

describe('yearly grant and carry-over', () => {
  const grant: LeavePolicy = { ...NONE, method: 'grant', grantMilli: h(80) };

  it('grants once a year, on the year’s first paycheck', () => {
    const p = planLeave(grant, STATE, USE);
    expect(p.entries).toEqual([{ source: 'grant', hoursMilli: h(80), leaveYear: 2026 }]);
    expect(planLeave(grant, { ...STATE, grantDone: true, balance: h(80) }, USE).entries).toEqual([]);
  });

  it('grants only up to the cap', () => {
    const p = planLeave({ ...grant, maxBalanceMilli: h(120) }, { ...STATE, balance: h(60) }, USE);
    expect(p.entries[0]).toMatchObject({ source: 'grant', hoursMilli: h(60) });
    expect(p.after).toBe(h(120));
  });

  it('cuts the balance above the carry-over limit before granting', () => {
    const p = planLeave(
      { ...grant, carryoverMaxMilli: h(40) },
      { ...STATE, balance: h(70), balanceAtYearStart: h(65) },
      USE,
    );
    // 65 at the year's start, 25 above the limit; 5 entered this year stays.
    expect(p.entries).toEqual([
      { source: 'carryover', hoursMilli: -h(25), leaveYear: 2026 },
      { source: 'grant', hoursMilli: h(80), leaveYear: 2026 },
    ]);
    expect(p.after).toBe(h(125));
    expect(p.accrued).toBe(h(55));
  });

  it('records a zero cut so the year isn’t cut again later', () => {
    const p = planLeave({ ...grant, carryoverMaxMilli: h(40) }, { ...STATE, grantDone: true }, USE);
    expect(p.entries).toEqual([{ source: 'carryover', hoursMilli: 0n, leaveYear: 2026 }]);
  });

  it('never cuts California vacation, which is vested wages', () => {
    const p = planLeave(
      { ...grant, carryoverMaxMilli: h(40) },
      { ...STATE, balance: h(100), balanceAtYearStart: h(100) },
      { ...USE, vested: true },
    );
    expect(p.entries.map((e) => e.source)).toEqual(['grant']);
    expect(p.after).toBe(h(180));
  });

  it('front-loads sick leave: last year’s balance goes and 40 hours arrive', () => {
    const front: LeavePolicy = {
      ...NONE,
      method: 'grant',
      grantMilli: h(40),
      carryoverMaxMilli: 0n,
      useCapMilli: h(40),
    };
    const p = planLeave(front, { ...STATE, balance: h(12), balanceAtYearStart: h(12) }, USE);
    expect(p.after).toBe(h(40));
  });
});

describe('use and warnings', () => {
  it('warns when more is used than the balance', () => {
    const p = planLeave(SICK, { ...STATE, balance: h(4) }, { ...USE, usedMilli: h(8) });
    expect(p.warnings).toEqual(['over_balance']);
    expect(p.after).toBe(-h(4));
  });

  it('lets this year’s grant cover what is used on the same paycheck', () => {
    const p = planLeave({ ...NONE, method: 'grant', grantMilli: h(40) }, STATE, { ...USE, usedMilli: h(8) });
    expect(p.warnings).toEqual([]);
    expect(p.after).toBe(h(32));
  });

  it('does not count this paycheck’s accrual toward what can be used', () => {
    const p = planLeave(SICK, { ...STATE, balance: h(2) }, { ...USE, workedMilli: h(90), usedMilli: h(4) });
    expect(p.warnings).toEqual(['over_balance']);
    expect(p.after).toBe(h(1));
  });

  it('warns past the yearly use limit', () => {
    const p = planLeave(SICK, { ...STATE, balance: h(60), usedThisYear: h(36) }, { ...USE, usedMilli: h(8) });
    expect(p.warnings).toEqual(['over_use_cap']);
  });

  it('warns about sick leave before the 90th day of employment', () => {
    const p = planLeave(
      SICK,
      { ...STATE, balance: h(8) },
      { ...USE, usedMilli: h(4), usableFrom: d('2026-11-10'), periodStart: d('2026-11-01') },
    );
    expect(p.warnings).toEqual(['waiting_period']);
  });
});

describe('final pay', () => {
  const vacation: LeavePolicy = { ...NONE, method: 'accrual', accrueMilli: h(1), perHoursMilli: h(20) };

  it('offers the balance after this paycheck’s use and accrual', () => {
    const p = planLeave(
      vacation,
      { ...STATE, balance: h(30) },
      { ...USE, workedMilli: h(40), usedMilli: h(8) },
    );
    expect(p.payable).toBe(h(24));
  });

  it('pays it out to zero', () => {
    const p = planLeave(
      vacation,
      { ...STATE, balance: h(30) },
      { ...USE, workedMilli: h(40), usedMilli: h(8), payoutMilli: h(24) },
    );
    expect(p.entries.map((e) => e.source)).toEqual(['used', 'accrual', 'payout']);
    expect(p.after).toBe(0n);
    expect(p.paidOut).toBe(h(24));
    expect(p.warnings).toEqual([]);
  });

  it('warns when more is paid out than is there', () => {
    const p = planLeave(vacation, { ...STATE, balance: h(5) }, { ...USE, payoutMilli: h(8) });
    expect(p.warnings).toEqual(['over_balance']);
  });
});

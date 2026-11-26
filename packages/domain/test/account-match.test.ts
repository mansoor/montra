import { describe, expect, it } from 'vitest';
import { accountWords, matchAccount, type MatchableAccount } from '../src/account-match.js';

// Ask about one account (RPT-06, ADR-0058): the phrase a question used, matched to account names on the server.
const acct = (
  id: string,
  name: string,
  kind: string,
  institution: string | null = null,
): MatchableAccount => ({
  id,
  name,
  kind,
  institution,
});

const skylark = acct('m1', 'Skylark Home Loan', 'mortgage', 'Skylark Bank');
const car = acct('l1', 'Car loan', 'loan');
const carAsset = acct('x1', 'Car', 'asset');
const checking = acct('c1', 'Checking', 'checking', 'Chase');
const savings = acct('s1', 'Savings', 'savings', 'Chase');
const sapphire = acct('k1', 'Chase Sapphire', 'credit_card', 'Chase');
const all = [skylark, car, carAsset, checking, savings, sapphire];

const one = (phrase: string, accounts = all) => {
  const m = matchAccount(phrase, accounts);
  return m.status === 'one' ? m.account.id : m.status === 'several' ? m.accounts.map((a) => a.id) : null;
};

describe('accountWords', () => {
  it('lowers case, drops accents, punctuation, possessives and plurals', () => {
    expect(accountWords("Sam's Savings")).toEqual(['sam', 'saving']);
    expect(accountWords('Crédit Agricole — 401(k)')).toEqual(['credit', 'agricole', '401k']);
    expect(accountWords('Boss account')).toEqual(['boss', 'account']);
  });
});

describe('matchAccount', () => {
  it('finds the owner’s mortgage however it is said', () => {
    expect(one('skylark home loan')).toBe('m1');
    expect(one('Skylark Home Loan')).toBe('m1');
    expect(one('my skylark home loan')).toBe('m1');
    expect(one('the Skylark loan')).toBe('m1');
    expect(one('skylark mortgage')).toBe('m1');
    expect(one('skylark')).toBe('m1');
  });

  it('prefers an exact name', () => {
    expect(one('car')).toBe('x1');
    expect(one('car loan')).toBe('l1');
    expect(one('my checking account')).toBe('c1');
  });

  it('lets kind words pick between accounts that share a name word', () => {
    expect(one('chase card')).toBe('k1');
    expect(one('chase checking')).toBe('c1');
    expect(one('chase savings account')).toBe('s1');
  });

  it('uses kind words alone when nothing else is said', () => {
    expect(one('my mortgage')).toBe('m1');
    expect(one('the home loan')).toBe('m1');
    expect(one('credit card')).toBe('k1');
  });

  it('returns every account that ties, sorted by name', () => {
    expect(one('chase')).toEqual(['k1', 'c1', 's1']);
    const twin = acct('m2', 'Skylark Home Loan', 'mortgage');
    expect(one('skylark home loan', [skylark, twin])).toEqual(['m1', 'm2']);
    expect(one('my loan', [car, acct('l2', 'Student loan', 'loan')])).toEqual(['l1', 'l2']);
  });

  it('matches nothing rather than guess', () => {
    expect(one('acme loan')).toBeNull();
    expect(one('the account')).toBeNull();
    expect(one('')).toBeNull();
    expect(one('wells fargo')).toBeNull();
    expect(one('constructor')).toBeNull();
    expect(one('skylark', [])).toBeNull();
  });
});

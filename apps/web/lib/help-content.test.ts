import { describe, expect, it } from 'vitest';
import { HELP_ARTICLES, helpArticle, searchHelp, TOUR_STEPS } from './help-content';
import { LEGAL_DOCS, LEGAL_REVIEWED, legalDoc } from './legal-content';

describe('searchHelp', () => {
  it('shows everything for an empty search', () => {
    expect(searchHelp('  ')).toHaveLength(HELP_ARTICLES.length);
  });

  it('needs every word, in any order, across title and text', () => {
    expect(searchHelp('restore backup').map((a) => a.slug)).toContain('your-data');
    expect(searchHelp('backup banana')).toEqual([]);
    expect(searchHelp('IMPORT').map((a) => a.slug)).toContain('importing');
  });
});

describe('the help center', () => {
  it('has unique slugs that can be found', () => {
    const slugs = HELP_ARTICLES.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(helpArticle('plans')?.title).toBe('Plans and billing');
    expect(helpArticle('nope')).toBeUndefined();
  });

  it('tours relative paths', () => {
    expect(TOUR_STEPS.length).toBeGreaterThan(3);
    for (const step of TOUR_STEPS) expect(step.path === '' || step.path.startsWith('/')).toBe(true);
  });
});

describe('the legal pages', () => {
  it('cover what OPS-11 asks for', () => {
    for (const slug of ['terms', 'privacy', 'cookies', 'subprocessors']) expect(legalDoc(slug)).toBeDefined();
    expect(LEGAL_DOCS).toHaveLength(4);
  });

  it('stay marked as drafts until someone qualified has read them', () => {
    expect(LEGAL_REVIEWED).toBe(false);
  });
});

/** Not-advice lines (AIA-12, NFR-14): a tax or money output on the phone ends with one, once, as on the web. */
import { screen } from '@testing-library/react-native';
import type { RecommendationDto, TaxYearDto } from '@montra/schemas';
import Suggestions from '../app/suggestions';
import TaxForms from '../app/tax-forms';
import { t } from '../src/i18n';
import { api } from './harness/api';
import { renderScreen, signedInAs } from './harness/render';

const rec = (type: RecommendationDto['type']): RecommendationDto => ({
  id: `rec-${type}`,
  type,
  entityId: 'ent-personal',
  budgetId: null,
  periodStart: '2026-11-01' as RecommendationDto['periodStart'],
  status: 'open',
  title: `A ${type} suggestion`,
  wording: null,
  payload: { currency: 'USD', figures: {}, subjects: [], actions: [], review: null },
  createdAt: '2026-11-01T00:00:00Z',
  resolvedAt: null,
});

describe('disclaimers', () => {
  beforeEach(async () => {
    await signedInAs('owner');
  });

  it('ends the tax forms screen with the tax line, once', async () => {
    api.taxYear.mockImplementation(async (_ws, year): Promise<TaxYearDto> => ({
      year,
      forms: [],
      expected: [],
      unexpectedFormIds: [],
      waivers: [],
    }));
    await renderScreen(<TaxForms />);

    expect(await screen.findByTestId('disclaimer-tax')).toHaveTextContent(t('disclaimer.tax'));
    expect(screen.getAllByTestId('disclaimer-tax')).toHaveLength(1);
    expect(t('disclaimer.tax')).toContain('not tax advice');
  });

  it('ends suggestions with the financial line', async () => {
    api.recommendations.mockResolvedValue([rec('REC-02'), rec('REC-05')]);
    await renderScreen(<Suggestions />);
    expect(await screen.findByTestId('disclaimer-financial')).toHaveTextContent(t('disclaimer.financial'));
    expect(screen.queryByTestId('disclaimer-tax')).toBeNull();
  });

  it('ends suggestions with the tax line instead when one is about tax', async () => {
    api.recommendations.mockResolvedValue([rec('REC-02'), rec('REC-09')]);
    await renderScreen(<Suggestions />);
    expect(await screen.findByTestId('disclaimer-tax')).toBeOnTheScreen();
    expect(screen.queryByTestId('disclaimer-financial')).toBeNull();
  });

  it('shows no line on suggestions while there are none', async () => {
    api.recommendations.mockResolvedValue([]);
    await renderScreen(<Suggestions />);
    expect(await screen.findByText(t('rec.empty'))).toBeOnTheScreen();
    expect(screen.queryByTestId('disclaimer-financial')).toBeNull();
  });
});

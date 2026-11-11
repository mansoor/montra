import type { MigrationSource } from '@montra/schemas';

/**
 * Switching from another app (IMP-13): how to export from each app, as its own help pages describe it (checked
 * November 2026). Steps are message keys; `help` is the app's own article, linked so people can check it themselves.
 */
export interface SwitchSource {
  id: MigrationSource;
  /** The app's name (a proper noun: not translated). */
  name: string;
  steps: string[];
  /** A caution about the export, or null. */
  note: string | null;
  help: string | null;
}

export const SWITCH_SOURCES: SwitchSource[] = [
  {
    id: 'ynab',
    name: 'YNAB',
    steps: ['switch.ynab.step_1', 'switch.ynab.step_2', 'switch.ynab.step_3'],
    note: 'switch.ynab.note',
    help: 'https://support.ynab.com/en_us/how-to-export-plan-data-Sy_CouWA9',
  },
  {
    id: 'monarch',
    name: 'Monarch Money',
    steps: ['switch.monarch.step_1', 'switch.monarch.step_2', 'switch.monarch.step_3'],
    note: 'switch.monarch.note',
    help: 'https://help.monarch.com/hc/en-us/articles/15526600975764',
  },
  {
    id: 'mint',
    name: 'Mint',
    steps: ['switch.mint.step_1', 'switch.mint.step_2'],
    note: null,
    help: null,
  },
  {
    id: 'lunch_money',
    name: 'Lunch Money',
    steps: ['switch.lunch_money.step_1', 'switch.lunch_money.step_2', 'switch.lunch_money.step_3'],
    note: null,
    help: 'https://support.lunchmoney.app/finances/transactions/other-features',
  },
  {
    id: 'actual',
    name: 'Actual Budget',
    steps: ['switch.actual.step_1', 'switch.actual.step_2'],
    note: 'switch.actual.note',
    help: 'https://actualbudget.org/docs/',
  },
  {
    id: 'tiller',
    name: 'Tiller',
    steps: ['switch.tiller.step_1', 'switch.tiller.step_2'],
    note: null,
    help: 'https://help.tiller.com/en/articles/432681-transactions-sheet-columns',
  },
  {
    id: 'empower',
    name: 'Empower',
    steps: ['switch.empower.step_1', 'switch.empower.step_2', 'switch.empower.step_3'],
    note: 'switch.empower.note',
    help: 'https://support-personalwealth.empower.com/hc/en-us/articles/18679551671703',
  },
  {
    id: 'copilot',
    name: 'Copilot Money',
    steps: ['switch.copilot.step_1', 'switch.copilot.step_2'],
    note: 'switch.check_signs',
    help: 'https://help.copilot.money/en/articles/5944414-exporting-your-transaction-data',
  },
  {
    id: 'rocket_money',
    name: 'Rocket Money',
    steps: ['switch.rocket_money.step_1', 'switch.rocket_money.step_2', 'switch.rocket_money.step_3'],
    note: 'switch.check_signs',
    help: 'https://help.rocketmoney.com/en/articles/10296106-exporting-transactions',
  },
  {
    id: 'pocketsmith',
    name: 'PocketSmith',
    steps: ['switch.pocketsmith.step_1', 'switch.pocketsmith.step_2'],
    note: 'switch.check_signs',
    help: 'https://learn.pocketsmith.com/article/158-exporting-your-transactions',
  },
  {
    id: 'simplifi',
    name: 'Quicken Simplifi',
    steps: ['switch.simplifi.step_1', 'switch.simplifi.step_2', 'switch.simplifi.step_3'],
    note: 'switch.simplifi.note',
    help: 'https://support.simplifi.quicken.com/en/articles/3404263-how-to-export-transactions-from-quicken-simplifi',
  },
  {
    id: 'goodbudget',
    name: 'Goodbudget',
    steps: ['switch.goodbudget.step_1', 'switch.goodbudget.step_2'],
    note: null,
    help: 'https://goodbudget.com/?p=12471',
  },
  {
    id: 'quicken_mac',
    name: 'Quicken (Mac)',
    steps: ['switch.quicken_mac.step_1', 'switch.quicken_mac.step_2'],
    note: 'switch.quicken_mac.note',
    help: 'https://info.quicken.com/mac/exporting-register-transactions-to-a-csv-spreadshe',
  },
  {
    id: 'other',
    name: '',
    steps: ['switch.other.step_1', 'switch.other.step_2'],
    note: null,
    help: null,
  },
];

export const switchSource = (id: string): SwitchSource | undefined => SWITCH_SOURCES.find((s) => s.id === id);

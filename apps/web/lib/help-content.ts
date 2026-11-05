/** The help center (OPS-09). Plain text kept with the code, so it changes with the feature it describes. */
export interface HelpArticle {
  slug: string;
  title: string;
  summary: string;
  sections: { heading?: string; paragraphs: string[] }[];
}

export const HELP_ARTICLES: readonly HelpArticle[] = [
  {
    slug: 'getting-started',
    title: 'Getting started',
    summary: 'From a new account to your first categorized dashboard.',
    sections: [
      {
        paragraphs: [
          'Create a workspace and choose what it’s for: a household, a business or rentals. You can add other kinds of books later.',
          'Under Accounts, add one with its current balance, then import a statement from your bank. Montra suggests a category for each line, and you check the ones it isn’t sure about in Review.',
          'After that, Home shows where the month stands, and Budget lets you give every dollar a job.',
        ],
      },
      {
        heading: 'A quick tour',
        paragraphs: ['Choose Take a tour on the help page at any time to walk through the main screens.'],
      },
    ],
  },
  {
    slug: 'importing',
    title: 'Importing statements',
    summary: 'CSV, Excel and PDF statements, and what to do when a file looks wrong.',
    sections: [
      {
        paragraphs: [
          'Open an account and choose Import statement. Montra reads CSV, Excel and PDF files, and scanned PDFs through text recognition.',
          'You see a preview before anything is added. Lines already in your books are spotted and left out, and you can skip any others.',
          'If Montra can’t tell which column is which, it asks once and remembers for the next file from that bank.',
        ],
      },
      {
        heading: 'Undoing an import',
        paragraphs: ['Open Imports and undo the file. Everything it added comes back out.'],
      },
    ],
  },
  {
    slug: 'review',
    title: 'Reviewing categories',
    summary: 'How suggestions work, and how Montra learns from you.',
    sections: [
      {
        paragraphs: [
          'Montra tries your rules first, then your history, then a list of known merchants, and only then AI. Whatever it’s unsure about waits in Review.',
          'When you correct a category, Montra remembers it for that payee. Rules let you decide it in advance.',
          'Every figure comes from your books. AI only suggests categories and explains things, and never does the arithmetic.',
        ],
      },
    ],
  },
  {
    slug: 'budgets',
    title: 'Budgets and goals',
    summary: 'Left to assign, moving money between categories, and saving for goals.',
    sections: [
      {
        paragraphs: [
          'Your budget matches planned spending to expected income, so one number always says what’s left to assign.',
          'If a category runs over, move money from another. Goals set money aside each month toward a date and an amount.',
          'Cash flow and Calendar show what’s coming, and Suggestions point out what could change.',
        ],
      },
    ],
  },
  {
    slug: 'receipts',
    title: 'Receipts',
    summary: 'Capturing receipts and matching them to transactions.',
    sections: [
      {
        paragraphs: [
          'Take a photo on your phone or upload a file. Montra reads the store, date, items and total, then matches it to the transaction when one turns up.',
          'Check anything it marks as unsure. The Items on receipts report shows what you bought across stores.',
        ],
      },
    ],
  },
  {
    slug: 'family',
    title: 'Family, sharing and payslips',
    summary: 'Who can see what, and spending by family member.',
    sections: [
      {
        paragraphs: [
          'Family members are people your money is about, and don’t need a login. Tag a transaction to see income and spending for each.',
          'To share a workspace, invite someone from Settings as a partner, viewer or accountant. Partners don’t see business or rental books unless you say so.',
          'Payslips can be restricted so only the person they belong to sees the details.',
        ],
      },
    ],
  },
  {
    slug: 'business-rentals',
    title: 'Business and rental books',
    summary: 'Invoices, bills, mileage, leases, rent and tax summaries.',
    sections: [
      {
        paragraphs: [
          'Each business or rental portfolio has its own books. Business books have invoices, bills, mileage and Schedule C. Rental books have leases, rent, deposits, mortgages and Schedule E.',
          'These figures help you prepare your taxes and aren’t tax advice, so check them with whoever prepares your return.',
        ],
      },
    ],
  },
  {
    slug: 'reports-search',
    title: 'Reports, search and asking questions',
    summary: 'Filters, saved reports, exports, search syntax and Ask.',
    sections: [
      {
        paragraphs: [
          'Reports can be filtered, saved and exported as PDF, CSV or Excel. Select a row or bar to see the transactions behind it.',
          'Search from the top of any page. Try coffee >20 or tag:travel. It looks through payees, descriptions, your notes and the text on receipts.',
          'Ask takes a question in your own words. AI works out what you mean, and the answer is worked out from your books.',
        ],
      },
    ],
  },
  {
    slug: 'notifications',
    title: 'Notifications',
    summary: 'What you hear about, when, and where.',
    sections: [
      {
        paragraphs: [
          'In Settings, choose in the app, email or push for each kind of notification. Quiet hours hold email and push until they end, and a daily limit stops too many at once.',
          'Email and push don’t include amounts or balances, because they can appear on a lock screen. The weekly digest’s email is the one exception.',
        ],
      },
    ],
  },
  {
    slug: 'your-data',
    title: 'Backups, restoring and leaving',
    summary: 'Taking your data out, bringing it back, and deleting your account.',
    sections: [
      {
        paragraphs: [
          'In Settings, under Backups and your data, you can make a backup at any time. It has your data as JSON and CSV, a spreadsheet, and your documents, and a password can encrypt it. We don’t keep that password, so we can’t recover it.',
          'To restore, upload a backup and read the preview. Nothing changes until you confirm.',
          'Deleted transactions and receipts stay in Trash for 30 days. If you delete your account, it closes at once. You can change your mind for up to 30 days, and after that everything is purged.',
        ],
      },
    ],
  },
  {
    slug: 'privacy-ai',
    title: 'Privacy and AI',
    summary: 'What each AI choice sends, and how to turn AI off.',
    sections: [
      {
        paragraphs: [
          'Settings → Privacy lists what each AI choice sends. Account numbers, emails and phone numbers are masked first, and family names are replaced with placeholders.',
          'You can use the built-in AI, your own key, a model on your own network, or no AI at all. With AI off, rules, your history and the merchant list still work, and everything else goes to Review.',
          'There are no ads, and your data is never sold.',
        ],
      },
    ],
  },
  {
    slug: 'security',
    title: 'Security and support access',
    summary: 'Second factors, sessions, the activity log, and letting support look.',
    sections: [
      {
        paragraphs: [
          'Use a second factor, and review your devices under Security. The activity log shows sign-ins from new devices, changes to how you sign in, and when data was taken out.',
          'Our staff can’t see your financial data. If you need help with a problem, an owner can allow read-only access in Settings → Support access. It lasts 72 hours unless you choose otherwise, and you can end it at any time. Each look appears in your activity log.',
        ],
      },
    ],
  },
  {
    slug: 'plans',
    title: 'Plans and billing',
    summary: 'What each plan includes, and what happens if a payment fails.',
    sections: [
      {
        paragraphs: [
          'Personal books are free. The Pro plan adds business and rental books and more storage, and starts with a 14-day trial.',
          'Manage your plan, card and invoices in Settings → Plan. If a payment fails, you have 14 days to sort it out.',
          'If a plan ends, nothing is taken away. Your books stay readable, editable and exportable, but you can’t add more business or rental books until you’re back on Pro.',
        ],
      },
    ],
  },
];

export const helpArticle = (slug: string) => HELP_ARTICLES.find((a) => a.slug === slug);

/** Every word of the search has to appear, in any order, in the title, summary or text. */
export function searchHelp(query: string, articles: readonly HelpArticle[] = HELP_ARTICLES): HelpArticle[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...articles];
  return articles.filter((a) => {
    const text = [a.title, a.summary, ...a.sections.flatMap((s) => [s.heading ?? '', ...s.paragraphs])]
      .join(' ')
      .toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** The guided tour (OPS-09): `path` is relative to the workspace. */
export const TOUR_STEPS: readonly { path: string; title: string; body: string }[] = [
  {
    path: '',
    title: 'Home',
    body: 'Where the month stands: what’s left to spend, what’s coming, and what needs a look.',
  },
  {
    path: '/accounts/new',
    title: 'Add an account',
    body: 'Start here. Give it a name and a current balance, then import a statement from your bank.',
  },
  {
    path: '/review',
    title: 'Review',
    body: 'Anything Montra isn’t sure about waits here. Your corrections teach it for next time.',
  },
  { path: '/budget', title: 'Budget', body: 'Give every dollar a job, and see what’s left to assign.' },
  {
    path: '/reports',
    title: 'Reports',
    body: 'Filter, save and export. Select any row to see the transactions behind it.',
  },
  {
    path: '/settings?tab=data',
    title: 'Your data',
    body: 'Back up, restore or leave whenever you like. It’s your data.',
  },
];

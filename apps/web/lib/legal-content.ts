/**
 * Legal pages (OPS-11). DRAFTS: nobody qualified has reviewed these, and `LEGAL_REVIEWED` stays false until someone has. The pages say so.
 * They describe what the product does today, so a lawyer has something accurate to work from.
 */
export const LEGAL_REVIEWED = false;

export interface LegalDoc {
  slug: string;
  title: string;
  sections: { heading: string; paragraphs: string[] }[];
}

export const LEGAL_DOCS: readonly LegalDoc[] = [
  {
    slug: 'terms',
    title: 'Terms of service',
    sections: [
      {
        heading: 'What Montra is',
        paragraphs: [
          'Montra helps you track personal, business and rental money. It isn’t a bank, and doesn’t move money for you.',
          'Tax summaries and suggestions are there to help you prepare and decide. They aren’t tax, legal or financial advice.',
        ],
      },
      {
        heading: 'Your account',
        paragraphs: [
          'You’re responsible for keeping your sign-in safe and for what happens under your account. Owners decide who else can see a workspace.',
        ],
      },
      {
        heading: 'Your data',
        paragraphs: [
          'Your data stays yours. You can export it at any time, including after a plan ends, and you can delete your account yourself.',
        ],
      },
      {
        heading: 'Plans',
        paragraphs: [
          'Personal books are free. Paid plans renew until cancelled. If a payment fails there’s a 14-day grace period. After a plan ends, your data stays readable, editable and exportable.',
        ],
      },
    ],
  },
  {
    slug: 'privacy',
    title: 'Privacy policy',
    sections: [
      {
        heading: 'What we keep',
        paragraphs: [
          'Your email and profile; the financial records and files you add; and technical logs needed to keep the service running.',
          'Account numbers and notes are encrypted separately in the database, on top of encryption at rest.',
        ],
      },
      {
        heading: 'What we don’t do',
        paragraphs: ['No ads, no selling your data, and no third-party trackers in the app.'],
      },
      {
        heading: 'AI',
        paragraphs: [
          'What’s sent depends on your AI setting, and Settings → Privacy lists it per mode. Details are masked before sending. Requests aren’t used to train models. You can turn AI off.',
        ],
      },
      {
        heading: 'Staff access',
        paragraphs: [
          'Staff can’t see your financial data. An owner can allow limited, read-only support access for a set time and end it at any time, and every look is logged where you can see it.',
        ],
      },
      {
        heading: 'Your rights',
        paragraphs: [
          'You can see, export and correct your data yourself, and delete your account in Settings. A deleted account is purged within 30 days, and ages out of our backups after that.',
        ],
      },
    ],
  },
  {
    slug: 'cookies',
    title: 'Cookies',
    sections: [
      {
        heading: 'What we set',
        paragraphs: [
          'Only what the service needs: a session cookie that keeps you signed in. Your theme choice and tour progress are kept in your browser’s own storage.',
          'There are no advertising or analytics cookies, so there’s nothing to opt in to.',
        ],
      },
    ],
  },
  {
    slug: 'subprocessors',
    title: 'Who else handles data',
    sections: [
      {
        heading: 'Companies we use',
        paragraphs: [
          'Amazon Web Services: hosting, database, file storage and email.',
          'Cloudflare: network protection and delivery.',
          'Anthropic: AI, in the built-in AI mode only, with details masked first.',
          'Stripe: payments, if you’re on a paid plan. Card details go directly to them.',
          'Sentry: error tracking, without request contents.',
          'Expo: delivering push notifications, which carry no amounts.',
        ],
      },
      {
        heading: 'Done on our own systems',
        paragraphs: ['Reading scanned documents (OCR) runs on our own servers.'],
      },
    ],
  },
];

export const legalDoc = (slug: string) => LEGAL_DOCS.find((d) => d.slug === slug);

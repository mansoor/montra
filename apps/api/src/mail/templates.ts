/**
 * Every email the API sends (AUTH-05, Phase 11), each in the shared layout (`layout.ts`). Kratos sends the recovery and
 * confirmation codes itself, from `infra/kratos/templates`, which `kratos-templates.ts` writes from this same layout.
 *
 * Times are in the person's time zone when the caller knows it (`timeZone`), else UTC. Subjects are pinned by tests.
 */
import type { MailMessage } from './mail.service.js';
import {
  day,
  link,
  p,
  renderHtml,
  renderText,
  strong,
  when,
  type EmailContent,
  type Inline,
} from './layout.js';

/** Why each kind of email arrives. */
export const FOOTERS = {
  security: [
    'You’re getting this because it’s about the security of your Montra account. Security emails can’t be turned off.',
  ],
  account: ['You’re getting this because of your Montra account.'],
  sharing: [
    'You’re getting this because someone invited this address to Montra. If you don’t know them, ignore it.',
  ],
  staff: ['You’re getting this as Montra staff.'],
} satisfies Record<string, Inline[]>;

function message(
  to: string,
  category: MailMessage['category'],
  content: EmailContent,
  extra: Partial<MailMessage> = {},
): MailMessage {
  return {
    to,
    category,
    subject: content.subject,
    text: renderText(content),
    html: renderHtml(content),
    ...extra,
  };
}

/** The usual close to a security alert: nothing to do if it was them; where to go if not. */
const ifNotYou = (todo: string, url: string) => [
  p('If this was you, no action is needed.'),
  p(`If it wasn’t you, ${todo} now.`),
  { action: 'Review your security settings', href: url },
];

export const templates = {
  // ----- Sharing --------------------------------------------------------------------------------------

  invite(args: { to: string; inviter: string; workspace: string; role: string; url: string }): MailMessage {
    return message(args.to, 'sharing', {
      subject: `${args.inviter} invited you to ${args.workspace} on Montra`,
      preview: `Join the ${args.workspace} workspace as ${args.role}.`,
      blocks: [
        p(
          `${args.inviter} invited you to the `,
          strong(args.workspace),
          ` workspace on Montra as ${args.role}.`,
        ),
        { action: 'Accept the invite', href: args.url },
        p('The link expires in 7 days. If you didn’t expect this, you can ignore this email.'),
      ],
      footer: FOOTERS.sharing,
    });
  },

  // ----- Account security (AUTH-12, ADR-0045) ---------------------------------------------------------------

  newDevice(args: {
    to: string;
    userAgent: string | null;
    ip: string | null;
    at: Date;
    url: string;
    timeZone?: string | null;
  }): MailMessage {
    return message(args.to, 'security', {
      subject: 'New sign-in to your Montra account',
      blocks: [
        p('Your Montra account was signed in to from a device it hasn’t seen before.'),
        {
          facts: [
            ['When', when(args.at, args.timeZone)],
            ['Device', args.userAgent ?? 'Unknown device'],
            ...(args.ip ? ([['IP address', args.ip]] as [string, string][]) : []),
          ],
        },
        ...ifNotYou('sign that session out and change your password', args.url),
      ],
      footer: FOOTERS.security,
    });
  },

  /** The password changed, so an attacker who changed it is noticed. */
  passwordChanged(args: { to: string; at: Date; url: string; timeZone?: string | null }): MailMessage {
    return message(args.to, 'security', {
      subject: 'Your Montra password was changed',
      blocks: [
        p(
          `The password for your Montra account was changed on ${when(args.at, args.timeZone)}, and your other devices were signed out.`,
        ),
        ...ifNotYou('reset your password and check your devices', args.url),
      ],
      footer: FOOTERS.security,
    });
  },

  /** ADR-0049 §6: the mobile number on the account was added, changed or removed. To the email address. */
  phoneChanged(args: {
    to: string;
    at: Date;
    url: string;
    now: string | null;
    timeZone?: string | null;
  }): MailMessage {
    const what = args.now ? `is now the number ending ${args.now.slice(-4)}` : 'was removed';
    return message(args.to, 'security', {
      subject: 'The mobile number on your Montra account changed',
      blocks: [
        p(
          `The mobile number on your Montra account ${what}, on ${when(args.at, args.timeZone)}. Texted sign-in codes and alerts go to it.`,
        ),
        ...ifNotYou('reset your password and check your security settings', args.url),
      ],
      footer: FOOTERS.security,
    });
  },

  /** An authenticator app, security key or recovery codes were added, changed or removed. */
  twoStepChanged(args: { to: string; at: Date; url: string; timeZone?: string | null }): MailMessage {
    return message(args.to, 'security', {
      subject: 'Two-step verification changed on your Montra account',
      blocks: [
        p(
          `The two-step verification for your Montra account changed on ${when(args.at, args.timeZone)}: an authenticator app, security key or set of recovery codes was added, replaced or removed.`,
        ),
        ...ifNotYou('reset your password and review your two-step verification', args.url),
      ],
      footer: FOOTERS.security,
    });
  },

  /** AUTH-08: sign-in paused for this email after too many wrong passwords (ADR-0042). */
  signInLocked(args: {
    to: string;
    ip: string | null;
    until: Date;
    url: string;
    timeZone?: string | null;
  }): MailMessage {
    return message(args.to, 'security', {
      subject: 'Sign-in to your Montra account was paused',
      blocks: [
        p(
          `Someone entered the wrong password for your Montra account too many times${args.ip ? ` (from ${args.ip})` : ''}, so signing in with a password is paused until ${when(args.until, args.timeZone)}.`,
        ),
        p(
          'If this was you, wait and try again, or reset your password now: the reset works while sign-in is paused.',
        ),
        p(
          'If it wasn’t you, your password still kept them out. Consider changing it and turning on two-step verification.',
        ),
        { action: 'Review your security settings', href: args.url },
      ],
      footer: FOOTERS.security,
    });
  },

  /** AUTH-11: to the current address, which must agree to the change. */
  emailChangeOld(args: { to: string; newEmail: string; code: string }): MailMessage {
    return message(args.to, 'security', {
      subject: 'Confirm your Montra email change',
      blocks: [
        p(
          'Someone asked to change your Montra sign-in email to ',
          strong(args.newEmail),
          '. Your confirmation code:',
        ),
        { code: args.code },
        p('If this wasn’t you, ignore this email and change your password.'),
      ],
      footer: FOOTERS.security,
    });
  },

  /** AUTH-11: to the new address, which must prove it's theirs. */
  emailChangeNew(args: { to: string; code: string }): MailMessage {
    return message(args.to, 'security', {
      subject: 'Confirm your new Montra email address',
      blocks: [
        p('Use this code to confirm ', strong(args.to), ' as your Montra sign-in email:'),
        { code: args.code },
        p('The code expires in 24 hours. If you didn’t ask for this, ignore this email.'),
      ],
      footer: FOOTERS.security,
    });
  },

  /** AUTH-11: to the old address, once the change is made. */
  emailChanged(args: { to: string; newEmail: string }): MailMessage {
    return message(args.to, 'security', {
      subject: 'Your Montra sign-in email was changed',
      blocks: [
        p('Your Montra sign-in email is now ', strong(args.newEmail), '.'),
        p('If you didn’t make this change, contact support right away.'),
      ],
      footer: FOOTERS.security,
    });
  },

  /** AUTH-10: the 72-hour hold before a lost second factor is removed. */
  mfaResetRequested(args: {
    to: string;
    eligibleAt: Date;
    url: string;
    timeZone?: string | null;
  }): MailMessage {
    return message(args.to, 'security', {
      subject: 'Second-factor reset requested on your Montra account',
      blocks: [
        p(
          'A request was made to remove the second factor (authenticator app, passkeys, recovery codes) from your Montra account.',
        ),
        p(
          `For your safety it can only be completed after ${when(args.eligibleAt, args.timeZone)}, 72 hours from now.`,
        ),
        p('If this wasn’t you, cancel it now from any signed-in device.'),
        { action: 'Cancel the reset', href: args.url },
      ],
      footer: FOOTERS.security,
    });
  },

  mfaResetCompleted(args: { to: string; url: string }): MailMessage {
    return message(args.to, 'security', {
      subject: 'Second factor removed from your Montra account',
      blocks: [
        p('Your second factor was removed and all sessions were signed out.'),
        p('Set up a new authenticator app or passkey now.'),
        { action: 'Set up two-step verification', href: args.url },
      ],
      footer: FOOTERS.security,
    });
  },

  // ----- Staff actions on an account (OPS-02) ---------------------------------------------------------------

  accountSuspended(args: { to: string; support: string }): MailMessage {
    return message(args.to, 'security', {
      subject: 'Your Montra account is suspended',
      blocks: [
        p(
          'Your Montra account has been suspended, so you can’t sign in, and workspaces you own are closed for now.',
        ),
        p('Nothing has been deleted.'),
        p('If you think this is a mistake, write to ', link(args.support, `mailto:${args.support}`), '.'),
      ],
      footer: FOOTERS.security,
    });
  },

  accountRestored(args: { to: string; url: string }): MailMessage {
    return message(args.to, 'security', {
      subject: 'Your Montra account is open again',
      blocks: [
        p(
          'Your Montra account is no longer suspended. You can sign in, and your workspaces are open as before.',
        ),
        { action: 'Sign in', href: args.url },
      ],
      footer: FOOTERS.security,
    });
  },

  accountClosing(args: { to: string; purgeAfter: string | null; support: string; url: string }): MailMessage {
    return message(args.to, 'security', {
      subject: 'Your Montra account will be deleted',
      blocks: [
        p(
          'As you asked, your Montra account is closing. You can’t sign in to the workspaces it owns from now on.',
        ),
        p(
          `Everything is deleted for good after 30 days${args.purgeAfter ? `, on ${day(args.purgeAfter)}` : ''}.`,
        ),
        p(
          'Changed your mind? Sign in before then and cancel it in Settings → Your data, or write to ',
          link(args.support, `mailto:${args.support}`),
          '.',
        ),
        { action: 'Sign in to cancel', href: args.url },
      ],
      footer: FOOTERS.security,
    });
  },

  // ----- Workspace and billing ----------------------------------------------------------------------------

  /** A plan that will include less, ahead of the date (ADR-0049). */
  planChanging(args: {
    to: string;
    plan: string;
    workspace: string;
    date: string;
    url: string;
  }): MailMessage {
    return message(args.to, 'transactional', {
      subject: `Your Montra ${args.plan} plan changes on ${args.date}`,
      blocks: [
        p(`The ${args.plan} plan for `, strong(args.workspace), ` will include less from ${day(args.date)}.`),
        p('Nothing you already have is taken away: books and files stay readable, editable and exportable.'),
        { action: 'See your plan', href: args.url },
      ],
      footer: FOOTERS.account,
    });
  },

  /** An in-app notification sent by email (NOTIF-*, OPS-10). */
  notification(args: {
    to: string;
    title: string;
    body: string;
    url: string;
    /** The person asked for this one (a backup they started, say), so it isn't the notification stream. */
    requested: boolean;
    unsubscribeUrl: string | null;
    oneClickUrl: string | null;
  }): MailMessage {
    const stream = !args.requested;
    return message(
      args.to,
      stream ? 'notification' : 'transactional',
      {
        subject: args.title,
        blocks: [p(args.body), { action: 'Open Montra', href: args.url }],
        footer:
          stream && args.unsubscribeUrl
            ? [
                'You’re getting this because notification emails are on for your Montra account. ',
                link('Turn them off', args.unsubscribeUrl),
                '.',
              ]
            : ['You asked for this email.'],
      },
      stream && args.oneClickUrl
        ? {
            headers: {
              'List-Unsubscribe': `<${args.oneClickUrl}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            },
          }
        : {},
    );
  },

  /** BUS-*: an invoice from a business to its customer, with the PDF attached. Sent for the business, not Montra. */
  invoice(args: {
    to: string;
    from: string;
    number: string;
    total: string;
    due: string;
    note: string | null;
    replyTo: string | null;
    pdf: Uint8Array;
  }): MailMessage {
    return message(
      args.to,
      'invoice',
      {
        subject: `Invoice ${args.number} from ${args.from}`,
        brand: args.from,
        preview: `Total ${args.total}, due ${day(args.due)}.`,
        blocks: [
          ...(args.note ? [{ quote: args.note }] : []),
          p(`Invoice ${args.number} from ${args.from} is attached.`),
          {
            facts: [
              ['Total', args.total],
              ['Due', day(args.due)],
            ],
          },
        ],
        footer: [
          `Sent with Montra for ${args.from}. `,
          args.replyTo
            ? `Reply to this email to reach ${args.from}.`
            : `For questions, contact ${args.from} directly.`,
        ],
      },
      {
        ...(args.replyTo ? { replyTo: args.replyTo } : {}),
        attachments: [{ filename: `${args.number}.pdf`, content: args.pdf, contentType: 'application/pdf' }],
      },
    );
  },

  // ----- To staff (ADR-0049) ---------------------------------------------------------------------------

  /** Something changed in the staff console that every owner should know about. */
  staffNotice(args: { to: string; subject: string; paragraphs: string[]; url: string }): MailMessage {
    return message(args.to, 'security', {
      subject: args.subject,
      blocks: [...args.paragraphs.map((x) => p(x)), { action: 'Open the staff console', href: args.url }],
      footer: FOOTERS.staff,
    });
  },

  aiCeilingReached(args: { to: string; ceiling: string; month: string; url: string }): MailMessage {
    return message(args.to, 'transactional', {
      subject: 'Montra: built-in AI is stopped for the month',
      blocks: [
        p(
          `The service has spent its built-in AI ceiling of ${args.ceiling} for ${args.month}, so built-in AI is stopped for every workspace until the month ends.`,
        ),
        p(
          'Customers fall back as when AI fails: rules categorize transactions, and scans and statements are entered by hand.',
        ),
        p(
          'If this is a bug or abuse, find it before raising the ceiling. The ceiling is in the staff console.',
        ),
        { action: 'Open the staff console', href: args.url },
      ],
      footer: FOOTERS.staff,
    });
  },

  supportRequest(args: {
    to: string;
    kind: 'bug' | 'question';
    id: string;
    from: string;
    url: string;
  }): MailMessage {
    return message(args.to, 'transactional', {
      subject: `New ${args.kind === 'bug' ? 'bug report' : 'question'} ${args.id}`,
      blocks: [
        // Only that there is one. What it says stays in the console, behind the staff sign-in.
        p(`From ${args.from}. Read it in the staff console.`),
        { action: 'Open the request', href: args.url },
      ],
      footer: FOOTERS.staff,
    });
  },

  providerTest(args: { to: string; sender: string }): MailMessage {
    return message(args.to, 'transactional', {
      subject: 'Montra test email',
      blocks: [
        p('This is a test from the Providers page in the Montra staff console.'),
        p(`It was sent by the API with the sender ${args.sender}.`),
        p('Sign-in codes come from Kratos’s own courier, set up separately.'),
      ],
      footer: FOOTERS.staff,
    });
  },
};

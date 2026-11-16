# ADR-0049: Plans as data, the platform owner, accounts and providers

- Status: accepted (replaces ADR-0020 §1 and §9; extends §2, §3 and §6)
- Date: 2026-11-14

## Context

Montra was built to be offered as a service (ADR-0020), but several parts of that design assumed one paid plan and a
small staff:

- **Two fixed plans.** `free` and `pro` are a type in `@montra/domain` (`operations.ts`), a check on
  `app.subscription.plan` (migration 0021), and two Stripe prices in configuration (`STRIPE_PRICE_PRO_MONTHLY` and
  `_YEARLY`). What each plan allows is code, so a new tier, or a change to one, needs a release.
- **AI cost isn't tied to a plan.** The gateway counts each workspace's AI cost per calendar month (`app.ai_usage`) and
  stops at `monthlyBudgetUsd`. That limit is the customer's own setting, and it's unlimited unless they set one. Hosted,
  the operator pays every customer's AI bill. Since Phase 11, receipt, statement, payslip and bill scanning and voice
  entry have all added AI calls.
- **The plans predate later features.** Payroll, staff time, receipt item search, scans and billers came after Phase 11.
  The plans only know about business books, rental books and storage.
- **Staff management is a command line tool.** Staff are `support` or `admin`, added with `staff:add` and the
  database owner's URL. Nobody can add or remove staff, or edit plans, from the console.
- **Accounts can't be managed.** The console lists people, workspaces and plans, and changes a workspace's plan. There's
  no suspending an account for abuse, no extending a trial, no free plan given by hand, and no closing an account for
  someone who asks support.
- **Providers are configured only through the environment, and only by email.** Sign-in codes go by email from Kratos's
  courier. There is no text messaging. Nobody can see from the console whether email works.

The owner wants:

- several paid tiers, each with its own features, price and AI allowance, set up without a release;
- a top-level staff login that manages plans, accounts, support and settings for the whole service;
- texted codes, through Twilio.

## Decision

### 1. Plans are data

Which features exist is code. Which plan gets which, and how much, is data that the owner edits in the console.

- **`app.plan`:** a key (`free`, `pro`, `plus`, …), a name, a description, an order for the plan picker, and whether
  it's offered to new customers. A plan that's withdrawn keeps its subscribers.
- **`app.plan_version`:** what a plan allows, as one version. Editing a plan writes a new version. A version is never
  changed once someone subscribes to it.
- **`app.plan_price`:** the provider (`stripe` for now; `apple` and `google` later), the interval (`month` or `year`),
  the provider's price id, and the amount and currency, for showing only. Stripe is what charges.
- **`app.subscription`** gains `plan_version_id`. `plan` stays as the plan's key, without the two-value check.

A version's entitlements are checked against one schema, `PlanEntitlements` in `@montra/domain`:

| Entitlement                 | What it means                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `businessBooks`             | How many business books can be added. 0 means none                                    |
| `rentalPortfolios`          | How many rental portfolios can be added                                               |
| `storageBytes`              | Files, receipts and backups together                                                  |
| `familyLogins`              | How many people can sign in to the workspace (ADR-0041)                               |
| `aiMonthlyMicroUsd`         | The AI allowance per calendar month (§2). `null` means no limit                       |
| `smsMonthly`                | Texts per month for alerts (§6). Sign-in and security texts aren't counted            |
| `features`                  | Feature keys that are on: `payroll`, `staffTime`, `scans`, `voice`, `ownStorage`, …   |

- **Seeded so nothing changes.** The migration creates Free and Pro with exactly what they allow today. Existing
  subscriptions point at those versions.
- **Free is a plan like the others.** It has no price, it can't be withdrawn or deleted, and a workspace without a
  subscription is on its current version.
- **A new feature key is code.** The code adds it to `features` and gives it a default per existing plan in the same
  migration, so an upgrade never takes away what someone had.
- **`BILLING_MODE=off` stays.** It gives every workspace everything, with no AI limit except the operator's (§2). That's
  how self-hosted installs, development and tests run.

#### Changing a plan, and moving subscribers

- New customers get a plan's latest version.
- Existing subscribers stay on their version until they change plans, or until the owner moves them in the console.
- Moving subscribers to a version that gives more takes effect at once.
- Moving them to a version that gives less needs a date at least 30 days away. Each subscriber is emailed, and it
  applies from their first renewal after that date.
- A change of price is Stripe's: the owner adds a new price in Stripe and on the version. Existing subscribers keep
  the price they're on, as Stripe does.

#### Stripe

- Checkout takes a plan key and an interval instead of the fixed Pro prices. `STRIPE_PRICE_PRO_*` go away.
- The webhook finds the version from the price id. A price it doesn't know is logged and alerted, and the workspace
  stays as it was.
- Changing tiers, including the prorated charge, happens in Stripe's billing portal. Its list of products is set up in
  Stripe to match the plans.
- Downgrading, by the customer or a lapse, follows ADR-0020 §3: nothing new beyond the lower plan can be added, and
  everything that exists stays readable, editable and exportable.

### 2. Each plan has an AI allowance

- **The limit that applies** is the smaller of the plan's `aiMonthlyMicroUsd` and the customer's own
  `monthlyBudgetUsd`. A customer can set a lower limit, never a higher one.
- **The month** is the one the gateway already counts in `app.ai_usage`: the calendar month in UTC.
- **Dollars stay inside.** The allowance is held in micro-dollars, because a scan costs far more than categorizing a
  transaction, and a count of calls would be wrong either way. Customers see a share: "70% of this month's AI used".
- **When it runs low**, the gateway already moves to the smaller model (`DOWNGRADE_AT`), now against this limit. At
  80% and at 100% the workspace's owners get a notification.
- **When it's used up**, AI tasks return `ok: false` with `reason: 'budget'`, as they already can, and features fall
  back as when AI fails: scans and statements can still be filed and entered by hand, transactions are categorized by
  rules only, and voice entry isn't offered. Nothing already done is undone.
- **The operator's ceiling.** A service-wide monthly limit (`ai_monthly_ceiling_micro_usd`, a system setting) stops
  all AI once the whole service has spent it, and alerts staff. It's a circuit breaker against a bug or abuse, not a
  plan limit.
- **Top-ups** (buying more AI for one month) are left for later. The design allows a one-month credit row to be added
  to the allowance.

### 3. The platform owner

Staff roles become three, each including the one below it:

| Role      | Can                                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| `support` | Support requests, and a read-only session on a workspace whose owner has granted it (unchanged, ADR-0020 §8)      |
| `admin`   | Accounts (§4), feature flags, notices, app versions, password policy, reference data, analytics                   |
| `owner`   | Staff, plans, provider settings (§5), the operator's AI ceiling, and closing an account on request                |

- **The first owner** is made with `staff:add --role owner`, which needs the database owner's URL, as today. Every other
  staff change is made in the console by an owner.
- **In the database**, staff and plan changes go through `admin_*` definer functions that check the caller's role with
  `app.staff_role`. `montra_admin` still has no grant on any financial table (ADR-0020 §6), and `rls.test.ts` keeps
  pinning that.
- **There's always an owner.** Removing or demoting the last one is refused.
- **Step-up.** Staff already need a second factor. Changing staff, plans, provider settings or the AI ceiling, and
  suspending or closing an account, also need a sign-in in the last 15 minutes, as revealing a tenant's date of birth
  does.
- **Everything is logged** in `admin_log`. A staff change is also emailed to every owner.
- **Staff SSO** is still not built. `AuthPort` doesn't change.

### 4. Managing accounts

Staff still never see money: no balances, transactions, notes, payslips or tenants. The console shows people,
workspaces, plans and usage (AI spent, storage used, texts sent).

- **Suspend and restore** (`admin`). Suspension is for abuse, fraud or a legal hold, never for a missed payment, which
  is ADR-0020 §3's lapse.
  - A suspended person can't sign in, and their sessions are revoked through Kratos's admin API.
  - Workspaces they own are closed to every member, with a message that names support. The data is kept.
  - A reason is required. The person is emailed unless the reason is a legal hold.
  - Restoring reverses all of it.
- **Extend a trial** (`admin`), up to 30 days at a time.
- **Give a plan** (`admin`): a subscription with provider `comp`, a version and an end date, which never touches Stripe.
  A workspace that pays through Stripe gets a Stripe coupon instead.
- **Close an account on request** (`owner`): starts the deletion the person could have started themselves (ADR-0019
  §12), with the same 30 days to change their mind. The request must come from the account's email address, and the
  staff member records where it came from.

### 5. Provider settings: keys in the environment, everything else visible

**Secrets never go in the database or the console.** That covers SMTP passwords, Twilio and Stripe keys, the Sentry
DSN, AI keys and storage keys. Two reasons:

- **Security.** A hijacked staff session that could edit them could send every sign-in code, and with it every account,
  to a server its holder controls.
- **It wouldn't take effect.** Kratos reads its courier settings when it starts, so a value changed in the console
  wouldn't reach it.

Secrets come from the environment, or from a file named in `<NAME>_FILE`, filled in by whatever runs Montra
(ADR-0050).

The console gets a **Providers** page, for owners, with one row each for:

- email (the API's mail and Kratos's courier);
- text messages (§6);
- payments;
- error reporting;
- AI, with any failover provider;
- file storage;
- key management;
- push;
- exchange rates.

Each row shows:

- whether the provider is set up;
- its mode;
- what isn't secret, such as the sender address or a key's id;
- the last successful use and the last failure.

Owners can also send a test email or text, to their own verified address or number.

What isn't secret is editable there, in `app.system_setting`:

- the API's sender name and address, and the support address;
- which kinds of text are on (sign-in codes, security alerts, reminders);
- the countries texts may go to.

Kratos's own sender address stays in its configuration, because Kratos reads it only at start. The Providers page says
so.

### 6. Text messages through Twilio

- **What's texted:**
  - Kratos's codes: account recovery, and a second factor by texted code.
  - The API's code that confirms a phone number (see "Confirming a number" below).
  - Security alerts (ADR-0045), when the person turns them on.
  - Reminders, such as bills due, on plans whose `smsMonthly` is above 0.
- **Email stays the sign-in identifier.** A phone number is an extra, verified address. Texted codes are the weakest
  second factor (SIM swapping), so passkeys and authenticator apps stay first, and a texted code is offered after them.
- **Twilio Programmable Messaging**, through a Messaging Service, not Twilio Verify. Kratos makes and checks its own
  codes, and Verify would be a second code system beside it.
  - **Kratos's codes:** Kratos posts to Twilio through an HTTP courier channel (`courier.channels`, id `sms`), with
    the account id and token from the environment.
  - **The API's texts:** they go through an `SmsPort`, with `log`, `memory` and `twilio` modes, as mail does.
- **Phone numbers** are stored in E.164 form in Kratos's identity traits. A changed number sends an identity change
  alert to the email address (ADR-0045).
- **Confirming a number** (changed 2026-11-15): the API texts its own code, not Kratos. Kratos v26.2.0 texts a code
  when a number is saved in a settings flow, but never names the verification flow that code belongs to (no
  `continue_with`, native or browser), and a new verification flow takes only an email address, so the code can't be
  entered anywhere. Instead:
  - `POST /v1/me/phone` texts a 6-digit code (no link) to the number, through `TextsService` and `SmsPort`. The code
    is hashed, lasts 10 minutes, and is single use (`app.phone_verification`, migration 0056).
  - `POST /v1/me/phone/confirm` checks it, then puts the number on the identity already verified, through Kratos's
    admin API, which texts nothing. A number is never on the identity unverified, so Kratos never texts its own code.
  - Changing or removing the number needs a recent sign-in. Each change is logged and emailed, as before.
  - Kratos's settings no longer change the number: the web's profile form keeps it as a hidden field, and the auth
    gateway turns away a settings save that would change it.
- **Against SMS pumping**, which is fraud that racks up text charges:
  - texts go only to countries on the allowed list;
  - Twilio's SMS pumping protection is on;
  - code texts are limited per number and per IP by the auth gateway's throttle (ADR-0042).
- **Opting out:** Twilio's Advanced Opt-Out handles STOP and HELP. A number that has opted out gets no reminders, and
  the person is told to use email or another second factor.
- **Before launch in the US,** texting from a long code needs A2P 10DLC brand and campaign registration, or a verified
  toll-free number. Either takes weeks, and goes on the launch checklist.
- **Without Twilio,** text messaging is off and everything goes by email, which is how self-hosting and tests work.

## Build order

Each step is its own PR into `develop`, and works on its own:

1. **Plans as data and the AI allowance.** The migration, entitlements from versions, Stripe by plan, and the gateway
   limit with notifications. It's seeded so nothing changes for anyone.
2. **The owner and plans in the console.** The owner role, staff management, the plans editor, and moving subscribers.
   The plan picker and the AI usage bar on web and phone.
3. **Managing accounts.** Suspend and restore, trials, given plans, and closing on request.
4. **Providers.** The Providers page, test sends, and secrets from `_FILE`.
5. **Text messages.** Kratos's SMS channel, `SmsPort`, phone numbers in Settings, and texted alerts.

## Settled while building

- **Step 1 (migration 0051):**
  - The plan's AI allowance and the operator's ceiling apply to built-in AI, which the operator pays for. With the
    customer's own key or a local model, only their own `monthlyBudgetUsd` applies, and that spend doesn't count
    towards the ceiling (`ai_usage.builtin_micro_usd`).
  - A budget the customer sets above the plan's allowance has no effect, rather than being refused, so lowering a
    plan can't leave a saved setting that blocks every other AI setting.
  - The seeded feature keys are `payroll`, `staffTime`, `scans`, `voice` and `ownStorage`, all on for Free and Pro.
    A plan without one refuses adding: a new payroll person, staff time, a scan, or connecting storage. Voice entry
    happens on the phone, which hides the microphone.
  - `familyLogins` counts active members and open invites, and null means no limit. Free and Pro have none, as
    before.
  - A price id the webhook doesn't know is logged and sent to error reporting.
  - The ceiling is `ai_monthly_ceiling_micro_usd` in `app.system_setting`, set from the console's AI tab. Reaching
    it emails every admin on staff (and owner) once a month.
- **Step 2 (migration 0052):**
  - A version has a start (`effective_from`). A plan's current version is the newest that has started, and it's
    what new customers and Free's workspaces get. A version that gives less than the current one starts at least
    30 days out. For Free, every workspace without a paid plan is told by email.
  - "Gives less" means any limit lower or any feature removed, even if something else rises
    (`compareEntitlements`).
  - A price stays with the plan until it's replaced. New customers pay the newest active price for the interval on
    the current version or an earlier one, so a new version needn't repeat an unchanged price.
  - The webhook uses a price id to find the plan. A subscriber already on that plan keeps the version they're held
    on, so a move survives Stripe still charging the old price. A new subscriber, or a change of tier, gets the
    plan's current version.
  - Moves are between versions of one plan. A pending move applies in the hourly billing sweep, from the first
    renewal on or after its date (`first_renewal` steps the period end by the interval). Customers are told
    by the same sweep.
  - Step-up uses the API's existing recent sign-in check (`requireRecentAuth`, 10 minutes), which is the one
    revealing a tenant's date of birth uses.
  - Listing staff is the owner's too, as managing them is. Admins can see plans but not change them.
- **Step 3 (migration 0053):**
  - Suspension sets the Kratos identity inactive, which refuses sign-in, and deletes its sessions. The API refuses
    the person too (`account.suspended`), and a workspace an active owner of which is suspended
    (`workspace.suspended`). The web sends both to a public page that names support.
  - A suspension and the reason for it are visible only to staff. The person's security log shows that it happened
    and when it ended, with no reason.
  - "A Stripe coupon instead" means the console applies a coupon id made in Stripe's dashboard to the subscription.
    It doesn't create coupons. A given plan needs an end date. It stops counting at that time by the clock, and the
    hourly sweep writes it down.
  - Extending a trial changes Stripe first, so the next webhook doesn't undo it.
  - Closing on request is the person's own deletion, started for them. The security log calls it
    `deletion_requested_by_support`, and they can still cancel it.
- **Step 4 (migration 0054):**
  - Last success and last failure are recorded as calls happen. The email, payment, storage, key and push ports are
    wrapped (`trackedProvider`), and built-in AI and exchange rates are noted where they run. A success is written
    at most every five minutes. A failure keeps a short message with addresses, URLs and long tokens cut out.
    Error reporting can't report on itself, so its row shows only whether it's set up.
  - What's shown is never secret: an SMTP or Sentry host without its credentials, test or live for the Stripe
    key, whether a key or webhook secret is set, and the AWS KMS key's id.
  - An empty sender or support address means the environment's. Until an owner says otherwise, all three kinds of
    text are on and texts go only to US numbers.
  - A test email goes to the owner's own address. A test text waits for step 5.
  - `_FILE` secrets are ADR-0050's, built in its own PR.
- **Step 5 (migration 0055):**
  - Kratos: the identity schema gains `phone` (E.164), verified by a texted code (the API's, since migration 0056),
    and a `code` identifier by text for
    the second factor. Email is no longer a `code` identifier. Nothing used it, and with codes as a second factor it
    would have made an emailed code count as one. The SMS channel holds the Twilio token, so it's set only through
    `COURIER_CHANNELS` on Kratos, with `SELFSERVICE_METHODS_CODE_MFA_ENABLED`. Run against Kratos v26.2.0 with a
    stand-in for Twilio, both kinds of text went out as Twilio's form.
  - Recovery stays by email: Kratos v26.2.0's recovery form takes only an email address.
  - The API keeps a copy of the number and whether it's verified (`app_user.phone_e164`), refreshed from the
    Kratos session. A change is logged (`phone_changed`) and emailed to the sign-in address.
  - Allowed countries are found from the number without a library: a table of calling codes, and within +1, Canada's
    and the Caribbean's area codes. An unknown country is never texted.
  - The kinds the owner switches on are sign-in codes, security alerts and reminders. Only the last two are the API's.
    Sign-in codes are switched on Kratos, by the variables above.
  - Security alerts by text (a new device, a password or two-step change) and reminders by text (bills due, reminders,
    tax dates, rent overdue, a lease expiring) are each off until the person turns them on. A text carries the title
    only, as push does: never a figure. Reminders take one of the plan's `smsMonthly` each (`app.sms_usage`).
  - Twilio's STOP answer (error 21610) marks the number opted out, and it gets no texts until it changes.
  - The auth gateway limits texted codes to 5 an hour per number and per address. A wrong texted code counts against
    the session, as an authenticator code does.
- **Confirming a number through the API (migration 0056):**
  - The code is counted under the gateway's `sms_send` limit with the same key per number, so a number gets 5 an hour
    whoever sends them, and per person rather than per address (the web's server calls the API, so an address there
    would be the server's). Only a country on the allowed list, and not a number already confirmed on another account.
  - Five tries per code, and 10 wrong codes in 15 minutes per person across codes.
  - Kratos v26.2.0 doesn't keep an identity's `verifiable_addresses` in a fixed order and has no JSON Patch `test`, so
    the adapter writes the whole list back with the number's address marked verified, then reads it again. It also
    keeps a removed number as a sign-in code identifier, which would stop anyone else adding it, so removing the
    number removes the code credential too (email isn't a code identifier).

## Consequences

- A release is no longer needed to add a tier or change what one includes. Adding a feature still needs code, and a
  migration that gives existing plans a default.
- Tests that use `entitlementsFor('pro')` move to seeded versions. A test pins that a subscribed version can't be
  edited.
- The AI allowance makes AI cost predictable per customer. What each plan includes is still the owner's pricing
  decision.
- More rides on staff accounts. That's why owners need step-up for sensitive changes, why keys stay out of the
  console, and why every staff change is emailed to all owners.
- Texts cost money per message, and registration in the US takes weeks before launch.
- Store billing is still not built (ADR-0020 §5). `plan_price` allows `apple` and `google` when it is.

## Alternatives considered

- **More plans in code.** Simple, but every pricing change becomes a release, and it's what the owner asked to move
  away from.
- **Entitlements from Stripe product metadata.** It keeps everything in one place, but Montra would depend on Stripe to
  know what someone can do, and would have no answer with billing off or Stripe down.
- **A count of AI calls or scans per plan.** Easier to explain, but the cost of a call varies widely by task and model.
  The allowance is in dollars, and customers see a share.
- **Provider keys editable in the console.** Convenient, but the risk is described in §5, and Kratos wouldn't pick up
  a change anyway.
- **Twilio Verify for codes.** It runs its own codes, which would duplicate Kratos's and split recovery and second
  factors across two systems.
- **Phone number sign-in.** Weaker than email with passkeys, and it ties an account to a number that can be recycled.

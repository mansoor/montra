/** The payment provider (OPS-08, ADR-0020 §4): checkout and the portal mean card details never reach Montra. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, type Provider } from '@nestjs/common';
import { TRIAL_DAYS } from '@montra/domain';
import { AppError } from '../common/errors.js';
import { CONFIG, type AppConfig } from '../config.js';

export interface ProviderSubscription {
  id: string;
  customer: string;
  /** As the provider says it: trialing, active, past_due, unpaid, canceled, incomplete, incomplete_expired, paused. */
  status: string;
  interval: 'month' | 'year' | null;
  /** The provider's price id, which says which plan version it's for (ADR-0049 §1). */
  priceId: string | null;
  trialEnd: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  workspaceId: string | null;
}

export interface CheckoutInput {
  workspaceId: string;
  /** The provider's price id, from the plan version's `plan_price`. */
  price: string;
  customer: string | null;
  email: string;
  trial: boolean;
  successUrl: string;
  cancelUrl: string;
}

export interface BillingEvent {
  id: string;
  type: string;
  /** The subscription this event is about, if any. It's read back from the provider, so order doesn't matter. */
  subscription: string | null;
}

export interface BillingPort {
  checkoutUrl(input: CheckoutInput): Promise<string>;
  portalUrl(customer: string, returnUrl: string): Promise<string>;
  subscription(id: string): Promise<ProviderSubscription>;
  /** Checks the signature against the raw body, and refuses anything else. */
  parseEvent(rawBody: Buffer, signature: string | undefined): BillingEvent;
}
export const BILLING_PORT = Symbol('BILLING_PORT');

/** Five minutes either way, as Stripe's own libraries allow, so an old signed request can't be replayed. */
const SIGNATURE_TOLERANCE_SECONDS = 300;
const API_VERSION = '2025-03-31.basil';

export function verifyStripeSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
  now: number = Date.now(),
): void {
  const bad = () => new AppError(400, 'billing.bad_signature', 'The signature is not valid');
  if (!header) throw bad();
  const parts = header.split(',').map((p) => p.split('='));
  const timestamp = Number(parts.find(([k]) => k === 't')?.[1]);
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
  if (!Number.isFinite(timestamp) || signatures.length === 0) throw bad();
  if (Math.abs(now / 1000 - timestamp) > SIGNATURE_TOLERANCE_SECONDS) throw bad();
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
  const matches = signatures.some((s) => {
    const given = Buffer.from(s, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!matches) throw bad();
}

type StripeObject = Record<string, unknown>;

const date = (seconds: unknown): Date | null =>
  typeof seconds === 'number' ? new Date(seconds * 1000) : null;

const idOf = (v: unknown): string | null =>
  typeof v === 'string'
    ? v
    : typeof (v as StripeObject | null)?.id === 'string'
      ? ((v as StripeObject).id as string)
      : null;

@Injectable()
export class StripeBilling implements BillingPort {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  private async call(method: 'GET' | 'POST', path: string, form?: URLSearchParams): Promise<StripeObject> {
    const res = await fetch(`${this.config.STRIPE_API_URL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.config.STRIPE_SECRET_KEY}`,
        'stripe-version': API_VERSION,
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(form ? { body: form.toString() } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as StripeObject;
    if (!res.ok) {
      // The provider's message can mention customer details, so it stays out of what's shown.
      throw new AppError(502, 'billing.provider_error', 'The payment provider could not do that just now');
    }
    return body;
  }

  async checkoutUrl(input: CheckoutInput): Promise<string> {
    const form = new URLSearchParams({
      mode: 'subscription',
      'line_items[0][price]': input.price,
      'line_items[0][quantity]': '1',
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.workspaceId,
      'subscription_data[metadata][workspace_id]': input.workspaceId,
    });
    if (input.customer) form.set('customer', input.customer);
    else form.set('customer_email', input.email);
    if (input.trial) form.set('subscription_data[trial_period_days]', String(TRIAL_DAYS));
    const session = await this.call('POST', '/v1/checkout/sessions', form);
    return session.url as string;
  }

  async portalUrl(customer: string, returnUrl: string): Promise<string> {
    const session = await this.call(
      'POST',
      '/v1/billing_portal/sessions',
      new URLSearchParams({ customer, return_url: returnUrl }),
    );
    return session.url as string;
  }

  async subscription(id: string): Promise<ProviderSubscription> {
    const s = await this.call('GET', `/v1/subscriptions/${encodeURIComponent(id)}`);
    const item = ((s.items as StripeObject | undefined)?.data as StripeObject[] | undefined)?.[0];
    const price = item?.price as StripeObject | undefined;
    const interval = (price?.recurring as StripeObject | undefined)?.interval;
    return {
      id: s.id as string,
      customer: idOf(s.customer) ?? '',
      status: s.status as string,
      interval: interval === 'month' || interval === 'year' ? interval : null,
      priceId: idOf(price),
      trialEnd: date(s.trial_end),
      // Newer API versions moved this from the subscription onto its items.
      currentPeriodEnd: date(item?.current_period_end ?? s.current_period_end),
      cancelAtPeriodEnd: Boolean(s.cancel_at_period_end),
      workspaceId: ((s.metadata as StripeObject | undefined)?.workspace_id as string | undefined) ?? null,
    };
  }

  parseEvent(rawBody: Buffer, signature: string | undefined): BillingEvent {
    const secret = this.config.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new AppError(503, 'billing.not_configured', 'Plans are not available yet');
    verifyStripeSignature(rawBody, signature, secret);
    const event = JSON.parse(rawBody.toString('utf8')) as {
      id: string;
      type: string;
      data: { object: StripeObject };
    };
    const object = event.data.object;
    const subscription = event.type.startsWith('customer.subscription.')
      ? idOf(object.id)
      : event.type.startsWith('invoice.') || event.type === 'checkout.session.completed'
        ? (idOf(object.subscription) ??
          idOf(
            ((object.parent as StripeObject | undefined)?.subscription_details as StripeObject | undefined)
              ?.subscription,
          ))
        : null;
    return { id: event.id, type: event.type, subscription };
  }
}

/** Where plans aren't in use, nothing can reach a provider. */
export class NoBilling implements BillingPort {
  private refuse(): never {
    throw new AppError(404, 'not_found', 'Plans are not in use here');
  }
  checkoutUrl(): Promise<string> {
    return this.refuse();
  }
  portalUrl(): Promise<string> {
    return this.refuse();
  }
  subscription(): Promise<ProviderSubscription> {
    return this.refuse();
  }
  parseEvent(): BillingEvent {
    return this.refuse();
  }
}

export const billingProvider = (config: AppConfig): Provider =>
  config.BILLING_MODE === 'stripe'
    ? { provide: BILLING_PORT, useClass: StripeBilling }
    : { provide: BILLING_PORT, useClass: NoBilling };

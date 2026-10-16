import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { beforeAll, describe, expect, it } from 'vitest';
import { users } from '../src/db/schema.js';
import { db, req, resetDb, signup } from './helpers.js';

const SECRET = 'whsec_test_secret';
const stripe = new Stripe('sk_test_unused');

/** Posts an event to the real webhook endpoint with a valid Stripe signature. */
function sendEvent(type: string, object: Record<string, unknown>, secret = SECRET, created = Math.floor(Date.now() / 1000)) {
  const payload = JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, object: 'event', type, data: { object }, api_version: '2025-09-30.clover', created });
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });
  return req('/api/stripe/webhook', { method: 'POST', body: payload, headers: { 'stripe-signature': signature, 'content-type': 'application/json' } });
}
const userRow = async (id: string) => (await db.select().from(users).where(eq(users.id, id)))[0]!;

beforeAll(resetDb);

describe('Stripe webhook', () => {
  it('rejects bad or missing signatures', async () => {
    expect((await sendEvent('checkout.session.completed', {}, 'whsec_wrong')).status).toBe(400);
    const res = await req('/api/stripe/webhook', { method: 'POST', body: '{}', headers: { 'stripe-signature': 't=1,v1=abc' } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_signature');
  });

  it('walks a user through checkout -> renewal -> payment failure -> cancellation', async () => {
    const { user, cookie } = await signup();
    const start = Math.floor(Date.UTC(2026, 9, 3) / 1000);
    const end = Math.floor(Date.UTC(2026, 10, 3) / 1000);

    // 1. checkout completes -> Pro
    let res = await sendEvent('checkout.session.completed', { id: 'cs_1', object: 'checkout.session', mode: 'subscription', client_reference_id: user.id, customer: 'cus_123', subscription: 'sub_123' });
    expect(res.status).toBe(200);
    expect(await userRow(user.id)).toMatchObject({ plan: 'pro', planStatus: 'active', stripeCustomerId: 'cus_123', stripeSubscriptionId: 'sub_123' });

    // 2. subscription created/updated -> billing period mirrored (period on items, API >= 2025-03-31)
    const sub = { id: 'sub_123', object: 'subscription', customer: 'cus_123', status: 'active', metadata: { user_id: user.id }, items: { data: [{ current_period_start: start, current_period_end: end }] } };
    expect((await sendEvent('customer.subscription.updated', sub)).status).toBe(200);
    const u = await userRow(user.id);
    expect(u.periodStart?.toISOString()).toBe('2026-10-03T00:00:00.000Z');
    expect(u.periodEnd?.toISOString()).toBe('2026-11-03T00:00:00.000Z');
    const me = await (await req('/api/me', { cookie })).json();
    expect(me.period).toEqual({ start: '2026-10-03T00:00:00.000Z', end: '2026-11-03T00:00:00.000Z' });
    expect(me.usage.included_minutes).toBe(600);

    // 3. payment fails -> past_due (still Pro, but overage is no longer allowed)
    await sendEvent('invoice.payment_failed', { id: 'in_1', object: 'invoice', customer: 'cus_123' });
    expect(await userRow(user.id)).toMatchObject({ plan: 'pro', planStatus: 'past_due' });

    // 4. recovered
    await sendEvent('customer.subscription.updated', sub);
    expect(await userRow(user.id)).toMatchObject({ plan: 'pro', planStatus: 'active' });

    // 5. an event for some other, older subscription is ignored
    await sendEvent('customer.subscription.deleted', { ...sub, id: 'sub_old', status: 'canceled' });
    expect((await userRow(user.id)).plan).toBe('pro');

    // 6. cancelled -> Free
    await sendEvent('customer.subscription.deleted', { ...sub, status: 'canceled' });
    expect(await userRow(user.id)).toMatchObject({ plan: 'free', planStatus: 'canceled', stripeSubscriptionId: null, periodStart: null });
  });

  it('ignores late or retried events for a deleted subscription', async () => {
    const { user } = await signup();
    const t = Math.floor(Date.now() / 1000);
    const sub = { id: 'sub_late', object: 'subscription', customer: 'cus_late', status: 'active', metadata: { user_id: user.id }, items: { data: [] } };
    const checkout = { id: 'cs_late', object: 'checkout.session', mode: 'subscription', client_reference_id: user.id, customer: 'cus_late', subscription: 'sub_late' };
    await sendEvent('checkout.session.completed', checkout, SECRET, t - 100);
    await sendEvent('customer.subscription.deleted', { ...sub, status: 'canceled' }, SECRET, t);
    const free = { plan: 'free', planStatus: 'canceled', stripeSubscriptionId: null };
    expect(await userRow(user.id)).toMatchObject(free);

    // an older "active" update delivered late, a retried checkout, and a same-second update: all ignored
    await sendEvent('customer.subscription.updated', sub, SECRET, t - 50);
    expect(await userRow(user.id)).toMatchObject(free);
    await sendEvent('checkout.session.completed', checkout, SECRET, t - 100);
    expect(await userRow(user.id)).toMatchObject(free);
    await sendEvent('customer.subscription.updated', sub, SECRET, t);
    expect(await userRow(user.id)).toMatchObject(free);

    // a new subscription still works
    await sendEvent('customer.subscription.created', { ...sub, id: 'sub_new' }, SECRET, t + 10);
    expect(await userRow(user.id)).toMatchObject({ plan: 'pro', planStatus: 'active', stripeSubscriptionId: 'sub_new' });
  });

  it('downgrades unpaid-incomplete subscriptions and ignores unknown customers', async () => {
    const { user } = await signup();
    await sendEvent('customer.subscription.created', { id: 'sub_9', object: 'subscription', customer: 'cus_9', status: 'incomplete', metadata: { user_id: user.id }, items: { data: [] } });
    expect(await userRow(user.id)).toMatchObject({ plan: 'free', stripeCustomerId: 'cus_9' });
    expect((await sendEvent('invoice.payment_failed', { id: 'in_x', object: 'invoice', customer: 'cus_unknown' })).status).toBe(200);
    expect((await sendEvent('customer.created', { id: 'cus_z', object: 'customer' })).status).toBe(200);
  });
});

describe.skipIf(Boolean(process.env.STRIPE_SECRET_KEY))('billing endpoints without Stripe keys', () => {
  it('reports manual billing and refuses checkout', async () => {
    const { cookie } = await signup();
    expect((await (await req('/api/billing', { cookie })).json()).mode).toBe('manual');
    const res = await req('/api/billing/checkout', { cookie, method: 'POST' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('billing_manual');
  });
});

describe('metered overage reporting', () => {
  it('sends only unreported overage events, keyed by usage event id', async () => {
    const { createServer } = await import('node:http');
    const { randomUUID } = await import('node:crypto');
    const { usageEvents } = await import('../src/db/schema.js');
    const { reportOverage, setStripeClient } = await import('../src/stripe.js');

    const received: URLSearchParams[] = [];
    const server = createServer((rq, rs) => {
      let body = '';
      rq.on('data', (d) => (body += d));
      rq.on('end', () => {
        if (rq.url === '/v1/billing/meter_events') received.push(new URLSearchParams(body));
        rs.setHeader('content-type', 'application/json');
        rs.end(JSON.stringify({ object: 'billing.meter_event', event_name: 'opstrellis_managed_minutes' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    setStripeClient(new Stripe('sk_test_fake', { host: '127.0.0.1', port, protocol: 'http' }));
    try {
      const { user } = await signup();
      await db.update(users).set({ plan: 'pro', stripeCustomerId: 'cus_meter' }).where(eq(users.id, user.id));
      const base = { userId: user.id, source: 'gateway' as const, mode: 'cloud' as const, provider: 'local', model: 'local/moonshine-tiny-en', audioSeconds: 60 };
      const overId = randomUUID();
      await db.insert(usageEvents).values([
        { ...base, id: overId, overageMinutes: 2, billedUsd: 0.04 },
        { ...base, id: randomUUID(), overageMinutes: 0 },
      ]);
      expect(await reportOverage()).toBe(1);
      expect(received).toHaveLength(1);
      expect(received[0]!.get('event_name')).toBe('opstrellis_managed_minutes');
      expect(received[0]!.get('identifier')).toBe(overId);
      expect(received[0]!.get('payload[stripe_customer_id]')).toBe('cus_meter');
      expect(received[0]!.get('payload[value]')).toBe('2');
      // already reported -> nothing more to send
      expect(await reportOverage()).toBe(0);
    } finally {
      setStripeClient(null);
      server.close();
    }
  });
});

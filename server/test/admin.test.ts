import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { providerKeys, usageEvents } from '../src/db/schema.js';
import { getProviderKey } from '../src/providers.js';
import { createToken, db, req, resetDb, signup, userWithToken } from './helpers.js';

let adminCookie: string;
let adminId: string;
let adminToken: string;
let user: Awaited<ReturnType<typeof userWithToken>>;

beforeAll(async () => {
  await resetDb();
  const a = await signup('admin@example.com'); // first user -> admin
  adminCookie = a.cookie;
  adminId = a.user.id;
  adminToken = await createToken(adminCookie);
  user = await userWithToken('regular@example.com');
});

const ADMIN_ROUTES: [string, string, unknown?][] = [
  ['GET', '/api/admin/stats'],
  ['GET', '/api/admin/users'],
  ['GET', `/api/admin/users/${randomUUID()}`],
  ['PATCH', `/api/admin/users/${randomUUID()}`, { plan: 'pro' }],
  ['GET', '/api/admin/models'],
  ['POST', '/api/admin/models', {}],
  ['PATCH', '/api/admin/models/local/moonshine-tiny-en', { enabled: false }],
  ['DELETE', '/api/admin/models/local/moonshine-tiny-en'],
  ['GET', '/api/admin/providers'],
  ['PUT', '/api/admin/providers/openai', { key: 'sk-xxxxxxxxxxxx' }],
  ['DELETE', '/api/admin/providers/openai'],
];

describe('admin authorization', () => {
  it.each(ADMIN_ROUTES)('%s %s is 403 for non-admins (cookie and token) and 401 anonymous', async (method, path, json) => {
    expect((await req(path, { method, cookie: user.cookie, json })).status).toBe(403);
    expect((await req(path, { method, token: user.token, json })).status).toBe(403);
    expect((await req(path, { method, json })).status).toBe(401);
  });

  // A token can come from a device sign-in an admin was tricked into approving.
  it.each(ADMIN_ROUTES)('%s %s refuses an admin API token', async (method, path, json) => {
    expect((await req(path, { method, token: adminToken, json })).status).toBe(403);
  });
});

describe('admin users', () => {
  it('searches and paginates', async () => {
    for (let i = 0; i < 5; i++) await signup(`page-${i}@example.org`);
    const page1 = await (await req('/api/admin/users?q=example.org&page_size=2', { cookie: adminCookie })).json();
    expect(page1.total).toBe(5);
    expect(page1.users).toHaveLength(2);
    const page3 = await (await req('/api/admin/users?q=example.org&page_size=2&page=3', { cookie: adminCookie })).json();
    expect(page3.users).toHaveLength(1);
    const like = await (await req(`/api/admin/users?q=${encodeURIComponent('%')}`, { cookie: adminCookie })).json();
    expect(like.total).toBe(0); // wildcards are escaped
  });

  it('changes plan, role and disabled flag, and shows usage', async () => {
    const id = user.user.id;
    await db.insert(usageEvents).values({ id: randomUUID(), userId: id, source: 'gateway', mode: 'cloud', provider: 'local', model: 'local/moonshine-tiny-en', audioSeconds: 120, words: 300 });
    let res = await req(`/api/admin/users/${id}`, { method: 'PATCH', cookie: adminCookie, json: { plan: 'pro' } });
    expect((await res.json()).user).toMatchObject({ plan: 'pro', plan_status: 'active' });
    const detail = await (await req(`/api/admin/users/${id}`, { cookie: adminCookie })).json();
    expect(detail.summary.usage).toMatchObject({ managed_minutes: 2, included_minutes: 600 });
    expect(detail.stats.totals.words).toBe(300);
    expect(detail.recent_events).toHaveLength(1);
    const list = await (await req('/api/admin/users?q=regular@', { cookie: adminCookie })).json();
    expect(list.users[0].managed_minutes_this_month).toBe(2);

    res = await req(`/api/admin/users/${id}`, { method: 'PATCH', cookie: adminCookie, json: { disabled: true } });
    expect((await res.json()).user.disabled).toBe(true);
    expect((await req('/api/me', { cookie: user.cookie })).status).toBe(401); // sessions revoked
    expect((await req('/api/me', { token: user.token })).status).toBe(403);
    await req(`/api/admin/users/${id}`, { method: 'PATCH', cookie: adminCookie, json: { disabled: false } });
    expect((await req('/api/me', { token: user.token })).status).toBe(200);
  });

  it('refuses to let an admin demote or disable themselves', async () => {
    const res = await req(`/api/admin/users/${adminId}`, { method: 'PATCH', cookie: adminCookie, json: { role: 'user' } });
    expect(res.status).toBe(400);
  });

  it('reports global stats', async () => {
    const stats = await (await req('/api/admin/stats', { cookie: adminCookie })).json();
    expect(stats.users.total).toBeGreaterThanOrEqual(7);
    expect(stats.users.pro).toBe(1);
    expect(stats.this_month.managed_minutes).toBe(2);
    expect(stats.this_month.subscription_revenue_usd).toBe(12);
    expect(stats.per_model[0]).toMatchObject({ model: 'local/moonshine-tiny-en', requests: 1 });
    expect(stats.monthly.length).toBeGreaterThanOrEqual(1);
  });
});

describe('admin catalog', () => {
  it('creates, updates and deletes models', async () => {
    const created = await req('/api/admin/models', {
      method: 'POST',
      cookie: adminCookie,
      json: { id: 'openrouter/meta-llama-3.1-8b', kind: 'llm', provider: 'openrouter', upstream_model: 'meta-llama/llama-3.1-8b-instruct', display_name: 'Llama 3.1 8B', input_per_1m_usd: 0.02, output_per_1m_usd: 0.03 },
    });
    expect(created.status).toBe(201);
    expect((await req('/api/admin/models', { method: 'POST', cookie: adminCookie, json: { id: 'openrouter/meta-llama-3.1-8b', kind: 'llm', provider: 'x', upstream_model: 'x', display_name: 'x' } })).status).toBe(409);
    expect((await req('/api/admin/models', { method: 'POST', cookie: adminCookie, json: { id: 'bad id', kind: 'llm', provider: 'x', upstream_model: 'x', display_name: 'x' } })).status).toBe(400);

    const upd = await req('/api/admin/models/openrouter/meta-llama-3.1-8b', { method: 'PATCH', cookie: adminCookie, json: { enabled: false, fallback_order: 5 } });
    expect((await upd.json()).model).toMatchObject({ enabled: false, fallback_order: 5, upstream_model: 'meta-llama/llama-3.1-8b-instruct' });
    const catalog = await (await req('/api/catalog')).json();
    expect(catalog.models.map((m: any) => m.id)).not.toContain('openrouter/meta-llama-3.1-8b');

    expect((await req('/api/admin/models/openrouter/meta-llama-3.1-8b', { method: 'DELETE', cookie: adminCookie })).status).toBe(200);
    expect((await req('/api/admin/models/openrouter/meta-llama-3.1-8b', { method: 'DELETE', cookie: adminCookie })).status).toBe(404);
  });
});

describe('admin provider keys', () => {
  it('stores keys encrypted and never returns them', async () => {
    const key = 'dg-secret-key-1234567890abcd';
    expect((await req('/api/admin/providers/deepgram', { method: 'PUT', cookie: adminCookie, json: { key } })).status).toBe(200);
    const [row] = await db.select().from(providerKeys).where(eq(providerKeys.provider, 'deepgram'));
    expect(row!.ciphertext).not.toContain(key);
    expect(Buffer.from(row!.ciphertext, 'base64').toString('utf8')).not.toContain(key);
    expect(await getProviderKey('deepgram')).toBe(key);

    const list = await req('/api/admin/providers', { cookie: adminCookie });
    const text = await list.text();
    expect(text).not.toContain(key);
    const dg = JSON.parse(text).providers.find((p: any) => p.provider === 'deepgram');
    expect(dg).toMatchObject({ source: 'database', last4: 'abcd' });

    expect((await req('/api/admin/providers/nope', { method: 'PUT', cookie: adminCookie, json: { key } })).status).toBe(404);
    await req('/api/admin/providers/deepgram', { method: 'DELETE', cookie: adminCookie });
    expect(await getProviderKey('deepgram')).toBe(process.env.DEEPGRAM_API_KEY || null);
  });
});

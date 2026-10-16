import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { deviceCodes, users } from '../src/db/schema.js';
import { cookieFrom, createToken, db, req, resetDb, signup, sql } from './helpers.js';

beforeAll(resetDb);

describe('signup / login / sessions', () => {
  it('makes the first user an admin and later users regular users', async () => {
    const first = await signup('first@example.com');
    expect(first.user.role).toBe('admin');
    const second = await signup('second@example.com');
    expect(second.user.role).toBe('user');
  });

  it('does not grant admin at signup from ADMIN_EMAILS (the email is unverified)', async () => {
    const boss = await signup('BOSS@example.com'); // listed in ADMIN_EMAILS by vitest.config.ts
    expect(boss.user.role).toBe('user');
  });

  it('rejects JSON bodies over 64 KB, except on /api/usage', async () => {
    const big = await req('/api/auth/login', { json: { email: 'a@example.com', password: 'x'.repeat(100_000) } });
    expect(big.status).toBe(413);
    const { cookie } = await signup();
    const events = Array.from({ length: 500 }, () => ({ id: randomUUID(), provider: 'local', model: 'moonshine-tiny-en-local-model', mode: 'local', audio_seconds: 1, words: 3, created_at: new Date().toISOString() }));
    const usage = await req('/api/usage', { cookie, json: { events } });
    expect(usage.status).toBe(200);
    expect((await usage.json()).accepted).toBe(500);
  });

  it('rejects duplicate emails and weak passwords', async () => {
    expect((await req('/api/auth/signup', { json: { email: 'first@example.com', password: 'longenough1' } })).status).toBe(409);
    const weak = await req('/api/auth/signup', { json: { email: 'x@example.com', password: 'short' } });
    expect(weak.status).toBe(400);
    expect((await weak.json()).error).toBe('invalid_request');
  });

  it('logs in, exposes /api/me, and logs out', async () => {
    const { email, password } = await signup();
    const bad = await req('/api/auth/login', { json: { email, password: 'wrong password' } });
    expect(bad.status).toBe(401);
    const res = await req('/api/auth/login', { json: { email: email.toUpperCase(), password } });
    expect(res.status).toBe(200);
    const cookie = cookieFrom(res);
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect(res.headers.get('set-cookie')).toMatch(/SameSite=Lax/i);

    const me = await (await req('/api/me', { cookie })).json();
    expect(me).toMatchObject({ user: { email }, plan: 'free', usage: { managed_minutes: 0, included_minutes: 15 } });

    expect((await req('/api/auth/logout', { cookie, method: 'POST' })).status).toBe(200);
    expect((await req('/api/me', { cookie })).status).toBe(401);
  });

  it('rejects cookie-authenticated mutations from another origin (CSRF)', async () => {
    const { cookie } = await signup();
    const res = await req('/api/tokens', { cookie, json: { name: 'x' }, headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('csrf');
    // GET is fine cross-origin (read-only, and the browser blocks reading the response)
    expect((await req('/api/me', { cookie, headers: { origin: 'https://evil.example' } })).status).toBe(200);
  });

  it('rate limits login attempts per IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await req('/api/auth/login', { ip: '203.0.113.9', json: { email: 'nobody@example.com', password: 'whatever1' } });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('rate limits by the proxy-appended (rightmost) X-Forwarded-For entry', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      // the client controls everything left of what our proxy appended
      const headers = { 'x-forwarded-for': `198.51.100.${i}, 203.0.113.10` };
      statuses.push((await req('/api/auth/login', { headers, json: { email: 'nobody@example.com', password: 'whatever1' } })).status);
    }
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('blocks disabled users everywhere', async () => {
    const s = await signup();
    const token = await createToken(s.cookie);
    await db.update(users).set({ disabled: true }).where(eq(users.id, s.user.id));
    expect((await req('/api/me', { token })).status).toBe(403);
    expect((await req('/api/me', { cookie: s.cookie })).status).toBe(403);
    expect((await req('/api/auth/login', { json: { email: s.email, password: s.password } })).status).toBe(403);
  });
});

describe('API tokens', () => {
  it('creates, uses, lists and revokes tokens', async () => {
    const { cookie } = await signup();
    const created = await (await req('/api/tokens', { cookie, json: { name: 'laptop' } })).json();
    expect(created.token).toMatch(/^utt_/);
    expect(created.prefix).toBe(created.token.slice(0, 10));

    expect((await req('/api/me', { token: created.token })).status).toBe(200);
    const list = await (await req('/api/tokens', { cookie })).json();
    expect(list.tokens).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(created.token); // only the prefix is ever shown
    expect(list.tokens[0].last_used_at).not.toBeNull();

    // A token cannot mint or list tokens.
    expect((await req('/api/tokens', { token: created.token, json: { name: 'x' } })).status).toBe(403);

    expect((await req(`/api/tokens/${created.id}`, { cookie, method: 'DELETE' })).status).toBe(200);
    expect((await req('/api/me', { token: created.token })).status).toBe(401);
  });

  it("cannot revoke another user's token", async () => {
    const a = await signup();
    const b = await signup();
    const created = await (await req('/api/tokens', { cookie: a.cookie, json: { name: 'a' } })).json();
    expect((await req(`/api/tokens/${created.id}`, { cookie: b.cookie, method: 'DELETE' })).status).toBe(404);
    expect((await req('/api/me', { token: created.token })).status).toBe(200);
  });

  it('rejects unknown bearer tokens with an OpenAI-style error on /v1', async () => {
    const res = await req('/v1/models', { token: 'utt_nope' });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatchObject({ type: 'unauthorized' });
  });
});

describe('device-code flow', () => {
  it('runs start -> pending -> approve -> token (once)', async () => {
    const start = await (await req('/api/device/start', { json: { device_name: 'Work laptop' } })).json();
    expect(start).toMatchObject({ interval: 5, expires_in: 600 });
    expect(start.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expect(start.verification_url).toBe(`http://localhost:8787/device?code=${start.user_code}`);

    const pending = await req('/api/device/poll', { json: { device_code: start.device_code } });
    expect(pending.status).toBe(428);
    expect(await pending.json()).toEqual({ error: 'authorization_pending' });

    const { cookie } = await signup();
    const info = await (await req(`/api/device/${start.user_code.toLowerCase().replace('-', '')}`, { cookie })).json();
    expect(info.device_name).toBe('Work laptop');
    expect((await req('/api/device/approve', { cookie, json: { user_code: start.user_code } })).status).toBe(200);
    // already approved -> code no longer usable
    expect((await req('/api/device/approve', { cookie, json: { user_code: start.user_code } })).status).toBe(404);

    const ok = await req('/api/device/poll', { json: { device_code: start.device_code } });
    expect(ok.status).toBe(200);
    const { token } = await ok.json();
    expect(token).toMatch(/^utt_/);
    expect((await (await req('/api/me', { token })).json()).user.email).toBeTruthy();
    const tokens = await (await req('/api/tokens', { cookie })).json();
    expect(tokens.tokens.map((t: { name: string }) => t.name)).toEqual(['Work laptop']);

    // the token is handed out once
    expect((await req('/api/device/poll', { json: { device_code: start.device_code } })).status).toBe(400);
  });

  it('returns 400 expired_token for expired codes and approval requires a session', async () => {
    const start = await (await req('/api/device/start', { json: {} })).json();
    await db.update(deviceCodes).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(deviceCodes.userCode, start.user_code));
    const res = await req('/api/device/poll', { json: { device_code: start.device_code } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('expired_token');

    const s = await signup();
    const token = await createToken(s.cookie);
    const fresh = await (await req('/api/device/start', { json: {} })).json();
    expect((await req('/api/device/approve', { token, json: { user_code: fresh.user_code } })).status).toBe(403);
  });

  it('approves a code once under concurrent approvals (no orphan token)', async () => {
    const start = await (await req('/api/device/start', { json: {} })).json();
    const { cookie } = await signup();
    // Hold the row so all three approvals pass the initial lookup before any of them writes.
    let pending: Promise<Response>[] = [];
    await sql.begin(async (tx) => {
      await tx`select 1 from device_codes where user_code = ${start.user_code} for update`;
      pending = [1, 2, 3].map(() => req('/api/device/approve', { cookie, json: { user_code: start.user_code } }));
      await new Promise((r) => setTimeout(r, 300));
    });
    const approvals = await Promise.all(pending);
    expect(approvals.map((r) => r.status).sort()).toEqual([200, 404, 404]);
    expect((await (await req('/api/tokens', { cookie })).json()).tokens).toHaveLength(1);
    expect((await req('/api/device/poll', { json: { device_code: start.device_code } })).status).toBe(200);
  });

  it('deny removes the request', async () => {
    const start = await (await req('/api/device/start', { json: {} })).json();
    const { cookie } = await signup();
    expect((await req('/api/device/deny', { cookie, json: { user_code: start.user_code } })).status).toBe(200);
    expect((await req('/api/device/poll', { json: { device_code: start.device_code } })).status).toBe(400);
  });
});

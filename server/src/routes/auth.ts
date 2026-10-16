// Email/password auth, API tokens, and the device-code flow for the desktop app.
import { randomInt } from 'node:crypto';
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { createApiToken, endSession, newApiToken, rateLimit, requireAuth, startSession, type AppEnv } from '../auth.js';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { apiTokens, deviceCodes, users } from '../db/schema.js';
import { hashPassword, randomToken, sha256, verifyPassword } from '../lib/crypto.js';
import { ApiError, iso, readJson } from '../lib/http.js';

export const authRoutes = new Hono<AppEnv>();

const email = z.string().trim().toLowerCase().pipe(z.email()).pipe(z.string().max(254));
const password = z.string().min(8, 'Password must be at least 8 characters').max(200);

// ---------- signup / login / logout ----------

authRoutes.post('/auth/signup', rateLimit('signup', 10), async (c) => {
  const body = await readJson(c, z.object({ email, password, name: z.string().trim().max(100).default('') }));
  const passwordHash = await hashPassword(body.password);
  const user = await db.transaction(async (tx) => {
    // Serialize signups so exactly one "first user" becomes admin. Other admins come from
    // `npm run db:seed` or the admin UI, never from an unverified signup email.
    await tx.execute(sql`select pg_advisory_xact_lock(42)`);
    const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, body.email));
    if (existing) throw new ApiError(409, 'email_taken', 'An account with this email already exists');
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(users);
    const role = n === 0 ? 'admin' : 'user';
    const [u] = await tx.insert(users).values({ email: body.email, name: body.name, passwordHash, role }).returning();
    return u!;
  });
  await startSession(c, user.id);
  return c.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } }, 201);
});

authRoutes.post('/auth/login', rateLimit('login', 10), async (c) => {
  const body = await readJson(c, z.object({ email, password: z.string().max(200) }));
  const [user] = await db.select().from(users).where(eq(users.email, body.email));
  // Same error for unknown email and wrong password.
  if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
    throw new ApiError(401, 'invalid_credentials', 'Wrong email or password');
  }
  if (user.disabled) throw new ApiError(403, 'account_disabled', 'This account is disabled');
  await startSession(c, user.id);
  return c.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

authRoutes.post('/auth/logout', async (c) => {
  await endSession(c);
  return c.json({ ok: true });
});

// ---------- API tokens (dashboard only) ----------

const tokenJson = (t: typeof apiTokens.$inferSelect) => ({
  id: t.id,
  name: t.name,
  prefix: t.prefix,
  last_used_at: iso(t.lastUsedAt),
  created_at: iso(t.createdAt),
});

authRoutes.get('/tokens', requireAuth({ sessionOnly: true }), async (c) => {
  const rows = await db.select().from(apiTokens).where(eq(apiTokens.userId, c.get('user').id)).orderBy(desc(apiTokens.createdAt));
  return c.json({ tokens: rows.map(tokenJson) });
});

authRoutes.post('/tokens', requireAuth({ sessionOnly: true }), async (c) => {
  const { name } = await readJson(c, z.object({ name: z.string().trim().min(1).max(100) }));
  const { token, row } = await createApiToken(c.get('user').id, name);
  return c.json({ token, ...tokenJson(row) }, 201);
});

authRoutes.delete('/tokens/:id', requireAuth({ sessionOnly: true }), async (c) => {
  const id = z.uuid().safeParse(c.req.param('id'));
  if (!id.success) throw new ApiError(404, 'not_found');
  const deleted = await db
    .delete(apiTokens)
    .where(and(eq(apiTokens.id, id.data), eq(apiTokens.userId, c.get('user').id)))
    .returning({ id: apiTokens.id });
  if (!deleted.length) throw new ApiError(404, 'not_found');
  return c.json({ ok: true });
});

// ---------- device-code flow ----------

const DEVICE_TTL_MS = 10 * 60_000;
const POLL_INTERVAL_S = 5;
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'; // no vowels (no words), no lookalikes

function userCode() {
  const pick = () => Array.from({ length: 4 }, () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]).join('');
  return `${pick()}-${pick()}`;
}
const normalizeUserCode = (s: string) => {
  const raw = s.toUpperCase().replace(/[^A-Z]/g, '');
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
};

authRoutes.post('/device/start', rateLimit('device-start', 20), async (c) => {
  const body = await readJson(
    c,
    z.object({ device_name: z.string().trim().max(100).optional(), client_name: z.string().trim().max(100).optional() }),
  );
  const deviceCode = randomToken();
  const code = userCode();
  await db.insert(deviceCodes).values({
    id: sha256(deviceCode),
    userCode: code,
    deviceName: body.device_name || body.client_name || 'OpsTrellis desktop',
    expiresAt: new Date(Date.now() + DEVICE_TTL_MS),
  });
  return c.json({
    device_code: deviceCode,
    user_code: code,
    verification_url: `${config.publicUrl}/device?code=${code}`,
    interval: POLL_INTERVAL_S,
    expires_in: DEVICE_TTL_MS / 1000,
  });
});

authRoutes.post('/device/poll', rateLimit('device-poll', 60), async (c) => {
  const { device_code } = await readJson(c, z.object({ device_code: z.string().min(1).max(200) }));
  const id = sha256(device_code);
  const [row] = await db.select().from(deviceCodes).where(eq(deviceCodes.id, id));
  if (!row || row.expiresAt < new Date()) {
    if (row) await db.delete(deviceCodes).where(eq(deviceCodes.id, id));
    return c.json({ error: 'expired_token', message: 'The code expired or is unknown; start again' }, 400);
  }
  if (!row.token) return c.json({ error: 'authorization_pending' }, 428);
  // Hand out the token exactly once.
  const [claimed] = await db.delete(deviceCodes).where(eq(deviceCodes.id, id)).returning({ token: deviceCodes.token });
  if (!claimed?.token) return c.json({ error: 'expired_token' }, 400);
  return c.json({ token: claimed.token });
});

async function pendingDevice(code: string) {
  const [row] = await db.select().from(deviceCodes).where(eq(deviceCodes.userCode, normalizeUserCode(code)));
  if (!row || row.expiresAt < new Date() || row.userId) throw new ApiError(404, 'not_found', 'This code is invalid, expired, or already used');
  return row;
}

authRoutes.get('/device/:code', requireAuth({ sessionOnly: true }), async (c) => {
  const row = await pendingDevice(c.req.param('code'));
  return c.json({ user_code: row.userCode, device_name: row.deviceName, expires_at: iso(row.expiresAt) });
});

authRoutes.post('/device/approve', requireAuth({ sessionOnly: true }), async (c) => {
  const { user_code } = await readJson(c, z.object({ user_code: z.string().max(20) }));
  const row = await pendingDevice(user_code);
  const user = c.get('user');
  await db.transaction(async (tx) => {
    // Claim the code first; a concurrent approval of the same code then matches no row.
    const token = newApiToken();
    const [claimed] = await tx
      .update(deviceCodes)
      .set({ userId: user.id, token })
      .where(and(eq(deviceCodes.id, row.id), isNull(deviceCodes.userId)))
      .returning({ id: deviceCodes.id });
    if (!claimed) throw new ApiError(404, 'not_found', 'This code is invalid, expired, or already used');
    await createApiToken(user.id, row.deviceName, token, tx);
  });
  return c.json({ ok: true, device_name: row.deviceName });
});

authRoutes.post('/device/deny', requireAuth({ sessionOnly: true }), async (c) => {
  const { user_code } = await readJson(c, z.object({ user_code: z.string().max(20) }));
  const row = await pendingDevice(user_code);
  await db.delete(deviceCodes).where(eq(deviceCodes.id, row.id));
  return c.json({ ok: true });
});

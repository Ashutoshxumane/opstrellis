import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(), // stored lowercased
  name: text('name').notNull().default(''),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['user', 'admin'] }).notNull().default('user'),
  disabled: boolean('disabled').notNull().default(false),
  plan: text('plan', { enum: ['free', 'pro'] }).notNull().default('free'),
  /** Stripe subscription status mirror: active | past_due | canceled | ... */
  planStatus: text('plan_status').notNull().default('active'),
  stripeCustomerId: text('stripe_customer_id').unique(),
  stripeSubscriptionId: text('stripe_subscription_id'),
  /** Last subscription that was deleted; its late or retried events must not revive Pro. */
  stripeEndedSubscriptionId: text('stripe_ended_subscription_id'),
  /** `created` time of the last applied Stripe event; older (out-of-order) events are ignored. */
  stripeEventAt: timestamp('stripe_event_at', { withTimezone: true }),
  /** Current Stripe billing period; when null the calendar month (UTC) is used. */
  periodStart: timestamp('period_start', { withTimezone: true }),
  periodEnd: timestamp('period_end', { withTimezone: true }),
  preferredStt: text('preferred_stt'),
  preferredLlm: text('preferred_llm'),
  createdAt: createdAt(),
});

export const sessions = pgTable('sessions', {
  /** sha256 of the cookie value. */
  id: text('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const apiTokens = pgTable('api_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** First characters of the token, safe to display. */
  prefix: text('prefix').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const deviceCodes = pgTable('device_codes', {
  /** sha256 of the device_code handed to the desktop app. */
  id: text('id').primaryKey(),
  userCode: text('user_code').notNull().unique(),
  deviceName: text('device_name').notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  /** Plain API token, held only between approval and the first successful poll. */
  token: text('token'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** gateway = metered by this server; client = reported by the desktop app. */
    source: text('source', { enum: ['gateway', 'client'] }).notNull(),
    mode: text('mode', { enum: ['byok', 'local', 'cloud'] }).notNull(),
    kind: text('kind', { enum: ['stt', 'llm'] }).notNull().default('stt'),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    audioSeconds: doublePrecision('audio_seconds').notNull().default(0),
    words: integer('words').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    appCategory: text('app_category'),
    providerCostUsd: doublePrecision('provider_cost_usd').notNull().default(0),
    billedUsd: doublePrecision('billed_usd').notNull().default(0),
    /** Whole overage minutes charged by this event (Pro plan). */
    overageMinutes: integer('overage_minutes').notNull().default(0),
    meterReportedAt: timestamp('meter_reported_at', { withTimezone: true }),
    status: text('status', { enum: ['ok', 'error'] }).notNull().default('ok'),
    latencyMs: integer('latency_ms'),
    createdAt: createdAt(),
  },
  (t) => [index('usage_user_created_idx').on(t.userId, t.createdAt), index('usage_created_idx').on(t.createdAt)],
);

export const models = pgTable('models', {
  /** Catalog id, e.g. "deepgram/nova-3". */
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['stt', 'llm'] }).notNull(),
  provider: text('provider').notNull(),
  upstreamModel: text('upstream_model').notNull(),
  displayName: text('display_name').notNull(),
  streaming: boolean('streaming').notNull().default(false),
  /** Reference price we charge per audio minute (informational; plans bill minutes). */
  pricePerMinUsd: doublePrecision('price_per_min_usd').notNull().default(0),
  /** What the upstream provider charges us per audio minute. */
  costPerMinUsd: doublePrecision('cost_per_min_usd').notNull().default(0),
  inputPer1mUsd: doublePrecision('input_per_1m_usd').notNull().default(0),
  outputPer1mUsd: doublePrecision('output_per_1m_usd').notNull().default(0),
  enabled: boolean('enabled').notNull().default(true),
  /** Lower comes first in the fallback chain. */
  fallbackOrder: integer('fallback_order').notNull().default(100),
});

export const providerKeys = pgTable('provider_keys', {
  provider: text('provider').primaryKey(),
  /** base64(iv | tag | ciphertext), AES-256-GCM with MASTER_KEY. */
  ciphertext: text('ciphertext').notNull(),
  last4: text('last4').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type Model = typeof models.$inferSelect;

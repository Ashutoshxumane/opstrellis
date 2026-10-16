// All configuration comes from the environment. Read once at startup.
const env = process.env;

export const config = {
  port: Number(env.PORT ?? 8787),
  databaseUrl: env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/opstrellis',
  publicUrl: (env.PUBLIC_URL ?? 'http://localhost:8787').replace(/\/$/, ''),
  /** Number of reverse proxies in front of us whose X-Forwarded-For entries we trust (0 = none). */
  trustProxy: env.TRUST_PROXY === 'true' ? 1 : Math.max(0, Math.floor(Number(env.TRUST_PROXY) || 0)),
  /** Secret used to encrypt upstream provider keys at rest (any string; hashed to 32 bytes). */
  masterKey: env.MASTER_KEY ?? '',
  localModelDir: env.LOCAL_MODEL_DIR ?? 'models',
  webDir: env.WEB_DIR ?? 'dist/web',
  stripe: {
    secretKey: env.STRIPE_SECRET_KEY ?? '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? '',
    pricePro: env.STRIPE_PRICE_PRO ?? '',
    priceOverage: env.STRIPE_PRICE_OVERAGE ?? '',
    meterEvent: env.STRIPE_METER_EVENT ?? 'opstrellis_managed_minutes',
  },
  maxAudioBytes: 25 * 1024 * 1024,
  sessionDays: 30,
};

export const stripeEnabled = () => Boolean(config.stripe.secretKey);

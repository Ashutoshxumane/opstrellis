// Upstream provider credentials: encrypted in the DB (admin-managed), falling back to env vars.
import { eq } from 'drizzle-orm';
import { db } from './db/index.js';
import { providerKeys } from './db/schema.js';
import { decryptSecret, encryptSecret } from './lib/crypto.js';

export const PROVIDERS = {
  openai: { label: 'OpenAI', env: 'OPENAI_API_KEY' },
  groq: { label: 'Groq', env: 'GROQ_API_KEY' },
  openrouter: { label: 'OpenRouter', env: 'OPENROUTER_API_KEY' },
  anthropic: { label: 'Anthropic', env: 'ANTHROPIC_API_KEY' },
  deepgram: { label: 'Deepgram', env: 'DEEPGRAM_API_KEY' },
  assemblyai: { label: 'AssemblyAI', env: 'ASSEMBLYAI_API_KEY' },
  elevenlabs: { label: 'ElevenLabs', env: 'ELEVENLABS_API_KEY' },
  google: { label: 'Google Cloud Speech', env: 'GOOGLE_API_KEY' },
  azure: { label: 'Azure Speech', env: 'AZURE_SPEECH_KEY' },
} as const;
export type ProviderId = keyof typeof PROVIDERS;

export const isProvider = (p: string): p is ProviderId => p in PROVIDERS;

export async function getProviderKey(provider: string): Promise<string | null> {
  const [row] = await db.select().from(providerKeys).where(eq(providerKeys.provider, provider));
  if (row) return decryptSecret(row.ciphertext);
  return isProvider(provider) ? process.env[PROVIDERS[provider].env] || null : null;
}

export async function setProviderKey(provider: ProviderId, key: string) {
  const values = { provider, ciphertext: encryptSecret(key), last4: key.slice(-4), updatedAt: new Date() };
  await db.insert(providerKeys).values(values).onConflictDoUpdate({ target: providerKeys.provider, set: values });
}

export async function deleteProviderKey(provider: string) {
  await db.delete(providerKeys).where(eq(providerKeys.provider, provider));
}

/** Status for the admin page. Never includes the key itself. */
export async function listProviderKeys() {
  const rows = await db.select().from(providerKeys);
  return Object.entries(PROVIDERS).map(([id, p]) => {
    const row = rows.find((r) => r.provider === id);
    const source = row ? 'database' : process.env[p.env] ? 'env' : null;
    return { provider: id, label: p.label, env: p.env, source, last4: row?.last4 ?? null, updated_at: row?.updatedAt ?? null };
  });
}

/** Overridable base URLs (useful for self-hosted OpenAI-compatible servers and tests). */
export function baseUrl(provider: string, fallback: string): string {
  return (process.env[`${provider.toUpperCase()}_BASE_URL`] || fallback).replace(/\/$/, '');
}

import { and, asc, eq } from 'drizzle-orm';
import { db } from './db/index.js';
import { models, type Model } from './db/schema.js';

export async function listModels(opts: { kind?: 'stt' | 'llm'; enabledOnly?: boolean } = {}): Promise<Model[]> {
  const where = and(opts.kind ? eq(models.kind, opts.kind) : undefined, opts.enabledOnly ? eq(models.enabled, true) : undefined);
  return db.select().from(models).where(where).orderBy(asc(models.kind), asc(models.fallbackOrder), asc(models.id));
}

/**
 * The ordered list of models to try: the requested model (or, for "auto", the user's preference)
 * first, then every other enabled model of that kind in fallback order. Empty when the requested
 * model is unknown or disabled. Bare upstream names (e.g. "whisper-1") are accepted for
 * compatibility with generic OpenAI clients.
 */
export async function modelChain(kind: 'stt' | 'llm', requested: string, preferred: string | null): Promise<Model[]> {
  const all = await listModels({ kind, enabledOnly: true });
  let first: Model | undefined;
  if (requested === 'auto') first = all.find((m) => m.id === preferred);
  else {
    first = all.find((m) => m.id === requested) ?? all.find((m) => m.upstreamModel === requested);
    if (!first) return [];
  }
  return first ? [first, ...all.filter((m) => m !== first)] : all;
}

/** Public catalog entry (shared by /api/catalog and the dashboard). */
export function catalogEntry(m: Model) {
  return {
    id: m.id,
    kind: m.kind,
    provider: m.provider,
    display_name: m.displayName,
    streaming: m.streaming,
    enabled: m.enabled,
    fallback_order: m.fallbackOrder,
    ...(m.kind === 'stt'
      ? { price_per_min_usd: m.pricePerMinUsd }
      : { input_per_1m_usd: m.inputPer1mUsd, output_per_1m_usd: m.outputPer1mUsd }),
  };
}

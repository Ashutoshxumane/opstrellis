// Live calls to real upstream providers. Each test runs only when its key is in the environment,
// e.g. `DEEPGRAM_API_KEY=... npm test -- live` (behind a proxy, also set NODE_USE_ENV_PROXY=1).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODELS } from '../src/db/seed.js';
import { LLM_ADAPTERS } from '../src/llm.js';
import { PROVIDERS, type ProviderId } from '../src/providers.js';
import { STT_ADAPTERS } from '../src/stt.js';

const wav = readFileSync('models/sherpa-onnx-moonshine-tiny-en-int8/test_wavs/0.wav');
const keyOf = (p: ProviderId) => process.env[PROVIDERS[p].env];

describe('live STT providers', () => {
  for (const m of DEFAULT_MODELS.filter((m) => m.kind === 'stt' && m.provider !== 'local')) {
    const key = keyOf(m.provider as ProviderId);
    it.skipIf(!key)(`${m.id} transcribes 0.wav`, async () => {
      const r = await STT_ADAPTERS[m.provider]!({ audio: wav, filename: '0.wav', mimeType: 'audio/wav', upstreamModel: m.upstreamModel, language: 'en', prompt: 'nightfall, lamps', key: key! });
      expect(r.text.toLowerCase()).toContain('yellow');
    }, 90_000);
  }
});

describe('live LLM providers', () => {
  for (const m of DEFAULT_MODELS.filter((m) => m.kind === 'llm')) {
    const key = keyOf(m.provider as ProviderId);
    it.skipIf(!key)(`${m.id} answers`, async () => {
      const r = await LLM_ADAPTERS[m.provider]!({ upstreamModel: m.upstreamModel, key: key!, body: { max_tokens: 10, messages: [{ role: 'user', content: 'Reply with the single word: pong' }] } });
      expect(r.response.choices[0].message.content.toLowerCase()).toContain('pong');
      expect(r.inputTokens).toBeGreaterThan(0);
    }, 60_000);
  }
});

describe('live Stripe', () => {
  it.skipIf(!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_PRO)('creates a Checkout session', async () => {
    const { createCheckoutUrl } = await import('../src/stripe.js');
    const url = await createCheckoutUrl({ id: '00000000-0000-0000-0000-000000000000', email: 'live-test@example.com', name: 'Live', stripeCustomerId: null } as never);
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
  });
});

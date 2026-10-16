import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { req, resetDb, userWithToken } from './helpers.js';

beforeAll(resetDb);

const daysAgo = (n: number, hour = 12) => {
  const d = new Date();
  d.setUTCHours(hour, 0, 0, 0);
  return new Date(d.getTime() - n * 86_400_000).toISOString();
};
const event = (o: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  provider: 'deepgram',
  model: 'nova-3',
  mode: 'byok',
  audio_seconds: 30,
  words: 60,
  app_category: 'email',
  provider_cost_usd: 0.004,
  created_at: daysAgo(0),
  ...o,
});

describe('POST /api/usage', () => {
  it('is idempotent on event id', async () => {
    const { token } = await userWithToken();
    const events = [event(), event(), event()];
    expect(await (await req('/api/usage', { token, json: { events } })).json()).toEqual({ accepted: 3, duplicates: 0 });
    const again = await req('/api/usage', { token, json: { events: [...events, event()] } });
    expect(await again.json()).toEqual({ accepted: 1, duplicates: 3 });
  });

  it('rejects text, bad modes, and oversized batches', async () => {
    const { token } = await userWithToken();
    const withText = await req('/api/usage', { token, json: { events: [{ ...event(), text: 'secret dictation' }] } });
    expect(withText.status).toBe(400);
    expect((await req('/api/usage', { token, json: { events: [event({ mode: 'magic' })] } })).status).toBe(400);
    expect((await req('/api/usage', { token, json: { events: [event({ id: 'not-a-uuid' })] } })).status).toBe(400);
    const big = Array.from({ length: 501 }, () => event());
    expect((await req('/api/usage', { token, json: { events: big } })).status).toBe(400);
    expect((await req('/api/usage', { json: { events: [event()] } })).status).toBe(401);
  });
});

describe('stats', () => {
  it('computes words, WPM, streaks and breakdowns', async () => {
    const { token } = await userWithToken();
    const events = [
      // a 3-day run ending today
      event({ created_at: daysAgo(0), audio_seconds: 60, words: 150, app_category: 'email' }),
      event({ created_at: daysAgo(1), audio_seconds: 60, words: 130, app_category: 'work' }),
      event({ created_at: daysAgo(2), audio_seconds: 120, words: 260, app_category: 'work', mode: 'local', provider: 'local', model: 'moonshine', provider_cost_usd: 0 }),
      // an older 4-day run
      ...[10, 11, 12, 13].map((n) => event({ created_at: daysAgo(n), audio_seconds: 30, words: 70, app_category: null })),
      // an LLM cleanup call: counts no audio
      { ...event({ created_at: daysAgo(0), kind: 'llm', audio_seconds: 0, words: 0, provider: 'openai', model: 'gpt-4o-mini', input_tokens: 300, output_tokens: 80, app_category: null }) },
    ];
    expect((await req('/api/usage', { token, json: { events } })).status).toBe(200);

    const stats = await (await req('/api/stats', { token })).json();
    expect(stats.totals.words).toBe(150 + 130 + 260 + 4 * 70);
    expect(stats.totals.audio_minutes).toBe(6); // 60+60+120+4*30 s
    expect(stats.totals.avg_wpm).toBe(Math.round(820 / 6));
    expect(stats.streak).toEqual({ current: 3, longest: 4 });
    expect(stats.daily).toHaveLength(7);
    const byApp = Object.fromEntries(stats.by_app_category.map((a: any) => [a.app_category, a.words]));
    expect(byApp).toEqual({ work: 390, other: 280, email: 150 });
    const local = stats.by_model.find((m: any) => m.mode === 'local');
    expect(local).toMatchObject({ provider: 'local', words: 260, minutes: 2, cost_usd: 0 });
    const llm = stats.by_model.find((m: any) => m.model === 'gpt-4o-mini');
    expect(llm.tokens).toBe(380);
  });

  it('computes days in the requested time zone', async () => {
    const { token } = await userWithToken();
    // 23:30 UTC yesterday is "today" in Asia/Kolkata (+05:30)
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    const lateYesterdayUtc = new Date(d.getTime() - 30 * 60_000).toISOString();
    await req('/api/usage', { token, json: { events: [event({ created_at: lateYesterdayUtc })] } });
    const utc = await (await req('/api/stats', { token })).json();
    const ist = await (await req('/api/stats?tz=Asia/Kolkata', { token })).json();
    expect(utc.daily[0].day).not.toBe(ist.daily[0].day);
    expect(ist.time_zone).toBe('Asia/Kolkata');
    expect((await (await req('/api/stats?tz=Not/AZone', { token })).json()).time_zone).toBe('UTC');
  });
});

describe('GET /api/catalog and /api/me', () => {
  it('lists enabled models with pricing and plans', async () => {
    const res = await (await req('/api/catalog')).json();
    const nova = res.models.find((m: any) => m.id === 'deepgram/nova-3');
    expect(nova).toMatchObject({ kind: 'stt', provider: 'deepgram', streaming: true, price_per_min_usd: 0.02 });
    const haiku = res.models.find((m: any) => m.id === 'anthropic/claude-haiku-4-5');
    expect(haiku).toMatchObject({ kind: 'llm', input_per_1m_usd: 1, output_per_1m_usd: 5 });
    expect(res.plans.map((p: any) => p.id)).toEqual(['free', 'pro']);
  });

  it('sets the preferred models', async () => {
    const { token } = await userWithToken();
    const me = await (await req('/api/me', { token, method: 'PATCH', json: { preferred_model: 'local/moonshine-tiny-en', preferred_llm: 'openai/gpt-4o-mini' } })).json();
    expect(me.preferred_model).toBe('local/moonshine-tiny-en');
    expect(me.preferred_llm).toBe('openai/gpt-4o-mini');
    expect((await req('/api/me', { token, method: 'PATCH', json: { preferred_model: 'openai/gpt-4o-mini' } })).status).toBe(400);
    expect(me.period.start < me.period.end).toBe(true);
  });
});

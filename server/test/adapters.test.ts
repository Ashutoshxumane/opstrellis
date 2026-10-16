// Upstream adapters against a local fake provider: verifies endpoints, auth and request/response mapping.
import { createServer, type IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { usageEvents } from '../src/db/schema.js';
import { parseWav } from '../src/lib/audio.js';
import { deleteProviderKey, setProviderKey } from '../src/providers.js';
import { STT_ADAPTERS, keyterms } from '../src/stt.js';
import { db, fmtChunk, req, resetDb, riffChunk, riffWave, userWithToken } from './helpers.js';

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: Buffer;
}
const seen: Seen[] = [];
const replies: Record<string, unknown> = {
  '/v1/audio/transcriptions': { text: 'hello from openai' },
  '/v1/listen': { results: { channels: [{ detected_language: 'en', alternatives: [{ transcript: 'hello from deepgram' }] }] } },
  '/v2/upload': { upload_url: 'https://cdn.assemblyai.example/abc' },
  '/v2/transcript': { id: 'tr_1', status: 'queued' },
  '/v2/transcript/tr_1': { id: 'tr_1', status: 'completed', text: 'hello from assemblyai', language_code: 'en' },
  '/v1/speech-to-text': { text: 'hello from elevenlabs', language_code: 'eng' },
  '/v1/speech:recognize': { results: [{ alternatives: [{ transcript: 'hello from' }], languageCode: 'en-us' }, { alternatives: [{ transcript: ' google' }] }] },
  '/speech/recognition/conversation/cognitiveservices/v1': { RecognitionStatus: 'Success', DisplayText: 'Hello from Azure.' },
  '/v1/chat/completions': { id: 'chatcmpl-1', object: 'chat.completion', model: 'gpt-4o-mini', choices: [{ index: 0, message: { role: 'assistant', content: 'Hi!' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } },
  '/v1/messages': { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Hello from Claude' }], stop_reason: 'end_turn', usage: { input_tokens: 2000, output_tokens: 100 } },
};

const server = createServer((rq, rs) => {
  const chunks: Buffer[] = [];
  rq.on('data', (d) => chunks.push(d));
  rq.on('end', () => {
    const url = new URL(rq.url!, 'http://x');
    seen.push({ method: rq.method!, path: url.pathname, query: url.searchParams, headers: rq.headers, body: Buffer.concat(chunks) });
    const reply = replies[url.pathname];
    rs.writeHead(reply ? 200 : 404, { 'content-type': 'application/json' });
    rs.end(JSON.stringify(reply ?? { error: 'not found' }));
  });
});
let base = '';
const last = () => seen[seen.length - 1]!;
const form = (s: Seen) => new Request('http://x', { method: 'POST', headers: { 'content-type': s.headers['content-type']! }, body: new Uint8Array(s.body) }).formData();

const wav = readFileSync('models/sherpa-onnx-moonshine-tiny-en-int8/test_wavs/0.wav');
const sttReq = { audio: wav, filename: 'a.wav', mimeType: 'audio/wav', language: 'en', prompt: 'OpsTrellis, Kubernetes', key: 'KEY' };

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const p of ['deepgram', 'assemblyai', 'elevenlabs', 'google', 'azure', 'anthropic']) process.env[`${p.toUpperCase()}_BASE_URL`] = base;
  process.env.OPENAI_BASE_URL = `${base}/v1`;
  process.env.GROQ_BASE_URL = `${base}/v1`;
});
afterAll(() => {
  server.close();
  for (const p of ['deepgram', 'assemblyai', 'elevenlabs', 'google', 'azure', 'anthropic', 'openai', 'groq']) delete process.env[`${p.toUpperCase()}_BASE_URL`];
});

describe('STT adapters', () => {
  it('keyterms splits the prompt', () => {
    expect(keyterms(' OpsTrellis, Kubernetes\nPostgres; ')).toEqual(['OpsTrellis', 'Kubernetes', 'Postgres']);
  });

  it('OpenAI-compatible: multipart /audio/transcriptions with bearer auth', async () => {
    const r = await STT_ADAPTERS.groq!({ ...sttReq, upstreamModel: 'whisper-large-v3-turbo' });
    expect(r.text).toBe('hello from openai');
    const s = last();
    expect(s.path).toBe('/v1/audio/transcriptions');
    expect(s.headers.authorization).toBe('Bearer KEY');
    const f = await form(s);
    expect(f.get('model')).toBe('whisper-large-v3-turbo');
    expect(f.get('language')).toBe('en');
    expect(f.get('prompt')).toBe('OpsTrellis, Kubernetes');
    expect((f.get('file') as File).size).toBe(wav.length);
  });

  it('Deepgram: /v1/listen with Token auth, keyterms and language', async () => {
    const r = await STT_ADAPTERS.deepgram!({ ...sttReq, upstreamModel: 'nova-3' });
    expect(r).toEqual({ text: 'hello from deepgram', language: 'en' });
    const s = last();
    expect(s.headers.authorization).toBe('Token KEY');
    expect(s.query.get('model')).toBe('nova-3');
    expect(s.query.get('smart_format')).toBe('true');
    expect(s.query.get('punctuate')).toBe('true');
    expect(s.query.getAll('keyterm')).toEqual(['OpsTrellis', 'Kubernetes']);
    expect(s.query.get('language')).toBe('en');
    expect(s.body.equals(wav)).toBe(true);
    await STT_ADAPTERS.deepgram!({ ...sttReq, language: undefined, upstreamModel: 'nova-3' });
    expect(last().query.get('detect_language')).toBe('true');
  });

  it('AssemblyAI: upload, create with speech_model + keyterms_prompt, poll', async () => {
    seen.length = 0;
    const r = await STT_ADAPTERS.assemblyai!({ ...sttReq, upstreamModel: 'universal' });
    expect(r.text).toBe('hello from assemblyai');
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(['POST /v2/upload', 'POST /v2/transcript', 'GET /v2/transcript/tr_1']);
    expect(seen[0]!.headers.authorization).toBe('KEY');
    expect(JSON.parse(seen[1]!.body.toString())).toEqual({ audio_url: 'https://cdn.assemblyai.example/abc', speech_model: 'universal', language_code: 'en', keyterms_prompt: ['OpsTrellis', 'Kubernetes'] });
  });

  it('ElevenLabs: /v1/speech-to-text with xi-api-key and model_id', async () => {
    const r = await STT_ADAPTERS.elevenlabs!({ ...sttReq, upstreamModel: 'scribe_v1' });
    expect(r.text).toBe('hello from elevenlabs');
    expect(last().headers['xi-api-key']).toBe('KEY');
    const f = await form(last());
    expect(f.get('model_id')).toBe('scribe_v1');
    expect(f.get('language_code')).toBe('en');
  });

  it('Google: speech:recognize with key param, LINEAR16 and speechContexts', async () => {
    const r = await STT_ADAPTERS.google!({ ...sttReq, upstreamModel: 'latest_short' });
    expect(r.text).toBe('hello from google');
    const s = last();
    expect(s.query.get('key')).toBe('KEY');
    const body = JSON.parse(s.body.toString());
    expect(body.config).toMatchObject({ encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode: 'en-US', model: 'latest_short', speechContexts: [{ phrases: ['OpsTrellis', 'Kubernetes'] }] });
    expect(Buffer.from(body.audio.content, 'base64').equals(wav)).toBe(true);
  });

  it('Azure: short-audio REST with subscription key', async () => {
    const r = await STT_ADAPTERS.azure!({ ...sttReq, upstreamModel: 'conversation' });
    expect(r.text).toBe('Hello from Azure.');
    const s = last();
    expect(s.headers['ocp-apim-subscription-key']).toBe('KEY');
    expect(s.headers['content-type']).toBe('audio/wav; codecs=audio/pcm; samplerate=16000');
    expect(s.query.get('language')).toBe('en-US');
  });

  it('fails fast without a key', async () => {
    await expect(STT_ADAPTERS.deepgram!({ ...sttReq, key: null, upstreamModel: 'nova-3' })).rejects.toThrow(/no API key/);
  });
});

describe('POST /v1/audio/transcriptions upstream payload', () => {
  it('forwards a WAV rebuilt from the parsed samples, not the uploaded bytes', async () => {
    await resetDb();
    await setProviderKey('openai', 'sk-openai-test');
    try {
      const { token } = await userWithToken();
      const pcm = parseWav(wav)!.data;
      const upload = riffWave(fmtChunk(16000), riffChunk('LIST', Buffer.from('INFOjunk')), riffChunk('data', pcm), riffChunk('junk', Buffer.alloc(64, 1)));
      const fd = new FormData();
      fd.set('file', new Blob([upload], { type: 'audio/x-whatever' }), 'evil.wav');
      fd.set('model', 'openai/whisper-1');
      const res = await req('/v1/audio/transcriptions', { token, method: 'POST', body: fd });
      expect(res.status).toBe(200);
      const sent = (await form(last())).get('file') as File;
      const bytes = Buffer.from(await sent.arrayBuffer());
      expect(sent.type).toBe('audio/wav');
      expect(bytes.length).toBe(44 + pcm.length);
      expect(bytes.subarray(44).equals(pcm)).toBe(true);
      expect(parseWav(bytes)).toMatchObject({ format: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16 });
    } finally {
      await deleteProviderKey('openai');
    }
  });
});

describe('POST /v1/chat/completions', () => {
  beforeAll(async () => {
    await resetDb();
    await setProviderKey('openai', 'sk-openai-test');
    await setProviderKey('anthropic', 'sk-ant-test');
  });

  it('proxies OpenAI-compatible upstreams and meters tokens', async () => {
    const { token, user } = await userWithToken();
    const res = await req('/v1/chat/completions', { token, json: { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }], temperature: 0.2 } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toBe('Hi!');
    expect(body.model).toBe('openai/gpt-4o-mini');
    const sent = JSON.parse(last().body.toString());
    expect(sent).toMatchObject({ model: 'gpt-4o-mini', temperature: 0.2, stream: false });
    expect(last().headers.authorization).toBe('Bearer sk-openai-test');
    const [e] = await db.select().from(usageEvents).where(eq(usageEvents.userId, user.id));
    // 1000 * 0.15/1M + 500 * 0.60/1M
    expect(e).toMatchObject({ kind: 'llm', inputTokens: 1000, outputTokens: 500, providerCostUsd: 0.00045, status: 'ok' });
  });

  it('translates to the Anthropic Messages API and back', async () => {
    const { token } = await userWithToken();
    const res = await req('/v1/chat/completions', {
      token,
      json: { model: 'anthropic/claude-haiku-4-5', max_tokens: 300, messages: [{ role: 'system', content: 'Be terse.' }, { role: 'user', content: [{ type: 'text', text: 'Hello' }] }] },
    });
    const body = await res.json();
    expect(body).toMatchObject({ object: 'chat.completion', model: 'anthropic/claude-haiku-4-5', choices: [{ message: { role: 'assistant', content: 'Hello from Claude' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2000, completion_tokens: 100, total_tokens: 2100 } });
    const s = last();
    expect(s.path).toBe('/v1/messages');
    expect(s.headers['x-api-key']).toBe('sk-ant-test');
    expect(s.headers['anthropic-version']).toBe('2023-06-01');
    expect(JSON.parse(s.body.toString())).toEqual({ model: 'claude-haiku-4-5', max_tokens: 300, system: 'Be terse.', messages: [{ role: 'user', content: 'Hello' }] });
  });

  it('forwards only allowlisted fields, with n=1 and max_tokens capped', async () => {
    const { token } = await userWithToken();
    const res = await req('/v1/chat/completions', {
      token,
      json: { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }], n: 8, max_tokens: 1_000_000, tools: [{ type: 'function' }], service_tier: 'priority', logprobs: true },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(last().body.toString())).toEqual({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }], n: 1, max_tokens: 4096, stream: false });
  });

  it('clamps max_tokens to the remaining allowance and checks it atomically', async () => {
    const { token, user } = await userWithToken();
    // free plan: 200k tokens; 1600 left. Each fake reply uses 1500.
    await db.insert(usageEvents).values({ id: randomUUID(), userId: user.id, source: 'gateway', mode: 'cloud', kind: 'llm', provider: 'openai', model: 'openai/gpt-4o-mini', inputTokens: 200_000 - 1600 });
    seen.length = 0;
    const ask = () => req('/v1/chat/completions', { token, json: { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }] } });
    const results = await Promise.all([ask(), ask(), ask()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 402]);
    expect(seen.map((s) => JSON.parse(s.body.toString()).max_tokens)).toEqual([1600, 100]);
  });

  it('rejects streaming and unknown models', async () => {
    const { token } = await userWithToken();
    expect((await req('/v1/chat/completions', { token, json: { model: 'openai/gpt-4o-mini', stream: true, messages: [{ role: 'user', content: 'x' }] } })).status).toBe(400);
    expect((await req('/v1/chat/completions', { token, json: { model: 'x/y', messages: [{ role: 'user', content: 'x' }] } })).status).toBe(400);
    expect((await req('/v1/chat/completions', { token, json: { messages: [] } })).status).toBe(400);
  });
});

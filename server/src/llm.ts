// Chat completion adapters. Input and output are always the OpenAI chat-completions shape.
import { randomUUID } from 'node:crypto';
import { baseUrl } from './providers.js';
import { UpstreamError } from './stt.js';

export interface ChatMessage {
  role: string;
  content: unknown;
}
export interface ChatRequest {
  body: Record<string, unknown> & { messages: ChatMessage[] };
  upstreamModel: string;
  key: string | null;
}
export interface ChatResult {
  response: any;
  inputTokens: number;
  outputTokens: number;
}

const TIMEOUT_MS = 60_000;

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new UpstreamError(`${new URL(url).host} ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function needKey(key: string | null, provider: string) {
  if (!key) throw new UpstreamError(`no API key configured for ${provider}`);
  return key;
}

function openaiCompatible(provider: string, defaultBase: string) {
  return async (r: ChatRequest): Promise<ChatResult> => {
    const json = await post(
      `${baseUrl(provider, defaultBase)}/chat/completions`,
      { authorization: `Bearer ${needKey(r.key, provider)}` },
      { ...r.body, model: r.upstreamModel, stream: false },
    );
    return { response: json, inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 };
  };
}

/** OpenAI message content (string or parts) -> plain text. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p: any) => (typeof p === 'string' ? p : (p?.text ?? ''))).join('');
  return '';
}

const STOP_REASONS: Record<string, string> = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls' };

/** Translates to the Anthropic Messages API and back. Text-only, non-streaming. */
export async function anthropic(r: ChatRequest): Promise<ChatResult> {
  const b = r.body as any;
  const system = r.body.messages.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => textOf(m.content));
  const messages = r.body.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: textOf(m.content) }));
  const stop = typeof b.stop === 'string' ? [b.stop] : b.stop;
  const json = await post(
    `${baseUrl('anthropic', 'https://api.anthropic.com')}/v1/messages`,
    { 'x-api-key': needKey(r.key, 'anthropic'), 'anthropic-version': '2023-06-01' },
    {
      model: r.upstreamModel,
      max_tokens: b.max_completion_tokens ?? b.max_tokens ?? 1024,
      messages,
      ...(system.length ? { system: system.join('\n\n') } : {}),
      ...(b.temperature != null ? { temperature: Math.min(1, b.temperature) } : {}),
      ...(b.top_p != null ? { top_p: b.top_p } : {}),
      ...(stop ? { stop_sequences: stop } : {}),
    },
  );
  const text = (json.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
  const inputTokens = json.usage?.input_tokens ?? 0;
  const outputTokens = json.usage?.output_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    response: {
      id: `chatcmpl-${json.id ?? randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: r.upstreamModel,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: STOP_REASONS[json.stop_reason] ?? 'stop',
        },
      ],
      usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
    },
  };
}

export const LLM_ADAPTERS: Record<string, (r: ChatRequest) => Promise<ChatResult>> = {
  openai: openaiCompatible('openai', 'https://api.openai.com/v1'),
  groq: openaiCompatible('groq', 'https://api.groq.com/openai/v1'),
  openrouter: openaiCompatible('openrouter', 'https://openrouter.ai/api/v1'),
  anthropic,
};

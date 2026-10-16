import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';

/** Thrown from handlers; rendered by the app's onError via apiError(). */
export class ApiError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** Errors in the shape each API family expects: OpenAI-style under /v1, flat elsewhere. */
export function apiError(c: Context, status: ContentfulStatusCode, code: string, message?: string) {
  if (c.req.path.startsWith('/v1/')) {
    return c.json({ error: { message: message ?? code, type: code, code } }, status);
  }
  return c.json(message ? { error: code, message } : { error: code }, status);
}

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw new ApiError(400, 'invalid_request', z.prettifyError(r.error));
  return r.data;
}

export async function readJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    const text = await c.req.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(400, 'invalid_json', 'Body must be JSON');
  }
  return parse(schema, raw);
}

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

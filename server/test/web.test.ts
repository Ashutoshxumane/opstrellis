// Smoke test: the built dashboard is served by the same Hono process over real HTTP.
import { serve, type ServerType } from '@hono/node-server';
import { existsSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from './helpers.js';

let server: ServerType;
let base = '';

beforeAll(async () => {
  if (!existsSync('dist/web/index.html')) throw new Error('Dashboard not built: run `npm run build` (npm test does this via pretest)');
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      base = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});
afterAll(() => void server?.close());

describe('dashboard', () => {
  it('serves index.html at / and for client-side routes', async () => {
    for (const path of ['/', '/device?code=ABCD-EFGH', '/admin/users']) {
      const res = await fetch(base + path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
      const html = await res.text();
      expect(html).toContain('<div id="root">');
      expect(html).toContain('<title>OpsTrellis Cloud</title>');
    }
  });

  it('serves built assets with security headers', async () => {
    const js = readdirSync('dist/web/assets').find((f) => f.endsWith('.js'))!;
    const res = await fetch(`${base}/assets/${js}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('keeps API 404s as JSON and exposes a health check', async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true });
  });
});

import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { purgeExpired } from './auth.js';
import { config } from './config.js';
import { reportOverage } from './stripe.js';

const server = serve({ fetch: createApp().fetch, port: config.port }, (info) => {
  console.log(`OpsTrellis Cloud listening on http://localhost:${info.port} (public URL ${config.publicUrl})`);
});

// Retry any overage minutes that could not be sent to Stripe inline.
setInterval(() => reportOverage().catch((e) => console.error(e)), 5 * 60_000).unref();

setInterval(() => purgeExpired().catch((e) => console.error(e)), 60 * 60_000).unref();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}

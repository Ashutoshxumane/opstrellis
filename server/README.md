# OpsTrellis Cloud (server)

The managed backend for OpsTrellis: an OpenAI-compatible speech/LLM gateway with metering, quotas and
provider fallback, the desktop sign-in and usage APIs, Stripe billing, and a React dashboard. One
Node process (Hono) serves the API and the built dashboard. Data lives in Postgres.

```
src/
  index.ts          process entry (HTTP server, periodic jobs)
  app.ts            routes, static dashboard, error handling
  config.ts         environment
  auth.ts           sessions, API tokens, requireAuth, CSRF origin check, rate limiting
  billing.ts        plans, billing periods, included/overage split (pure, unit-tested)
  usage.ts          metering, /api/me summary, user and admin stats
  catalog.ts        model catalog and fallback chain
  stt.ts            STT adapters: openai, groq, deepgram, assemblyai, elevenlabs, google, azure, local (sherpa-onnx)
  llm.ts            chat adapters: openai, groq, openrouter, anthropic (Messages API translation)
  providers.ts      upstream keys (AES-256-GCM in DB, env fallback)
  stripe.ts         Checkout, Portal, webhook handling, Billing Meter reporting
  routes/           gateway (/v1), auth (+ device flow, tokens), api (me, usage, stats, billing), admin
  db/               Drizzle schema, migrate, seed
drizzle/            generated SQL migrations (committed)
web/                dashboard (React + Vite), built into dist/web
test/               vitest integration tests (real Postgres, real local model)
scripts/fetch-model.sh   downloads the self-hosted Moonshine model into models/
```

## Run locally

Requires Node 22+ and Postgres 14+.

```sh
cp .env.example .env              # then edit; at least DATABASE_URL and MASTER_KEY
npm install
npm run fetch-model               # self-hosted STT model (~100 MB) into ./models
npm run db:migrate                # applies migrations and inserts the default catalog
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=... npm run db:seed   # optional; else the first signup (empty database) is admin
npm run build && npm start        # http://localhost:8787
```

`npm run dev` runs the API with reload on :8787 and the dashboard with HMR on :5173 (proxying
`/api` and `/v1`). `npm start`, `dev`, `db:migrate` and `db:seed` read `.env` when present.

### Docker

```sh
docker compose up --build         # Postgres + server on :8787, migrations run on start
```

The image downloads the local model at build time (`--build-arg FETCH_MODEL=0` to skip and mount
`./models` at `/app/models`).

## Configuration

See `.env.example`. The important ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `PUBLIC_URL` | External origin; used for device links, Stripe redirects, secure cookies and CSRF checks |
| `MASTER_KEY` | Encrypts provider keys saved in the admin UI. Keep it stable |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Admin created or promoted by `npm run db:seed`. Otherwise only the first signup becomes admin |
| `TRUST_PROXY` | Number of reverse proxies in front of the server (`1` for one). The client IP is that many entries from the right of `X-Forwarded-For` |
| `LOCAL_NUM_THREADS` | Threads for the self-hosted model (it decodes one request at a time) |
| `LOCAL_MODEL_DIR` | Folder with self-hosted models; a `local/*` catalog entry's `upstream_model` is a subfolder |
| `OPENAI_API_KEY`, `GROQ_API_KEY`, `DEEPGRAM_API_KEY`, `ASSEMBLYAI_API_KEY`, `ELEVENLABS_API_KEY`, `GOOGLE_API_KEY`, `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` | Platform keys, used when none is saved in the admin UI |
| `<PROVIDER>_BASE_URL` | Optional upstream base URL override (e.g. a self-hosted OpenAI-compatible server) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_OVERAGE`, `STRIPE_METER_EVENT` | Billing. Without a secret key the dashboard shows manual billing and admins set plans |

### Stripe setup

1. Create a Billing Meter with event name `opstrellis_managed_minutes` (sum aggregation).
2. Create a Pro product with a $12/month recurring price (`STRIPE_PRICE_PRO`) and a metered
   $0.02/unit price tied to that meter (`STRIPE_PRICE_OVERAGE`).
3. Add a webhook to `https://<host>/api/stripe/webhook` for `checkout.session.completed`,
   `customer.subscription.created|updated|deleted` and `invoice.payment_failed`.
4. Enable the Customer Portal.

Overage minutes are sent as meter events with the usage event id as the idempotency identifier,
inline after each request and retried every 5 minutes.

## Billing rules

- Free: 15 managed minutes per month; a request that would go past them gets `402 quota_exceeded`.
- Pro: 600 minutes, then $0.02 per started minute of cumulative overage (the sum over a period is
  always `ceil(overage seconds / 60)`). A past-due subscription gets no overage.
- The period is the Stripe subscription period when known, else the UTC calendar month.
- BYOK and local usage reported by the desktop is free and only feeds stats.
- Every gateway call records provider cost (from the catalog) and the billed amount.

## Tests

```sh
createdb opstrellis_test                 # or set TEST_DATABASE_URL; the schema is rebuilt each run
npm run fetch-model                 # the gateway tests transcribe test_wavs/0.wav for real
npm test                            # builds the dashboard, then runs vitest
```

Live upstream tests (`test/live.test.ts`) run only when the matching key is set, for example
`DEEPGRAM_API_KEY=... NODE_USE_ENV_PROXY=1 npx vitest run test/live.test.ts`.

## HTTP API

All JSON (request bodies under `/api` are limited to 64 KB, 1 MB for `/api/usage`). Desktop and
scripts authenticate with `Authorization: Bearer utt_...`; the dashboard uses an httpOnly session
cookie (mutations need a same-origin `Origin`). Errors are `{error: code, message?}` under `/api` and
OpenAI-style `{error: {message, type, code}}` under `/v1`.

Gateway (base URL `https://host/v1`, the API token is the "OpenAI key"):

- `POST /v1/audio/transcriptions` multipart `file` (WAV: PCM16 or 32-bit float, mono or stereo, 8–48 kHz,
  ≤25 MB; 16 kHz mono PCM16 preferred), `model` (catalog id or `auto`), `language?`, `prompt?`
  (comma-separated terms become vocabulary hints), `response_format` `json` → `{text}` | `text` |
  `verbose_json` → `{task, language, duration, text, model}`. Header `x-opstrellis-model` names the model
  that answered. The duration is billed from the parsed samples, and upstreams receive a mono PCM16 WAV
  rebuilt from them.
  `402` over quota, `403` disabled, `400` bad model/audio, `413` too large, `429` more than 3 requests in flight
  (each user's requests run one at a time), `502` all upstreams failed.
- `POST /v1/chat/completions` OpenAI body with `stream: false`; returns an OpenAI chat completion. Only `model`,
  `messages`, `temperature`, `top_p`, `max_tokens` (capped at 4096 and the remaining token allowance), `stop` and
  `response_format` are forwarded, with `n: 1`.
- `GET /v1/models` → `{object: "list", data: [{id, object, owned_by, kind, streaming}]}`.

Desktop API:

- `POST /api/device/start {device_name?}` → `{device_code, user_code, verification_url, interval, expires_in}`
- `POST /api/device/poll {device_code}` → `200 {token}` | `428 {error: "authorization_pending"}` | `400 {error: "expired_token"}`
- `GET /api/me` → `{user, plan, plan_status, period, usage: {managed_minutes, included_minutes, overage_minutes, remaining_minutes, words, cost_usd}, limits, preferred_model, preferred_llm}`;
  `PATCH /api/me {name?, preferred_model?, preferred_llm?}`
- `GET /api/catalog` → `{models: [{id, kind, provider, display_name, streaming, enabled, fallback_order, price_per_min_usd | input_per_1m_usd + output_per_1m_usd}], plans}`
- `POST /api/usage {events: [{id, provider, model, mode, kind?, audio_seconds, words, input_tokens?, output_tokens?, app_category?, provider_cost_usd?, created_at}]}` (≤500, idempotent by `id`, unknown fields such as text are rejected) → `{accepted, duplicates}`
- `GET /api/stats?tz=Area/City` → totals, WPM, streaks, daily words, app categories, per model

Dashboard-only: `/api/auth/{signup,login,logout}`, `/api/tokens`, `/api/device/{:code,approve,deny}`,
`/api/billing{,/checkout,/portal}`, `/api/admin/*` (users, models, providers, stats).

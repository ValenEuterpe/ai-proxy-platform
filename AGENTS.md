# AGENTS.md — Guide for AI coding agents

This file is for **AI agents** (Cursor, Claude Code, OpenCode, Copilot, etc.) working on this repo. Read it before editing. Humans should start with [README.md](./README.md) and [setup.md](./setup.md).

There is also `apps/worker/AGENTS.md` for Cloudflare Workers runtime notes — keep both in mind when touching the Worker.

---

## What this project is

A **multi-tenant OpenAI-compatible AI API proxy**:

1. Owner connects upstream OpenAI-compatible providers (**channels**).
2. Owner curates which models are **exposed** (public IDs are `channel-name/model-id`).
3. End users log in with **Discord** (Supabase Auth), get an `sk-...` API key.
4. Users call `/v1/chat/completions` (and related routes) like OpenAI; the Worker auth, rate-limits, CSAM-scans, forwards to the right channel, streams the response, and logs usage.

**Scale target:** ~100–300 users. **No Redis.** Rate limits are counted from Postgres (`logs` + role limits). Do not introduce Redis/KV/queues unless the human explicitly asks and understands free-tier tradeoffs.

**Battle-tested** at roughly ~100 concurrent community users with no production errors on the proxy path when configured correctly.

---

## Stack (do not reinvent)

| Layer | Tech | Location |
|---|---|---|
| API / proxy | Cloudflare Worker + Hono | `apps/worker` |
| Frontend | React + Vite + Tailwind SPA | `apps/web` |
| Same-origin proxy | Cloudflare Pages Functions | `apps/web/functions/*` |
| DB + Discord OAuth | Supabase (Postgres + Auth) | `supabase/migrations` |
| Owner auth | Env username/password + signed session | Worker secrets |
| User auth | Supabase JWT (Discord) | `/api/user/*` |

No Docker. No Node servers. Worker must stay **Workers-compatible** (Web APIs; `nodejs_compat` is enabled but prefer pure Web APIs).

---

## Repository map

```
apps/worker/src/
  index.ts              # Hono app, CORS, /health, cron (keep-alive + log prune)
  types.ts              # Env + shared types
  routes/
    proxy.ts            # /v1/* — hot path (auth, limits, CSAM, stream, log)
    admin.ts            # /api/admin/* — owner-only CRUD
    auth.ts             # owner login + user ensure/me/usage
    public.ts           # /api/public/* — unauthenticated reads (landing)
    discord.ts          # Discord interactions (slash commands)
  lib/
    db.ts               # Supabase service-role client
    auth.ts             # owner cookie + API key helpers
    rateLimit.ts        # RPM/RPD + token limits from roles
    channelClient.ts    # upstream fetch + streaming
    modelId.ts          # channel/model public ID parse/format
    exposedModels.ts    # resolve exposed model → channel
    settings.ts         # settings row cache
    tokenCount.ts       # optional gpt-tokenizer
    csamShield.ts       # prompt scanning
    roles.ts            # role resolution
    discord*.ts         # guild gate, commands, crypto, API

apps/web/src/
  admin/                # Owner dashboard (Channels, Models, Users, Logs, Settings)
  dashboard/            # User dashboard (key, models, personal logs)
  landing/              # Public home
  lib/api.ts            # fetch wrappers to Worker / same-origin
  lib/supabaseClient.ts # browser Supabase (anon key only)

apps/web/functions/     # Pages Functions reverse-proxy /api, /v1, /health → Worker
supabase/migrations/    # 001_init … 009_* — apply in order
```

---

## Hard rules (do not violate)

1. **Never commit secrets.** Worker secrets via `wrangler secret put`. Frontend only gets `VITE_*` public values. Never put `SUPABASE_SERVICE_ROLE_KEY` in the web app.
2. **Admin security boundary:** owner UI talks only to `/api/admin/*` on the Worker with the owner session. Do not give the browser service-role access. Do not “simplify” by querying `channels` / `settings` from the SPA with the anon key.
3. **RLS stays on.** Users may only read their own `app_users` / `logs` rows; exposed models/stats are public-read. Channels and settings have **no** public policies.
4. **Streaming is sacred.** On the proxy hot path, pipe `response.body` through. Do not buffer full upstream responses with `await response.text()` for streaming completions.
5. **Keep the hot path lean.** Minimize work before upstream `fetch()`. Rate-limit and auth failures must return **before** calling the provider.
6. **No Redis / no new infra by default.** Rate limits use indexed `logs` counts (+ token sum RPC). If scale breaks this, discuss a rollup table or KV — don’t silently add Redis.
7. **TypeScript strict.** Match existing patterns (Hono routers, Supabase client, React pages).
8. **No Node-only APIs in Worker** (`fs`, raw `Buffer` as Node buffer, etc.). Use `crypto.subtle`, `TextEncoder`, Web `fetch`.
9. **Generic client errors.** Do not leak stack traces or internal messages to API clients (`index.ts` `onError` pattern).
10. **Migrations are additive.** Prefer new numbered SQL files under `supabase/migrations/`. Do not rewrite history of applied migrations.
11. **Channel public IDs:** models are addressed as `channelName/modelId` (first slash splits channel vs upstream model id). Channel names cannot contain `/` and must be unique.
12. **Do not strip CSAM / safety behavior** without an explicit human request. Flagging and optional block modes live in settings + `csamShield.ts`.

---

## Request flow (proxy) — mental model

```
Client  →  POST /v1/chat/completions  Authorization: Bearer sk-...
       →  (optional) Pages Function proxies to Worker
Worker →  resolve API key → app_users (active?)
       →  resolve role limits → rateLimit (requests + tokens)
       →  optional CSAM scan on prompt
       →  parse public model id → exposed channel
       →  fetch channel base_url + path with channel API key
       →  stream body back to client
       →  waitUntil: insert log, bump model_stats, optional token count
```

Owner path: `/admin` SPA → `/api/admin/*` + owner session cookie/header → service role DB.

User path: Discord OAuth (Supabase) → `/api/user/ensure` issues/returns API key → dashboard reads own data via Worker and/or RLS-protected Supabase.

---

## Environment variables agents must not invent values for

### Worker secrets
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OWNER_LOGIN`
- `OWNER_PASSWORD` (plaintext compare today)
- `SESSION_SECRET`
- Optional Discord bot: `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID`

### Worker vars
- `CORS_ORIGIN` — comma-separated allowed origins for credentialed dashboard calls (e.g. Pages URL). Public `/v1` is more permissive.

### Web (Vite / Pages build)
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_WORKER_API_URL` — Worker URL or same Pages origin when Functions proxy is used

### Pages runtime (Functions)
- `WORKER_URL` — Worker origin for `apps/web/functions/_lib/proxy.ts` (falls back to a hardcoded default; **update for forks**)

---

## Features beyond the original v1 sketch

Agents should treat these as **existing product**, not optional TODOs:

- **Roles** with per-role RPM/RPD and token limits; channel allowlists via `channel_roles`
- **Guild gate** (optional Discord server membership) + invite URL in settings
- **Admin disable** vs guild auto-disable (`admin_disabled`)
- **CSAM shield** (scan / log / optional block; per-user forced prompt logging)
- **Discord slash commands** registration + interactions route
- **Namespaced model IDs** (`channel/model`)
- **Hourly cron:** Supabase keep-alive + prune logs older than `LOG_RETENTION_DAYS` (30)
- **Pages Functions** same-origin reverse proxy for `/api`, `/v1`, `/health`

When docs in `CLAUDE.md` disagree with code, **prefer the code** and migrations `001`–`009`.

---

## How to make changes safely

### Before coding
1. Read the relevant route + lib files; grep for existing helpers.
2. Check migrations for schema (especially `roles`, CSAM columns, guild settings).
3. Prefer extending `admin.ts` / `proxy.ts` patterns over new frameworks.

### After coding
1. Run Worker tests if present: `cd apps/worker && npm test`
2. Typecheck/build web if UI changed: `cd apps/web && npm run build`
3. Do not commit `.dev.vars`, `.env`, or secrets.
4. Do not auto-commit or force-push unless the human asks.

### Schema changes
1. Add `supabase/migrations/0XX_short_name.sql` (next number).
2. Keep changes additive when possible.
3. Document new env vars or admin UI fields in README/setup if user-facing.

### Proxy / streaming changes
1. Preserve pass-through streaming.
2. Keep rate-limit rejection before upstream.
3. Log errors without breaking the client stream contract when possible.
4. Add/adjust tests under `apps/worker/test/` for pure logic (rate limit, modelId, csam).

---

## What not to build (non-goals)

- Payment / billing / Stripe
- Response caching or “shorten the answer” layers
- Multi-owner SaaS tenancy (this is one owner, many Discord users)
- Redis-backed rate limiting “because production apps use Redis”
- Native tokenizer bindings that break Workers
- Exposing channel API keys to users or the SPA

---

## Useful commands

```bash
# Worker
cd apps/worker
npm install
cp .dev.vars.example .dev.vars   # fill secrets locally
npm run dev                      # wrangler dev → :8787
npm test
npx wrangler deploy
npx wrangler secret put NAME

# Web
cd apps/web
npm install
cp .env.example .env
npm run dev                      # vite → :5173
npm run build
```

---

## Security checklist for agents

- [ ] No service role key in frontend or committed files
- [ ] Owner routes still verify session before mutating
- [ ] User cannot read other users’ logs/keys via new endpoints
- [ ] Channel `api_key` never returned unmasked to non-owner (mask in admin list)
- [ ] CSRF/CORS: credentialed admin calls only from configured `CORS_ORIGIN`
- [ ] Prompt/response logging respects global + per-user flags
- [ ] CSAM paths still force logging when designed to

---

## If you are unsure

1. Prefer the smallest change that matches existing style.
2. Do not “upgrade” the architecture for hypothetical millions of users.
3. Ask the human before: removing safety features, changing auth, adding paid infra, or rewriting the proxy path.

Primary human docs: [README.md](./README.md) · [setup.md](./setup.md) · historical design notes in `CLAUDE.md` (may lag code).

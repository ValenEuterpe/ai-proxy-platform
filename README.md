# AI Proxy Platform

**OpenAI-compatible multi-tenant API proxy** for a private community.

You (the owner) plug in one or more upstream OpenAI-compatible providers (“channels”), pick which models to expose, and let Discord users get an `sk-...` key and call your proxy exactly like OpenAI’s API. Requests are authenticated, rate-limited, optionally safety-scanned, forwarded upstream, **streamed** back, and logged.

> **If you use this project, please star the repo.** Stars help others find a working, free-tier-friendly proxy stack.

---

## Who this is for

| Good fit | Bad fit |
|---|---|
| Private Discord community (~100–300 users) | Public paid SaaS / billing product |
| One owner, many end users | Multi-tenant “many owners” product |
| Free-tier Cloudflare + Supabase | You need Redis, queues, multi-region DB |
| OpenAI-compatible upstreams (OpenRouter, new-api, etc.) | Non-OpenAI-shaped providers only |

**Scale & limits (read this):**

- Designed for roughly **~100–300 users**, not millions.
- **No Redis** and **no Redis support** in-tree. Rate limits are enforced by counting rows in Postgres (`logs` + role limits). That is intentional and works at community scale.
- **Battle-tested** on a live community proxy with on the order of **~100 users** and **zero production errors** on the proxy path when env/CORS/channels were configured correctly.
- Free-tier friendly: Cloudflare Workers (CPU-time friendly for streaming LLMs) + Cloudflare Pages + Supabase free Postgres.

If you need enterprise rate limiting, multi-region hot standby, or billing, fork and extend — don’t expect those features here.

---

## How it works (idea)

```
Discord user
   → logs into /dashboard (Supabase Auth + Discord)
   → gets API key sk-...
   → POST /v1/chat/completions  (same shape as OpenAI)
        → Cloudflare Worker
             → validate key, role limits, optional CSAM scan
             → resolve model public id  channel/model
             → stream from upstream channel
             → log usage (async)
```

**Two UIs**

| Path | Who | Purpose |
|---|---|---|
| `/admin` | Owner | Channels, models, users, roles, logs, settings |
| `/dashboard` | Discord user | API key, exposed models, personal usage |
| `/` | Public | Landing |

**Model IDs are namespaced:** `channel-name/upstream-model-id`  
Example: channel `openrouter` exposing `gpt-4o` → public id `openrouter/gpt-4o`.  
First `/` splits channel vs model (so `bil/openai/gpt-4o` → channel `bil`, model `openai/gpt-4o`).

---

## Stack

| Piece | Tech |
|---|---|
| Proxy + admin/user API | **Cloudflare Worker** (Hono) — `apps/worker` |
| Frontend SPA | **React + Vite + Tailwind** — `apps/web` |
| Same-origin `/api` `/v1` | **Cloudflare Pages Functions** — `apps/web/functions` |
| Database + Discord login | **Supabase** (Postgres + Auth) — `supabase/migrations` |
| Owner login | Env username/password + signed session (Worker secrets) |

No Docker. No always-on Node server.

---

## Repository layout

```
apps/
  worker/                 # Cloudflare Worker (proxy + APIs)
    src/routes/           # proxy, admin, auth, public, discord
    src/lib/              # db, rateLimit, channelClient, csam, roles, …
    test/                 # vitest unit tests
  web/                    # React SPA (Pages)
    src/admin/            # owner dashboard
    src/dashboard/        # user dashboard
    src/landing/
    functions/            # reverse-proxy to Worker
supabase/
  migrations/             # 001 … 009 — run in order
AGENTS.md                 # rules for AI coding agents
setup.md                  # full Cloudflare + Supabase deploy guide
CLAUDE.md                 # historical design notes (may lag code)
```

---

## Features (shipped)

- OpenAI-compatible **`/v1/chat/completions`**, completions, models list
- **Streaming** pass-through (no full-buffer of the completion on the hot path)
- **Channels** + model discovery / expose toggles
- **Roles**: per-role request + token limits; optional per-channel role allowlists
- **Guild gate**: require membership in a Discord server (optional bot secrets)
- **CSAM shield**: scan prompts; log and/or block; per-user forced prompt logging
- **Discord slash commands** (optional bot)
- **Hourly cron**: keep Supabase free-tier awake + prune logs older than **30 days**
- Owner dashboard: channels, models, users, logs, settings
- User dashboard: key, models, personal logs

### Explicit non-goals

- Payments / Stripe / billing
- Response caching or “rewrite the answer” middleware
- Built-in Redis / durable queue rate limiting
- Multi-owner SaaS tenancy

---

## Quick start (local)

Prereqs: **Node.js 20+**, a Supabase project with migrations applied, Discord OAuth configured. Full production walkthrough: **[setup.md](./setup.md)**.

```bash
# Worker
cd apps/worker
cp .dev.vars.example .dev.vars   # fill secrets
npm install
npm run dev                      # http://localhost:8787

# Web (second terminal)
cd apps/web
cp .env.example .env             # VITE_* + VITE_WORKER_API_URL=http://localhost:8787
npm install
npm run dev                      # http://localhost:5173
```

Open `/admin` (owner env credentials) or `/dashboard` (Discord).

### Example proxy call

```bash
curl https://YOUR_ORIGIN/v1/models \
  -H "Authorization: Bearer sk-YOUR_KEY"

curl https://YOUR_ORIGIN/v1/chat/completions \
  -H "Authorization: Bearer sk-YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"openrouter/gpt-4o","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

`YOUR_ORIGIN` is either the Worker URL or your Pages URL (if Pages Functions proxy is configured — see setup).

---

## Environment variables (summary)

### Worker secrets (`wrangler secret put`)

| Secret | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only; never put in the browser |
| `OWNER_LOGIN` / `OWNER_PASSWORD` | Admin dashboard login |
| `SESSION_SECRET` | Signs owner session |
| `DISCORD_BOT_TOKEN` / `DISCORD_PUBLIC_KEY` / `DISCORD_APPLICATION_ID` | Optional guild gate + slash commands |

### Worker var

| Var | Purpose |
|---|---|
| `CORS_ORIGIN` | Comma-separated origins allowed for credentialed dashboard calls (your Pages URL) |

### Web (Vite / Pages build)

| Var | Purpose |
|---|---|
| `VITE_SUPABASE_URL` | Same project URL |
| `VITE_SUPABASE_ANON_KEY` | Anon key (RLS-protected) |
| `VITE_WORKER_API_URL` | Worker URL, or Pages origin when same-origin proxy is used |

### Pages Functions runtime

| Var | Purpose |
|---|---|
| `WORKER_URL` | Worker origin for `apps/web/functions` proxy (update when forking — code has a default) |

---

## Security notes

- **Service role key** never leaves the Worker.
- Owner UI always goes through **`/api/admin/*`** with a verified session — not direct Supabase with service role.
- RLS: users only read their own `app_users` / `logs`; channels & settings are not public.
- Channel API keys are **masked** in admin list responses.
- Client-facing errors are generic; details go to Worker logs only.

---

## Docs for contributors & agents

| File | Audience |
|---|---|
| **[setup.md](./setup.md)** | Humans deploying Cloudflare + Supabase |
| **[AGENTS.md](./AGENTS.md)** | AI agents editing this repo |
| `apps/worker/AGENTS.md` | Cloudflare Workers runtime reminders |
| `CLAUDE.md` | Original design sketch (prefer code if conflict) |

---

## License / fork note

Fork freely for your community. Keep secrets out of git. Update `WORKER_URL` / `CORS_ORIGIN` / Discord redirects for **your** domains after forking.

**If this saves you a weekend of plumbing: star the repo.** Thank you.

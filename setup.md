# Setup guide — Cloudflare + Supabase

Deploy this platform from zero to a live URL. First-time budget: **~45–90 minutes**.

You need free accounts for:

1. **Supabase** — Postgres + Discord OAuth  
2. **Cloudflare** — Worker (API/proxy) + Pages (SPA)  
3. **Discord Developer Portal** — OAuth app (and optional bot for guild gate / slash commands)

Do the parts **in order**. Later steps need values from earlier ones.

Also read: [README.md](./README.md) (what this is / limits) · [AGENTS.md](./AGENTS.md) (if an AI helps you change code).

---

## Architecture you are building

```
Browser  ──►  Cloudflare Pages (apps/web SPA)
                 │
                 ├── static UI
                 └── Pages Functions  /api  /v1  /health
                           │
                           ▼
                 Cloudflare Worker (apps/worker)
                           │
                           ▼
                 Supabase (DB + Auth)
                           │
                           ▼
                 Upstream OpenAI-compatible channel(s)
```

Optional: call the Worker URL for `/v1` directly (no Pages hop). Same-origin via Pages is nicer for cookies and one public base URL.

---

## Part 0 — Code & tooling

```bash
git clone <YOUR_FORK_URL>
cd ai-proxy-platform
```

Requirements:

- **Node.js 20+** (`node -v`)
- Cloudflare account (Workers + Pages enabled)
- Ability to run `npx wrangler login` in a real terminal (browser auth)

Install deps:

```bash
cd apps/worker && npm install
cd ../web && npm install
cd ../..
```

---

## Part 1 — Supabase (database + auth)

### 1.1 Create project

1. https://supabase.com → **New project**
2. Name, strong DB password (save it), region near you
3. Wait until the project is ready

### 1.2 Run SQL migrations (in order)

Open **SQL Editor** → **New query**. Run each file **completely**, in this order:

| Order | File |
|---|---|
| 1 | `supabase/migrations/001_init.sql` |
| 2 | `supabase/migrations/002_roles.sql` |
| 3 | `supabase/migrations/003_user_disable_and_guild_gate.sql` |
| 4 | `supabase/migrations/004_token_limits.sql` |
| 5 | `supabase/migrations/005_csam.sql` |
| 6 | `supabase/migrations/006_logs_channel_set_null.sql` |
| 7 | `supabase/migrations/007_discord_commands.sql` |
| 8 | `supabase/migrations/008_discord_rolelist.sql` |
| 9 | `supabase/migrations/009_discord_assignrole_exclude.sql` |

Each should report success. Skipping later migrations breaks roles, CSAM, guild gate, or Discord features.

### 1.3 Copy API keys

**Project Settings → API** — save in a private note:

| Supabase label | Used as |
|---|---|
| **Project URL** | Worker `SUPABASE_URL` **and** web `VITE_SUPABASE_URL` |
| **anon public** key | Web `VITE_SUPABASE_ANON_KEY` only |
| **service_role secret** key | Worker `SUPABASE_SERVICE_ROLE_KEY` only |

> **Never** put the service_role key in the frontend, Pages `VITE_*` vars, or git.

---

## Part 2 — Discord OAuth application

Users log in with Discord through Supabase.

1. https://discord.com/developers/applications → **New Application**
2. **OAuth2** → copy **Client ID** and **Client Secret**
3. **Redirects** → add exactly:

   ```
   https://<YOUR_PROJECT_REF>.supabase.co/auth/v1/callback
   ```

   `<YOUR_PROJECT_REF>` is the subdomain of your Supabase Project URL.

### 2.1 Enable Discord in Supabase

1. Supabase → **Authentication** → **Providers** → **Discord**
2. Enable, paste Client ID + Secret, save

You will set **Site URL / Redirect URLs** to your Pages domain in Part 5 (after Pages exists). For local dev you can temporarily add:

- Site URL: `http://localhost:5173`
- Redirects: `http://localhost:5173`, `http://localhost:5173/dashboard`

---

## Part 3 — Deploy the Worker (backend / proxy)

### 3.1 Login

```bash
cd apps/worker
npx wrangler login
```

### 3.2 Secrets

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put OWNER_LOGIN
npx wrangler secret put OWNER_PASSWORD
npx wrangler secret put SESSION_SECRET
```

| Secret | Value |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key |
| `OWNER_LOGIN` | Admin username you choose |
| `OWNER_PASSWORD` | Strong admin password (plaintext compare in Worker) |
| `SESSION_SECRET` | Long random string, e.g. `openssl rand -base64 32` |

**Optional** (guild membership gate + slash commands):

```bash
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_APPLICATION_ID
```

Bot needs permissions to check guild membership (and manage roles if you use assign-role commands). Interactions endpoint will be:

```
https://<YOUR_WORKER_HOST>/api/discord/interactions
```

### 3.3 CORS (prepare, then finalize after Pages)

Edit `apps/worker/wrangler.jsonc` → `vars.CORS_ORIGIN`:

- During first deploy you can leave a placeholder.
- After Pages exists, set it to your Pages origin, e.g.:

  ```jsonc
  "vars": {
    "CORS_ORIGIN": "https://your-app.pages.dev"
  }
  ```

  Multiple origins (prod + local):

  ```jsonc
  "CORS_ORIGIN": "https://your-app.pages.dev,http://localhost:5173"
  ```

Public `/v1` and `/health` allow browser origins more loosely; **admin/user cookie APIs** require `CORS_ORIGIN` to match the dashboard origin.

### 3.4 Deploy

```bash
npx wrangler deploy
```

Copy the Worker URL, e.g. `https://ai-proxy-worker.<account>.workers.dev`.

Smoke test:

```bash
curl https://ai-proxy-worker.<account>.workers.dev/health
# → {"ok":true}
```

Hourly cron is already in `wrangler.jsonc` (`0 * * * *`): Supabase keep-alive + prune logs older than 30 days.

### 3.5 Local Worker (optional)

```bash
cd apps/worker
cp .dev.vars.example .dev.vars
# fill same secrets; CORS_ORIGIN=http://localhost:5173
npm run dev
# → http://localhost:8787
```

---

## Part 4 — Deploy the frontend (Cloudflare Pages)

### 4.1 Connect Git (recommended)

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. Select your fork
3. Build settings:

   | Field | Value |
   |---|---|
   | Production branch | `main` (or yours) |
   | Framework preset | Vite |
   | Root directory | **`apps/web`** |
   | Build command | `npm run build` |
   | Build output directory | `dist` |

4. **Environment variables** (Production — and Preview if you use previews):

   | Variable | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | Supabase Project URL |
   | `VITE_SUPABASE_ANON_KEY` | Supabase anon key |
   | `VITE_WORKER_API_URL` | Your **Pages URL** once same-origin proxy works, **or** Worker URL initially |

   Practical approach:

   - First deploy: set `VITE_WORKER_API_URL` to the **Worker** URL so the UI can talk to the API immediately.
   - After Part 4.2–4.3: set `VITE_WORKER_API_URL` to the **Pages** origin (or leave empty if your client treats empty as same-origin — check `apps/web/src/lib/api.ts`) and rebuild.

5. **Save and Deploy**. Copy Pages URL: `https://something.pages.dev`.

### 4.2 Pages Functions → Worker (same origin)

The repo includes:

- `apps/web/functions/api/[[path]].ts`
- `apps/web/functions/v1/[[path]].ts`
- `apps/web/functions/health.ts`
- `apps/web/functions/_lib/proxy.ts`

These reverse-proxy `/api`, `/v1`, `/health` to the Worker.

**Critical for forks:** `proxy.ts` has a `DEFAULT_WORKER` fallback hostname. Either:

1. Set a **Pages runtime** (not build) env var **`WORKER_URL`** = your Worker origin (no trailing slash), **or**
2. Edit `DEFAULT_WORKER` in `apps/web/functions/_lib/proxy.ts` to your Worker URL and redeploy Pages.

Without this, `/v1` and `/api` on Pages will hit the wrong Worker (or the previous author’s).

SPA deep links use `apps/web/public/_redirects`:

```
/*    /index.html   200
```

Do not route `/api` `/v1` `/health` through SPA fallback — Functions handle those first.

### 4.3 Manual Pages deploy (alternative)

```bash
cd apps/web
# ensure .env or CI env has VITE_* set at build time
npm run build
npx wrangler pages deploy dist --project-name=your-pages-project
```

Still set `WORKER_URL` on the Pages project for Functions.

---

## Part 5 — Wire URLs together

### 5.1 Worker CORS → Pages

Set `CORS_ORIGIN` in `wrangler.jsonc` to your Pages URL (and localhost if needed), then:

```bash
cd apps/worker
npx wrangler deploy
```

### 5.2 Supabase Auth URLs → Pages

Supabase → **Authentication** → **URL Configuration**:

| Field | Example |
|---|---|
| **Site URL** | `https://your-app.pages.dev` |
| **Redirect URLs** | `https://your-app.pages.dev` **and** `https://your-app.pages.dev/dashboard` |

Add localhost variants if you develop locally.

Discord OAuth redirect remains the **Supabase** callback from Part 2 (not the Pages URL).

### 5.3 Rebuild Pages if `VITE_*` changed

Vite inlines `VITE_*` at **build** time. Changing them requires a new Pages build/deploy.

---

## Part 6 — First-run smoke test

### 6.1 Owner admin

1. Open `https://your-app.pages.dev/admin`
2. Log in with `OWNER_LOGIN` / `OWNER_PASSWORD`
3. **Channels → Add**:
   - **Name:** short, **no `/`**, unique (becomes model prefix), e.g. `openrouter`
   - **Base URL:** provider base, e.g. `https://openrouter.ai/api`
   - **API key:** provider key
   - **Test connection** → select models to expose → save
4. **Models** — confirm **Public ID** like `openrouter/gpt-4o`

### 6.2 User dashboard

1. Incognito → `https://your-app.pages.dev/dashboard`
2. **Continue with Discord** → authorize
3. Copy issued `sk-...` key

If guild gate is enabled in **Admin → Settings**, the user must be in the required Discord server (bot must be in that server with permission to see members).

### 6.3 Real completion

```bash
curl https://your-app.pages.dev/v1/chat/completions \
  -H "Authorization: Bearer sk-YOUR_USER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"openrouter/gpt-4o","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

Or hit the Worker host directly the same way.

Expect a completion, then a row in **Admin → Logs** and counters on **Models**.

---

## Part 7 — Settings you will actually use

**Admin → Settings** (and **Roles** if exposed in UI):

| Control | Notes |
|---|---|
| Role RPM / RPD / token limits | Per-role; null/empty = unlimited. 429 **before** upstream |
| `count_tokens` | Off = use provider `usage` (usual). On = Worker `gpt-tokenizer` |
| `log_user_prompt` | Off recommended. On stores full prompts/responses (storage!) |
| CSAM scan / action | `log` vs `log_and_block` |
| Required Discord guild + invite URL | Optional membership gate |

Logs older than **30 days** are deleted by the hourly cron (`LOG_RETENTION_DAYS` in `apps/worker/src/index.ts`).

---

## Local full stack checklist

| Service | Command | URL |
|---|---|---|
| Worker | `cd apps/worker && npm run dev` | http://localhost:8787 |
| Web | `cd apps/web && npm run dev` | http://localhost:5173 |
| Web `.env` | `VITE_WORKER_API_URL=http://localhost:8787` | |
| Worker `.dev.vars` | secrets + `CORS_ORIGIN=http://localhost:5173` | |
| Supabase redirects | include localhost | |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Discord `redirect_uri mismatch` | Discord app redirect = Supabase callback; Supabase Site/Redirect = **Pages** (or localhost) |
| Dashboard CORS errors | `CORS_ORIGIN` must include exact Pages origin; redeploy Worker |
| Pages `/api` or `/v1` 502 / wrong host | Set Pages `WORKER_URL` or fix `DEFAULT_WORKER` in `functions/_lib/proxy.ts` |
| Empty models for user | Expose models on an **active** channel; check Public IDs |
| `401` / `key_disabled` | User disabled in admin, or bad key |
| `404 model_not_found` | Use **`channel/model`** public id from `GET /v1/models` |
| `429` | Role/global limits; returned before upstream |
| Upstream 403 / Cloudflare HTML | Provider blocking Worker egress; try another channel host |
| Admin works, user Discord fails | Supabase provider + URL config |
| Free Supabase paused | Hourly Worker cron keep-alive; hit `/health` once after long idle |

### RLS quick check (anon key, logged-in user)

1. `channels` / `settings` → no access  
2. `logs` / `app_users` → own rows only  
3. `models` where `is_exposed` → readable  

Owner data always via Worker `/api/admin/*`, never service role in browser.

---

## Value map (where each secret goes)

| Value | Created in | Used by |
|---|---|---|
| Supabase Project URL | Part 1 | Worker secret + `VITE_SUPABASE_URL` |
| anon key | Part 1 | `VITE_SUPABASE_ANON_KEY` only |
| service_role key | Part 1 | Worker secret only |
| Discord OAuth Client ID/Secret | Part 2 | Supabase Discord provider |
| Worker URL | Part 3 | Pages `WORKER_URL` / `VITE_WORKER_API_URL` / curls |
| Pages URL | Part 4 | Worker `CORS_ORIGIN`, Supabase Site/Redirect URLs |
| OWNER_* / SESSION_SECRET | You | Worker secrets |
| Optional bot secrets | Discord bot | Worker secrets + interactions URL |

---

## After fork — do not forget

1. Change **all** secrets (do not reuse the original author’s).  
2. Point **`WORKER_URL` / `DEFAULT_WORKER`** at **your** Worker.  
3. Update **Discord** + **Supabase** redirect URLs for **your** domain.  
4. Re-run migrations on **your** Supabase project.  
5. If you use this in production for a community: **star the upstream repo** so others can find it.

You are done when: admin can add a channel, a Discord user gets a key, and `curl` to `/v1/chat/completions` streams a real answer with a log row.

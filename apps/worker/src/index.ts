import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createServiceClient } from './lib/db'
import admin from './routes/admin'
import { adminAuth, userAuth } from './routes/auth'
import discord from './routes/discord'
import publicRoutes from './routes/public'
import proxy from './routes/proxy'
import type { Env } from './types'

export type AppEnv = {
	Bindings: Env
	Variables: {
		apiUser?: import('./types').AppUser
		apiKey?: string
	}
}

const app = new Hono<AppEnv>()

app.use('*', async (c, next) => {
	// Comma-separated list supported, e.g. "https://a.pages.dev,http://localhost:5173"
	const raw = c.env.CORS_ORIGIN || 'http://localhost:5173'
	const allowed = raw
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
	const reqOrigin = c.req.header('Origin')
	const path = new URL(c.req.url).pathname

	// Public OpenAI API uses Bearer keys, not cookies — allow any browser origin
	// so local test pages (file://, Live Server, etc.) are not blocked by CORS.
	const isPublicApi = path === '/v1' || path.startsWith('/v1/') || path === '/health'

	const middleware = cors({
		origin: isPublicApi
			? (reqOrigin ?? '*')
			: reqOrigin && allowed.includes(reqOrigin)
				? reqOrigin
				: (allowed[0] ?? 'http://localhost:5173'),
		// credentials only needed for owner cookie/admin; * + credentials is invalid
		credentials: !isPublicApi,
		allowHeaders: ['Content-Type', 'Authorization', 'X-Owner-Session'],
		allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
		exposeHeaders: ['Content-Type'],
	})
	return middleware(c, next)
})

app.get('/health', (c) => c.json({ ok: true }))

app.route('/api/admin', adminAuth)
app.route('/api/admin', admin)
app.route('/api/user', userAuth)
app.route('/api/public', publicRoutes)
app.route('/api/discord', discord)
app.route('/v1', proxy)

app.notFound((c) => c.json({ error: 'Not found' }, 404))

app.onError((err, c) => {
	// Log the detail server-side; never leak messages/stack traces to clients.
	console.error(err)
	return c.json({ error: { message: 'Internal error', type: 'server_error' } }, 500)
})

async function keepSupabaseAwake(env: Env): Promise<void> {
	try {
		const db = createServiceClient(env)
		await db.from('settings').select('id').eq('id', 1).maybeSingle()
	} catch (e) {
		console.error('keep-alive failed', e)
	}
}

/** Retention: delete logs older than LOG_RETENTION_DAYS to protect Supabase free-tier storage. */
const LOG_RETENTION_DAYS = 30

async function pruneOldLogs(env: Env): Promise<void> {
	try {
		const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
		const db = createServiceClient(env)
		const { error } = await db.from('logs').delete().lt('created_at', cutoff)
		if (error) console.error('log prune failed', error)
	} catch (e) {
		console.error('log prune failed', e)
	}
}

export default {
	fetch: app.fetch,
	async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(keepSupabaseAwake(env))
		ctx.waitUntil(pruneOldLogs(env))
	},
}

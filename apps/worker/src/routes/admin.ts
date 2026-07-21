import { Hono } from 'hono'
import { ownerAuthStatus } from '../lib/auth'
import {
	forwardToChannel,
	normalizeBaseUrl,
	truncateForLog,
} from '../lib/channelClient'
import { createServiceClient } from '../lib/db'
import { buildPublicModelId } from '../lib/modelId'
import { computeIsActive } from '../lib/discordGuild'
import {
	getDailyQuotaWindow,
	getUserUsageStats,
	getWindowUsage,
	sumUserTokens,
} from '../lib/rateLimit'
import {
	getChannelRoleIds,
	getChannelRolesMap,
	getDefaultRole,
	getRoleById,
	getUserRoleLimits,
	listRoles,
	mapRole,
	setChannelRoles,
} from '../lib/roles'
import { getSettings, invalidateSettingsCache } from '../lib/settings'
import type { Env } from '../types'
import { doRegisterCommands } from './discord'

const admin = new Hono<{ Bindings: Env }>()

admin.use('*', async (c, next) => {
	const status = await ownerAuthStatus(c)
	if (!status.ok) {
		return c.json(
			{
				error: 'Unauthorized',
				reason: status.reason,
				hint:
					status.reason === 'no_token'
						? 'No owner session on this request (cookie blocked or token missing).'
						: 'Owner session token invalid or expired.',
			},
			401,
		)
	}
	return next()
})

function maskKey(key: string): string {
	if (key.length <= 8) return '****'
	return `${key.slice(0, 4)}…${key.slice(-4)}`
}

/**
 * Channel names are used as the prefix in public model ids (`<name>/<model>`),
 * so they must not contain a slash and must be unique (case-insensitive).
 * Returns an error message, or null if the name is valid and free.
 */
async function validateChannelName(
	db: ReturnType<typeof createServiceClient>,
	name: string,
	excludeId?: string,
): Promise<string | null> {
	if (name.includes('/')) {
		return 'Channel name cannot contain a slash (it is used as the model id prefix)'
	}
	let query = db.from('channels').select('id').ilike('name', name)
	if (excludeId) query = query.neq('id', excludeId)
	const { data, error } = await query.maybeSingle()
	if (error) return null // don't block on lookup errors; DB constraints are the backstop
	if (data) return 'A channel with this name already exists'
	return null
}

type UpstreamModel = { id: string; name?: string }

function parseModelsResponse(body: unknown): UpstreamModel[] {
	if (!body || typeof body !== 'object') return []
	const obj = body as Record<string, unknown>
	const list = Array.isArray(obj.data)
		? obj.data
		: Array.isArray(obj.models)
			? obj.models
			: Array.isArray(body)
				? (body as unknown[])
				: []
	const out: UpstreamModel[] = []
	for (const item of list) {
		if (typeof item === 'string') {
			out.push({ id: item })
			continue
		}
		if (item && typeof item === 'object') {
			const m = item as Record<string, unknown>
			const id = (m.id ?? m.model ?? m.name) as string | undefined
			if (id && typeof id === 'string') {
				out.push({
					id,
					name: typeof m.name === 'string' ? m.name : undefined,
				})
			}
		}
	}
	return out
}

admin.get('/channels', async (c) => {
	const db = createServiceClient(c.env)
	const { data: channels, error } = await db
		.from('channels')
		.select('id, name, base_url, api_key, created_at, is_active')
		.order('created_at', { ascending: false })
	if (error) return c.json({ error: error.message }, 500)

	const { data: models, error: mErr } = await db.from('models').select('id, channel_id')
	if (mErr) return c.json({ error: mErr.message }, 500)

	const counts = new Map<string, number>()
	for (const m of models ?? []) {
		counts.set(m.channel_id, (counts.get(m.channel_id) ?? 0) + 1)
	}

	let roleMap: Map<string, string[]>
	try {
		roleMap = await getChannelRolesMap(db)
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
	}

	return c.json({
		channels: (channels ?? []).map((ch) => ({
			id: ch.id,
			name: ch.name,
			base_url: ch.base_url,
			api_key_masked: maskKey(ch.api_key),
			created_at: ch.created_at,
			is_active: ch.is_active,
			model_count: counts.get(ch.id) ?? 0,
			role_ids: roleMap.get(ch.id) ?? [],
		})),
	})
})

admin.post('/channels/test', async (c) => {
	let body: { base_url?: string; api_key?: string }
	try {
		body = await c.req.json()
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400)
	}
	const baseUrl = body.base_url?.trim()
	const apiKey = body.api_key?.trim()
	if (!baseUrl || !apiKey) {
		return c.json({ error: 'base_url and api_key are required' }, 400)
	}

	const url = `${normalizeBaseUrl(baseUrl)}/v1/models`
	let upstream: Response
	try {
		upstream = await forwardToChannel(baseUrl, apiKey, '/v1/models', { method: 'GET' })
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e)
		return c.json({ error: `Failed to reach upstream: ${msg}` }, 502)
	}

	const text = await upstream.text()
	let json: unknown = null
	try {
		json = text ? JSON.parse(text) : null
	} catch {
		json = null
	}

	if (!upstream.ok) {
		// Surface the real upstream failure so the owner can see *why* (§9.2):
		// a 401 means bad key, 404 usually means a wrong base URL / path, etc.
		const detail =
			(json && typeof json === 'object'
				? ((json as { error?: { message?: string } }).error?.message ??
					JSON.stringify(json).slice(0, 500))
				: text.slice(0, 500)) || '(empty response)'
		return c.json(
			{
				error: `Upstream returned ${upstream.status} from ${url} — ${detail}`,
				status: upstream.status,
				body: json ?? text.slice(0, 2000),
			},
			502,
		)
	}

	const models = parseModelsResponse(json)
	if (models.length === 0) {
		return c.json(
			{
				error: `Connected to ${url} but found no models in the response. Check the base URL is the provider's API root (we append /v1/models).`,
				body: json ?? text.slice(0, 2000),
			},
			502,
		)
	}
	return c.json({ models })
})

admin.post('/channels', async (c) => {
	let body: {
		name?: string
		base_url?: string
		api_key?: string
		models?: { id: string; name?: string; is_exposed?: boolean }[]
		/** Empty / omitted = open to all roles */
		role_ids?: string[]
	}
	try {
		body = await c.req.json()
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400)
	}

	const name = body.name?.trim()
	const baseUrl = body.base_url?.trim()
	const apiKey = body.api_key?.trim()
	if (!name || !baseUrl || !apiKey) {
		return c.json({ error: 'name, base_url, and api_key are required' }, 400)
	}

	const db = createServiceClient(c.env)
	const nameErr = await validateChannelName(db, name)
	if (nameErr) return c.json({ error: nameErr }, 400)

	const { data: channel, error: chErr } = await db
		.from('channels')
		.insert({
			name,
			base_url: normalizeBaseUrl(baseUrl),
			api_key: apiKey,
			is_active: true,
		})
		.select('*')
		.single()
	if (chErr) return c.json({ error: chErr.message }, 500)

	const modelRows = (body.models ?? []).map((m) => ({
		channel_id: channel.id,
		model_id: m.id,
		display_name: m.name ?? null,
		is_exposed: Boolean(m.is_exposed),
	}))

	if (modelRows.length > 0) {
		const { data: inserted, error: mErr } = await db.from('models').insert(modelRows).select('id')
		if (mErr) return c.json({ error: mErr.message }, 500)
		const stats = (inserted ?? []).map((row) => ({ model_id: row.id }))
		if (stats.length > 0) {
			const { error: sErr } = await db.from('model_stats').insert(stats)
			if (sErr) return c.json({ error: sErr.message }, 500)
		}
	}

	let roleIds: string[] = []
	if (Array.isArray(body.role_ids)) {
		try {
			await setChannelRoles(db, channel.id, body.role_ids)
			roleIds = await getChannelRoleIds(db, channel.id)
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
		}
	}

	return c.json({
		channel: {
			id: channel.id,
			name: channel.name,
			base_url: channel.base_url,
			api_key_masked: maskKey(channel.api_key),
			created_at: channel.created_at,
			is_active: channel.is_active,
			model_count: modelRows.length,
			role_ids: roleIds,
		},
	})
})

admin.get('/channels/:id', async (c) => {
	const id = c.req.param('id')
	const db = createServiceClient(c.env)
	const { data: channel, error } = await db
		.from('channels')
		.select('id, name, base_url, api_key, created_at, is_active')
		.eq('id', id)
		.maybeSingle()
	if (error) return c.json({ error: error.message }, 500)
	if (!channel) return c.json({ error: 'Channel not found' }, 404)

	const { data: models, error: mErr } = await db
		.from('models')
		.select('id, model_id, display_name, is_exposed, created_at')
		.eq('channel_id', id)
		.order('model_id')
	if (mErr) return c.json({ error: mErr.message }, 500)

	let roleIds: string[]
	try {
		roleIds = await getChannelRoleIds(db, id)
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
	}

	return c.json({
		channel: {
			id: channel.id,
			name: channel.name,
			base_url: channel.base_url,
			api_key_masked: maskKey(channel.api_key),
			// full key only for owner edit form re-save; never expose to non-admin routes
			api_key: channel.api_key,
			created_at: channel.created_at,
			is_active: channel.is_active,
			role_ids: roleIds,
		},
		models: models ?? [],
	})
})

admin.patch('/channels/:id', async (c) => {
	const id = c.req.param('id')
	let body: {
		is_active?: boolean
		name?: string
		base_url?: string
		api_key?: string
		/** When set, upserts models for this channel (id = upstream model_id). */
		models?: { id: string; name?: string; is_exposed?: boolean }[]
		/** When set, replaces channel role allowlist (empty = open to all). */
		role_ids?: string[]
	}
	try {
		body = await c.req.json()
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400)
	}

	const patch: Record<string, unknown> = {}
	if (typeof body.is_active === 'boolean') patch.is_active = body.is_active
	if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim()
	if (typeof body.base_url === 'string' && body.base_url.trim()) {
		patch.base_url = normalizeBaseUrl(body.base_url)
	}
	if (typeof body.api_key === 'string' && body.api_key.trim()) {
		patch.api_key = body.api_key.trim()
	}

	const db = createServiceClient(c.env)

	if (typeof patch.name === 'string') {
		const nameErr = await validateChannelName(db, patch.name, id)
		if (nameErr) return c.json({ error: nameErr }, 400)
	}

	if (Object.keys(patch).length === 0 && !body.models && !Array.isArray(body.role_ids)) {
		return c.json({ error: 'No valid fields to update' }, 400)
	}

	let data: {
		id: string
		name: string
		base_url: string
		api_key: string
		created_at: string
		is_active: boolean
	}

	if (Object.keys(patch).length > 0) {
		const { data: updated, error } = await db
			.from('channels')
			.update(patch)
			.eq('id', id)
			.select('*')
			.single()
		if (error) return c.json({ error: error.message }, 500)
		data = updated
	} else {
		const { data: existing, error } = await db.from('channels').select('*').eq('id', id).single()
		if (error) return c.json({ error: error.message }, 500)
		data = existing
	}

	// Upsert models when provided (add new ones, update is_exposed / display_name)
	if (body.models && Array.isArray(body.models)) {
		const { data: existingModels, error: exErr } = await db
			.from('models')
			.select('id, model_id')
			.eq('channel_id', id)
		if (exErr) return c.json({ error: exErr.message }, 500)
		const byModelId = new Map((existingModels ?? []).map((m) => [m.model_id as string, m.id as string]))

		const toInsert: {
			channel_id: string
			model_id: string
			display_name: string | null
			is_exposed: boolean
		}[] = []
		const toUpdate: { id: string; is_exposed: boolean; display_name: string | null }[] = []

		for (const m of body.models) {
			if (!m?.id || typeof m.id !== 'string') continue
			const existingId = byModelId.get(m.id)
			const is_exposed = Boolean(m.is_exposed)
			const display_name = m.name ?? null
			if (existingId) {
				toUpdate.push({ id: existingId, is_exposed, display_name })
			} else {
				toInsert.push({
					channel_id: id,
					model_id: m.id,
					display_name,
					is_exposed,
				})
			}
		}

		for (const u of toUpdate) {
			const { error: uErr } = await db
				.from('models')
				.update({ is_exposed: u.is_exposed, display_name: u.display_name })
				.eq('id', u.id)
			if (uErr) return c.json({ error: uErr.message }, 500)
		}

		if (toInsert.length > 0) {
			const { data: inserted, error: iErr } = await db.from('models').insert(toInsert).select('id')
			if (iErr) return c.json({ error: iErr.message }, 500)
			const stats = (inserted ?? []).map((row) => ({ model_id: row.id }))
			if (stats.length > 0) {
				const { error: sErr } = await db.from('model_stats').insert(stats)
				if (sErr) return c.json({ error: sErr.message }, 500)
			}
		}
	}

	if (Array.isArray(body.role_ids)) {
		try {
			await setChannelRoles(db, id, body.role_ids)
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
		}
	}

	const { count } = await db
		.from('models')
		.select('id', { count: 'exact', head: true })
		.eq('channel_id', id)

	let roleIds: string[]
	try {
		roleIds = await getChannelRoleIds(db, id)
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
	}

	return c.json({
		channel: {
			id: data.id,
			name: data.name,
			base_url: data.base_url,
			api_key_masked: maskKey(data.api_key),
			created_at: data.created_at,
			is_active: data.is_active,
			model_count: count ?? 0,
			role_ids: roleIds,
		},
	})
})

admin.delete('/channels/:id', async (c) => {
	const id = c.req.param('id')
	const db = createServiceClient(c.env)
	// Cascades to models + model_stats; logs.channel_id is SET NULL (see migration 006).
	const { error } = await db.from('channels').delete().eq('id', id)
	if (error) {
		const msg = error.message
		if (msg.includes('logs_channel_id_fkey') || msg.includes('foreign key')) {
			return c.json(
				{
					error:
						'Cannot delete channel: logs still reference it. Apply migration 006 (logs channel_id ON DELETE SET NULL).',
				},
				409,
			)
		}
		return c.json({ error: msg }, 500)
	}
	return c.json({ ok: true })
})

admin.get('/models', async (c) => {
	const db = createServiceClient(c.env)
	const { data: models, error } = await db
		.from('models')
		.select('id, channel_id, model_id, display_name, is_exposed, created_at, channels(name)')
		.order('model_id', { ascending: true })
	if (error) return c.json({ error: error.message }, 500)

	const { data: stats, error: sErr } = await db.from('model_stats').select('*')
	if (sErr) return c.json({ error: sErr.message }, 500)
	const statsMap = new Map((stats ?? []).map((s) => [s.model_id, s]))

	const rows = (models ?? []).map((m) => {
		const st = statsMap.get(m.id)
		const total = Number(st?.total_requests ?? 0)
		const errors = Number(st?.total_errors ?? 0)
		const channelRel = m.channels as { name?: string } | { name?: string }[] | null
		const channelName = Array.isArray(channelRel)
			? (channelRel[0]?.name ?? null)
			: (channelRel?.name ?? null)
		return {
			id: m.id,
			channel_id: m.channel_id,
			channel_name: channelName,
			model_id: m.model_id,
			display_name: m.display_name,
			is_exposed: m.is_exposed,
			created_at: m.created_at,
			total_requests: total,
			total_errors: errors,
			success_rate: total === 0 ? null : ((total - errors) / total) * 100,
		}
	})

	return c.json({ models: rows })
})

admin.patch('/models/:id', async (c) => {
	const id = c.req.param('id')
	let body: { is_exposed?: boolean; display_name?: string | null }
	try {
		body = await c.req.json()
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400)
	}

	const patch: Record<string, unknown> = {}
	if (typeof body.is_exposed === 'boolean') patch.is_exposed = body.is_exposed
	if (body.display_name !== undefined) patch.display_name = body.display_name
	if (Object.keys(patch).length === 0) {
		return c.json({ error: 'No valid fields to update' }, 400)
	}

	const db = createServiceClient(c.env)
	const { data, error } = await db.from('models').update(patch).eq('id', id).select('*').single()
	if (error) return c.json({ error: error.message }, 500)
	return c.json({ model: data })
})

/**
 * Test a model either:
 * - `provider`: POST to channel base_url /v1/chat/completions with the channel key (upstream only)
 * - `proxy`: same path our public proxy uses (resolve + forward with channel key)
 *
 * Returns full status + body for owner copy/debug.
 */
admin.post('/models/:id/test', async (c) => {
	const id = c.req.param('id')
	let body: { via?: 'provider' | 'proxy'; message?: string; max_tokens?: number }
	try {
		body = await c.req.json()
	} catch {
		body = {}
	}
	const via = body.via === 'proxy' ? 'proxy' : 'provider'
	const message =
		typeof body.message === 'string' && body.message.trim()
			? body.message.trim()
			: 'Hello — connection test from AI Proxy admin.'
	const maxTokens =
		typeof body.max_tokens === 'number' && Number.isFinite(body.max_tokens) && body.max_tokens > 0
			? Math.min(Math.floor(body.max_tokens), 64)
			: 16

	const db = createServiceClient(c.env)
	const { data: model, error: mErr } = await db
		.from('models')
		.select('id, model_id, is_exposed, channel_id, channels(id, name, base_url, api_key, is_active)')
		.eq('id', id)
		.maybeSingle()
	if (mErr) return c.json({ error: mErr.message }, 500)
	if (!model) return c.json({ error: 'Model not found' }, 404)

	const chRel = model.channels as
		| {
				id?: string
				name?: string
				base_url?: string
				api_key?: string
				is_active?: boolean
		  }
		| {
				id?: string
				name?: string
				base_url?: string
				api_key?: string
				is_active?: boolean
		  }[]
		| null
	const ch = Array.isArray(chRel) ? chRel[0] : chRel
	if (!ch?.base_url || !ch.api_key || !ch.name) {
		return c.json({ error: 'Channel missing base_url or api_key' }, 400)
	}
	if (!ch.is_active) {
		return c.json({ error: 'Channel is inactive' }, 400)
	}

	const rawModelId = model.model_id as string
	const publicId = buildPublicModelId(ch.name, rawModelId)
	const payload = {
		model: rawModelId,
		messages: [{ role: 'user', content: message }],
		max_tokens: maxTokens,
		stream: false,
	}
	const started = Date.now()

	// Both paths hit the provider with the channel key. "proxy" validates the same
	// public model id + exposure rules users need; "provider" is a raw upstream check.
	if (via === 'proxy' && !model.is_exposed) {
		return c.json(
			{
				ok: false,
				via,
				public_model_id: publicId,
				error:
					'Model is not exposed. Toggle Exposed on, or use "Test provider" which ignores exposure.',
				duration_ms: Date.now() - started,
			},
			400,
		)
	}

	const upstreamPath = '/v1/chat/completions'
	const requestUrl = `${normalizeBaseUrl(ch.base_url)}${upstreamPath}`
	let upstream: Response
	try {
		upstream = await forwardToChannel(ch.base_url, ch.api_key, upstreamPath, {
			method: 'POST',
			body: JSON.stringify(payload),
		})
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e)
		return c.json({
			ok: false,
			via,
			public_model_id: publicId,
			raw_model_id: rawModelId,
			request_url: requestUrl,
			request_body: payload,
			status: 0,
			error: `Failed to reach upstream: ${msg}`,
			body: null,
			duration_ms: Date.now() - started,
		})
	}

	const text = await upstream.text()
	let json: unknown = null
	try {
		json = text ? JSON.parse(text) : null
	} catch {
		json = null
	}

	const ok = upstream.ok
	const bodyOut = truncateForLog(json ?? text, 12000)
	const errMsg =
		!ok && json && typeof json === 'object'
			? ((json as { error?: { message?: string } }).error?.message ??
				(typeof (json as { error?: string }).error === 'string'
					? (json as { error: string }).error
					: null))
			: !ok
				? text.slice(0, 500) || `HTTP ${upstream.status}`
				: null

	const publicBase =
		(c.env.CORS_ORIGIN && c.env.CORS_ORIGIN.replace(/\/+$/, '')) ||
		new URL(c.req.url).origin

	return c.json({
		ok,
		via,
		public_model_id: publicId,
		raw_model_id: rawModelId,
		request_url: requestUrl,
		// What end users should call (Pages origin if reverse-proxied, else Worker)
		client_url: `${publicBase}/v1/chat/completions`,
		client_body: { ...payload, model: publicId },
		request_body: payload,
		status: upstream.status,
		error: errMsg,
		body: bodyOut,
		// HTML 403 pages (Cloudflare bot blocks) are common — flag for the UI
		looks_like_cloudflare_block:
			!ok &&
			typeof text === 'string' &&
			(text.includes('Attention Required') ||
				text.includes('cf-error-details') ||
				text.includes('Cloudflare')),
		duration_ms: Date.now() - started,
	})
})

// --- Users ---

function mapAdminUser(u: {
	id: string
	discord_id: string
	discord_username: string | null
	registered_at: string
	last_ip: string | null
	is_active: boolean
	admin_disabled?: boolean | null
	role_id?: string | null
	log_user_prompt?: boolean | null
	roles?: unknown
}) {
	const roleRel = u.roles as { id?: string; name?: string } | { id?: string; name?: string }[] | null
	const role = Array.isArray(roleRel) ? roleRel[0] : roleRel
	const adminDisabled = Boolean(u.admin_disabled)
	const isActive = Boolean(u.is_active)
	return {
		id: u.id,
		discord_id: u.discord_id,
		discord_username: u.discord_username,
		registered_at: u.registered_at,
		last_ip: u.last_ip,
		is_active: isActive,
		admin_disabled: adminDisabled,
		/** For UI badge when disabled */
		disable_reason: isActive ? null : adminDisabled ? ('admin' as const) : ('guild' as const),
		role_id: (u.role_id as string | null) ?? null,
		role_name: role?.name ?? null,
		log_user_prompt: Boolean(u.log_user_prompt),
	}
}

function usageBucket(
	success: number,
	errors: number,
	limit: number | null,
): {
	success: number
	errors: number
	limit: number | null
	remaining: number | null
	unlimited: boolean
} {
	const unlimited = limit == null
	return {
		success,
		errors,
		limit,
		remaining: unlimited ? null : Math.max(0, limit - success),
		unlimited,
	}
}

/** Token usage bucket: `used` maps to `success` field for shared UI cards. */
function tokenBucket(
	used: number,
	limit: number | null,
): {
	success: number
	errors: number
	limit: number | null
	remaining: number | null
	unlimited: boolean
} {
	return usageBucket(used, 0, limit)
}

admin.get('/users', async (c) => {
	const q = c.req.query('q')?.trim()
	const db = createServiceClient(c.env)
	let query = db
		.from('app_users')
		.select(
			'id, discord_id, discord_username, registered_at, last_ip, is_active, admin_disabled, role_id, log_user_prompt, roles(id, name)',
		)
		.order('registered_at', { ascending: false })

	if (q) {
		query = query.or(`discord_username.ilike.%${q}%,discord_id.ilike.%${q}%`)
	}

	const { data, error } = await query
	if (error) return c.json({ error: error.message }, 500)

	return c.json({ users: (data ?? []).map((u) => mapAdminUser(u)) })
})

admin.get('/users/:id', async (c) => {
	const id = c.req.param('id')
	const db = createServiceClient(c.env)
	const { data, error } = await db
		.from('app_users')
		.select(
			'id, discord_id, discord_username, registered_at, last_ip, is_active, admin_disabled, role_id, log_user_prompt, roles(id, name)',
		)
		.eq('id', id)
		.maybeSingle()
	if (error) return c.json({ error: error.message }, 500)
	if (!data) return c.json({ error: 'User not found' }, 404)

	const user = mapAdminUser(data)

	let limits: {
		requests_per_minute: number | null
		requests_per_day: number | null
		tokens_per_minute: number | null
		tokens_per_day: number | null
	}
	try {
		const resolved = await getUserRoleLimits(db, user.role_id)
		limits = resolved.limits
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
	}

	const now = Date.now()
	const minuteSince = new Date(now - 60_000).toISOString()
	const dayWindow = getDailyQuotaWindow(now)

	let minute: { success: number; errors: number }
	let day: { success: number; errors: number }
	let tokensMinute: number
	let tokensDay: number
	let stats: Awaited<ReturnType<typeof getUserUsageStats>>
	try {
		;[minute, day, tokensMinute, tokensDay, stats] = await Promise.all([
			getWindowUsage(db, id, minuteSince, false),
			getWindowUsage(db, id, dayWindow.sinceIso, true),
			sumUserTokens(db, id, minuteSince, false),
			sumUserTokens(db, id, dayWindow.sinceIso, true),
			getUserUsageStats(db, id, dayWindow.sinceIso),
		])
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
	}

	return c.json({
		user,
		limits: {
			requests_per_minute: limits.requests_per_minute,
			requests_per_day: limits.requests_per_day,
			tokens_per_minute: limits.tokens_per_minute,
			tokens_per_day: limits.tokens_per_day,
		},
		minute: usageBucket(minute.success, minute.errors, limits.requests_per_minute),
		day: {
			...usageBucket(day.success, day.errors, limits.requests_per_day),
			resets_at: dayWindow.resetsAtIso,
		},
		tokens_minute: tokenBucket(tokensMinute, limits.tokens_per_minute),
		tokens_day: {
			...tokenBucket(tokensDay, limits.tokens_per_day),
			resets_at: dayWindow.resetsAtIso,
		},
		stats,
	})
})

admin.patch('/users/:id', async (c) => {
	const id = c.req.param('id')
	let body: { is_active?: boolean; role_id?: string | null; log_user_prompt?: boolean }
	try {
		body = await c.req.json()
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400)
	}

	const db = createServiceClient(c.env)
	const { data: existing, error: exErr } = await db
		.from('app_users')
		.select('id, discord_id, is_active, admin_disabled')
		.eq('id', id)
		.maybeSingle()
	if (exErr) return c.json({ error: exErr.message }, 500)
	if (!existing) return c.json({ error: 'User not found' }, 404)

	const patch: Record<string, unknown> = {}

	if (typeof body.is_active === 'boolean') {
		if (!body.is_active) {
			// Owner disable: remember admin intent
			patch.admin_disabled = true
			patch.is_active = false
		} else {
			// Owner enable: clear admin flag, recompute from guild gate
			const settings = await getSettings(db)
			const activeResult = await computeIsActive({
				adminDisabled: false,
				requiredGuildId: settings.required_discord_guild_id,
				discordUserId: existing.discord_id as string,
				botToken: c.env.DISCORD_BOT_TOKEN,
				previousIsActive: true,
			})
			patch.admin_disabled = false
			patch.is_active = activeResult.is_active
		}
	}

	if ('role_id' in body) {
		if (body.role_id === null || body.role_id === undefined || body.role_id === '') {
			try {
				const def = await getDefaultRole(db)
				if (!def) return c.json({ error: 'No default role configured' }, 500)
				patch.role_id = def.id
			} catch (e) {
				return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
			}
		} else if (typeof body.role_id === 'string') {
			try {
				const role = await getRoleById(db, body.role_id)
				if (!role) return c.json({ error: 'Role not found' }, 400)
				patch.role_id = role.id
			} catch (e) {
				return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
			}
		} else {
			return c.json({ error: 'role_id must be a string or null' }, 400)
		}
	}

	if (typeof body.log_user_prompt === 'boolean') {
		patch.log_user_prompt = body.log_user_prompt
	}

	if (Object.keys(patch).length === 0) {
		return c.json({ error: 'is_active, role_id, and/or log_user_prompt required' }, 400)
	}

	const { data, error } = await db
		.from('app_users')
		.update(patch)
		.eq('id', id)
		.select(
			'id, discord_id, discord_username, registered_at, last_ip, is_active, admin_disabled, role_id, log_user_prompt, roles(id, name)',
		)
		.single()
	if (error) return c.json({ error: error.message }, 500)

	return c.json({ user: mapAdminUser(data) })
})

// --- Logs ---

admin.get('/logs', async (c) => {
	const page = Math.max(1, Number(c.req.query('page') || '1') || 1)
	const pageSize = 50
	const userId = c.req.query('user_id')?.trim()
	const modelId = c.req.query('model_id')?.trim()
	const from = c.req.query('from')?.trim()
	const to = c.req.query('to')?.trim()
	const errorsOnly =
		c.req.query('errors_only') === '1' ||
		c.req.query('errors_only') === 'true' ||
		c.req.query('is_error') === '1' ||
		c.req.query('is_error') === 'true'
	const csamOnly =
		c.req.query('csam') === '1' ||
		c.req.query('csam') === 'true' ||
		c.req.query('csam_flagged') === '1' ||
		c.req.query('csam_flagged') === 'true'
	const csamReviewedRaw = c.req.query('csam_reviewed')?.trim()
	const csamReviewed =
		csamReviewedRaw === '1' || csamReviewedRaw === 'true'
			? true
			: csamReviewedRaw === '0' || csamReviewedRaw === 'false'
				? false
				: null

	const db = createServiceClient(c.env)
	let query = db
		.from('logs')
		.select(
			'id, user_id, api_key, model_id, channel_id, ip_address, prompt_tokens, completion_tokens, status_code, is_error, prompt_content, response_content, created_at, csam_flagged, csam_reason, csam_snippet, csam_source, csam_reviewed, csam_reviewed_at, csam_review_note, app_users(discord_username, discord_id)',
			{ count: 'exact' },
		)
		.order('created_at', { ascending: false })

	if (userId) query = query.eq('user_id', userId)
	if (modelId) query = query.ilike('model_id', `%${modelId}%`)
	if (from) query = query.gte('created_at', from)
	if (to) query = query.lte('created_at', to)
	if (errorsOnly) query = query.eq('is_error', true)
	if (csamOnly) query = query.eq('csam_flagged', true)
	if (csamReviewed === true) query = query.eq('csam_reviewed', true)
	if (csamReviewed === false) query = query.eq('csam_reviewed', false)

	const fromIdx = (page - 1) * pageSize
	const toIdx = fromIdx + pageSize - 1
	const { data, error, count } = await query.range(fromIdx, toIdx)
	if (error) return c.json({ error: error.message }, 500)

	const logs = (data ?? []).map((row) => {
		const uRel = row.app_users as
			| { discord_username?: string | null; discord_id?: string }
			| { discord_username?: string | null; discord_id?: string }[]
			| null
		const u = Array.isArray(uRel) ? uRel[0] : uRel
		return {
			id: row.id,
			user_id: row.user_id,
			discord_username: u?.discord_username ?? null,
			discord_id: u?.discord_id ?? null,
			model_id: row.model_id,
			channel_id: row.channel_id,
			ip_address: row.ip_address,
			prompt_tokens: row.prompt_tokens,
			completion_tokens: row.completion_tokens,
			status_code: row.status_code,
			is_error: row.is_error,
			prompt_content: row.prompt_content,
			response_content: row.response_content,
			created_at: row.created_at,
			csam_flagged: Boolean(row.csam_flagged),
			csam_reason: (row.csam_reason as string | null) ?? null,
			csam_snippet: (row.csam_snippet as string | null) ?? null,
			csam_source: (row.csam_source as string | null) ?? null,
			csam_reviewed: Boolean(row.csam_reviewed),
			csam_reviewed_at: (row.csam_reviewed_at as string | null) ?? null,
			csam_review_note: (row.csam_review_note as string | null) ?? null,
		}
	})

	return c.json({
		logs,
		total: count ?? 0,
		page,
		page_size: pageSize,
	})
})

/** Mark a CSAM log as reviewed (or unreviewed) with an optional note. */
admin.patch('/logs/:id/csam-review', async (c) => {
	const id = Number(c.req.param('id'))
	if (!Number.isFinite(id) || id < 1) {
		return c.json({ error: 'Invalid log id' }, 400)
	}

	let body: { reviewed?: boolean; note?: string | null }
	try {
		body = await c.req.json()
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400)
	}

	const patch: Record<string, unknown> = {}
	if (typeof body.reviewed === 'boolean') {
		patch.csam_reviewed = body.reviewed
		patch.csam_reviewed_at = body.reviewed ? new Date().toISOString() : null
	}
	if ('note' in body) {
		if (body.note === null || body.note === undefined) {
			patch.csam_review_note = null
		} else if (typeof body.note === 'string') {
			patch.csam_review_note = body.note.slice(0, 4000)
		} else {
			return c.json({ error: 'note must be a string or null' }, 400)
		}
	}

	if (Object.keys(patch).length === 0) {
		return c.json({ error: 'reviewed and/or note required' }, 400)
	}

	const db = createServiceClient(c.env)
	const { data, error } = await db
		.from('logs')
		.update(patch)
		.eq('id', id)
		.select(
			'id, user_id, model_id, status_code, is_error, created_at, csam_flagged, csam_reason, csam_snippet, csam_source, csam_reviewed, csam_reviewed_at, csam_review_note, prompt_content, response_content, ip_address, prompt_tokens, completion_tokens, channel_id, app_users(discord_username, discord_id)',
		)
		.maybeSingle()
	if (error) return c.json({ error: error.message }, 500)
	if (!data) return c.json({ error: 'Log not found' }, 404)

	const uRel = data.app_users as
		| { discord_username?: string | null; discord_id?: string }
		| { discord_username?: string | null; discord_id?: string }[]
		| null
	const u = Array.isArray(uRel) ? uRel[0] : uRel

	return c.json({
		log: {
			id: data.id,
			user_id: data.user_id,
			discord_username: u?.discord_username ?? null,
			discord_id: u?.discord_id ?? null,
			model_id: data.model_id,
			channel_id: data.channel_id,
			ip_address: data.ip_address,
			prompt_tokens: data.prompt_tokens,
			completion_tokens: data.completion_tokens,
			status_code: data.status_code,
			is_error: data.is_error,
			prompt_content: data.prompt_content,
			response_content: data.response_content,
			created_at: data.created_at,
			csam_flagged: Boolean(data.csam_flagged),
			csam_reason: data.csam_reason ?? null,
			csam_snippet: data.csam_snippet ?? null,
			csam_source: data.csam_source ?? null,
			csam_reviewed: Boolean(data.csam_reviewed),
			csam_reviewed_at: data.csam_reviewed_at ?? null,
			csam_review_note: data.csam_review_note ?? null,
		},
	})
})

/**
 * Prune logs to free storage / remove illegal retained content.
 * Modes:
 * - content: null prompt_content, response_content, csam_snippet (keep metadata)
 * - csam: delete all rows where csam_flagged = true
 * - csam_reviewed: delete rows where csam_flagged and csam_reviewed
 */
admin.post('/logs/prune', async (c) => {
	let body: { mode?: string; dry_run?: boolean }
	try {
		body = await c.req.json()
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400)
	}

	const mode = body.mode
	if (mode !== 'content' && mode !== 'csam' && mode !== 'csam_reviewed') {
		return c.json(
			{ error: 'mode must be content | csam | csam_reviewed' },
			400,
		)
	}
	const dryRun = body.dry_run === true
	const db = createServiceClient(c.env)

	if (mode === 'content') {
		const contentFilter =
			'prompt_content.not.is.null,response_content.not.is.null,csam_snippet.not.is.null'
		const { count, error: countErr } = await db
			.from('logs')
			.select('id', { count: 'exact', head: true })
			.or(contentFilter)
		if (countErr) return c.json({ error: countErr.message }, 500)
		const matched = count ?? 0
		if (dryRun) {
			return c.json({ mode, dry_run: true, affected: matched, complete: true })
		}
		if (matched === 0) {
			return c.json({ mode, dry_run: false, affected: 0, complete: true })
		}
		// Batch by id so we never pull full jsonb payloads into the Worker.
		const BATCH = 200
		const MAX_BATCHES = 50
		let affected = 0
		for (let i = 0; i < MAX_BATCHES; i++) {
			const { data: rows, error: selErr } = await db
				.from('logs')
				.select('id')
				.or(contentFilter)
				.limit(BATCH)
			if (selErr) return c.json({ error: selErr.message, affected }, 500)
			if (!rows?.length) break
			const ids = rows.map((r) => r.id as number)
			const { error: updErr } = await db
				.from('logs')
				.update({
					prompt_content: null,
					response_content: null,
					csam_snippet: null,
				})
				.in('id', ids)
			if (updErr) return c.json({ error: updErr.message, affected }, 500)
			affected += ids.length
			if (ids.length < BATCH) {
				return c.json({ mode, dry_run: false, affected, complete: true })
			}
		}
		const { count: remaining } = await db
			.from('logs')
			.select('id', { count: 'exact', head: true })
			.or(contentFilter)
		return c.json({
			mode,
			dry_run: false,
			affected,
			complete: (remaining ?? 0) === 0,
			remaining: remaining ?? 0,
		})
	}

	// Row delete: csam or csam_reviewed
	const reviewedOnly = mode === 'csam_reviewed'

	let countQ = db
		.from('logs')
		.select('id', { count: 'exact', head: true })
		.eq('csam_flagged', true)
	if (reviewedOnly) countQ = countQ.eq('csam_reviewed', true)
	const { count, error: countErr } = await countQ
	if (countErr) return c.json({ error: countErr.message }, 500)
	const matched = count ?? 0
	if (dryRun) {
		return c.json({ mode, dry_run: true, affected: matched, complete: true })
	}
	if (matched === 0) {
		return c.json({ mode, dry_run: false, affected: 0, complete: true })
	}

	const BATCH = 200
	const MAX_BATCHES = 50
	let affected = 0
	for (let i = 0; i < MAX_BATCHES; i++) {
		let selQ = db.from('logs').select('id').eq('csam_flagged', true).limit(BATCH)
		if (reviewedOnly) selQ = selQ.eq('csam_reviewed', true)
		const { data: rows, error: selErr } = await selQ
		if (selErr) return c.json({ error: selErr.message, affected }, 500)
		if (!rows?.length) break
		const ids = rows.map((r) => r.id as number)
		const { error: delErr } = await db.from('logs').delete().in('id', ids)
		if (delErr) return c.json({ error: delErr.message, affected }, 500)
		affected += ids.length
		if (ids.length < BATCH) {
			return c.json({ mode, dry_run: false, affected, complete: true })
		}
	}

	let remQ = db
		.from('logs')
		.select('id', { count: 'exact', head: true })
		.eq('csam_flagged', true)
	if (reviewedOnly) remQ = remQ.eq('csam_reviewed', true)
	const { count: remaining } = await remQ
	return c.json({
		mode,
		dry_run: false,
		affected,
		complete: (remaining ?? 0) === 0,
		remaining: remaining ?? 0,
	})
})

// --- Roles ---

function parseOptionalLimit(v: unknown, field: string): number | null | undefined | { error: string } {
	if (v === undefined) return undefined
	if (v === null || v === '') return null
	if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v)
	return { error: `${field} must be a non-negative number or null` }
}

admin.get('/roles', async (c) => {
	const db = createServiceClient(c.env)
	try {
		const roles = await listRoles(db)
		return c.json({ roles })
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
	}
})

admin.post('/roles', async (c) => {
	let body: {
		name?: string
		requests_per_day?: number | null
		requests_per_minute?: number | null
		tokens_per_day?: number | null
		tokens_per_minute?: number | null
		is_default?: boolean
	}
	try {
		body = await c.req.json()
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400)
	}

	const name = body.name?.trim()
	if (!name) return c.json({ error: 'name is required' }, 400)

	const rpd = parseOptionalLimit(body.requests_per_day, 'requests_per_day')
	if (rpd && typeof rpd === 'object' && 'error' in rpd) return c.json({ error: rpd.error }, 400)
	const rpm = parseOptionalLimit(body.requests_per_minute, 'requests_per_minute')
	if (rpm && typeof rpm === 'object' && 'error' in rpm) return c.json({ error: rpm.error }, 400)
	const tpd = parseOptionalLimit(body.tokens_per_day, 'tokens_per_day')
	if (tpd && typeof tpd === 'object' && 'error' in tpd) return c.json({ error: tpd.error }, 400)
	const tpm = parseOptionalLimit(body.tokens_per_minute, 'tokens_per_minute')
	if (tpm && typeof tpm === 'object' && 'error' in tpm) return c.json({ error: tpm.error }, 400)

	const db = createServiceClient(c.env)
	const makeDefault = body.is_default === true

	if (makeDefault) {
		const { error: clearErr } = await db
			.from('roles')
			.update({ is_default: false })
			.eq('is_default', true)
		if (clearErr) return c.json({ error: clearErr.message }, 500)
	}

	const { data, error } = await db
		.from('roles')
		.insert({
			name,
			requests_per_day: rpd === undefined ? null : rpd,
			requests_per_minute: rpm === undefined ? null : rpm,
			tokens_per_day: tpd === undefined ? null : tpd,
			tokens_per_minute: tpm === undefined ? null : tpm,
			is_default: makeDefault,
		})
		.select('*')
		.single()
	if (error) {
		if (/unique|duplicate/i.test(error.message)) {
			return c.json({ error: 'A role with that name already exists' }, 400)
		}
		return c.json({ error: error.message }, 500)
	}
	return c.json({ role: mapRole(data) })
})

admin.patch('/roles/:id', async (c) => {
	const id = c.req.param('id')
	let body: {
		name?: string
		requests_per_day?: number | null
		requests_per_minute?: number | null
		tokens_per_day?: number | null
		tokens_per_minute?: number | null
		is_default?: boolean
	}
	try {
		body = await c.req.json()
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400)
	}

	const db = createServiceClient(c.env)
	const existing = await getRoleById(db, id).catch(() => null)
	if (!existing) return c.json({ error: 'Role not found' }, 404)

	const patch: Record<string, unknown> = {}
	if (typeof body.name === 'string' && body.name.trim()) {
		patch.name = body.name.trim()
	}
	if ('requests_per_day' in body) {
		const rpd = parseOptionalLimit(body.requests_per_day, 'requests_per_day')
		if (rpd && typeof rpd === 'object' && 'error' in rpd) return c.json({ error: rpd.error }, 400)
		patch.requests_per_day = rpd ?? null
	}
	if ('requests_per_minute' in body) {
		const rpm = parseOptionalLimit(body.requests_per_minute, 'requests_per_minute')
		if (rpm && typeof rpm === 'object' && 'error' in rpm) return c.json({ error: rpm.error }, 400)
		patch.requests_per_minute = rpm ?? null
	}
	if ('tokens_per_day' in body) {
		const tpd = parseOptionalLimit(body.tokens_per_day, 'tokens_per_day')
		if (tpd && typeof tpd === 'object' && 'error' in tpd) return c.json({ error: tpd.error }, 400)
		patch.tokens_per_day = tpd ?? null
	}
	if ('tokens_per_minute' in body) {
		const tpm = parseOptionalLimit(body.tokens_per_minute, 'tokens_per_minute')
		if (tpm && typeof tpm === 'object' && 'error' in tpm) return c.json({ error: tpm.error }, 400)
		patch.tokens_per_minute = tpm ?? null
	}
	if (typeof body.is_default === 'boolean') {
		if (!body.is_default && existing.is_default) {
			return c.json({ error: 'Cannot unset the only default role; mark another role as default first' }, 400)
		}
		if (body.is_default && !existing.is_default) {
			const { error: clearErr } = await db
				.from('roles')
				.update({ is_default: false })
				.eq('is_default', true)
			if (clearErr) return c.json({ error: clearErr.message }, 500)
			patch.is_default = true
		}
	}

	if (Object.keys(patch).length === 0) {
		return c.json({ error: 'No valid fields to update' }, 400)
	}

	const { data, error } = await db.from('roles').update(patch).eq('id', id).select('*').single()
	if (error) {
		if (/unique|duplicate/i.test(error.message)) {
			return c.json({ error: 'A role with that name already exists' }, 400)
		}
		return c.json({ error: error.message }, 500)
	}
	return c.json({ role: mapRole(data) })
})

admin.delete('/roles/:id', async (c) => {
	const id = c.req.param('id')
	const db = createServiceClient(c.env)

	const existing = await getRoleById(db, id).catch(() => null)
	if (!existing) return c.json({ error: 'Role not found' }, 404)
	if (existing.is_default) {
		return c.json({ error: 'Cannot delete the default role' }, 400)
	}

	const { count, error: cErr } = await db
		.from('app_users')
		.select('id', { count: 'exact', head: true })
		.eq('role_id', id)
	if (cErr) return c.json({ error: cErr.message }, 500)
	if ((count ?? 0) > 0) {
		return c.json(
			{
				error: `Cannot delete role while ${count} user(s) still have it. Reassign them first.`,
			},
			400,
		)
	}

	// channel_roles cascade via FK
	const { error } = await db.from('roles').delete().eq('id', id)
	if (error) return c.json({ error: error.message }, 500)
	return c.json({ ok: true })
})

// --- Settings ---
// Rate limits live on roles; settings holds proxy toggles + optional Discord gate.
// DB columns requests_per_* are left intact (not dropped) for safety.

function emptySnowflake(v: unknown): string | null {
	if (v === null || v === undefined) return null
	if (typeof v !== 'string') return null
	const s = v.trim()
	return s === '' ? null : s
}

function mapAdminSettings(data: Record<string, unknown>) {
	const guild =
		typeof data.required_discord_guild_id === 'string'
			? data.required_discord_guild_id.trim() || null
			: null
	const invite =
		typeof data.discord_invite_url === 'string'
			? data.discord_invite_url.trim() || null
			: null
	const csamAction = data.csam_action === 'log_and_block' ? 'log_and_block' : 'log'
	return {
		count_tokens: Boolean(data.count_tokens),
		log_user_prompt: Boolean(data.log_user_prompt),
		required_discord_guild_id: guild,
		discord_invite_url: invite,
		csam_scan_enabled:
			data.csam_scan_enabled === undefined || data.csam_scan_enabled === null
				? true
				: Boolean(data.csam_scan_enabled),
		csam_action: csamAction as 'log' | 'log_and_block',
		discord_commands_enabled: Boolean(data.discord_commands_enabled),
		discord_cmd_stats_channel_id: emptySnowflake(data.discord_cmd_stats_channel_id),
		discord_cmd_stats_role_id: emptySnowflake(data.discord_cmd_stats_role_id),
		discord_cmd_stats_ephemeral:
			data.discord_cmd_stats_ephemeral === undefined || data.discord_cmd_stats_ephemeral === null
				? true
				: Boolean(data.discord_cmd_stats_ephemeral),
		discord_cmd_assignrole_channel_id: emptySnowflake(data.discord_cmd_assignrole_channel_id),
		discord_cmd_assignrole_role_id: emptySnowflake(data.discord_cmd_assignrole_role_id),
		// Legacy column; role is chosen per /assignrole via Discord option
		discord_cmd_assignrole_target_role_id: emptySnowflake(
			data.discord_cmd_assignrole_target_role_id,
		),
		discord_cmd_assignrole_excluded_role_ids: parseUuidIdList(
			data.discord_cmd_assignrole_excluded_role_ids,
		),
		discord_cmd_assignrole_ephemeral:
			data.discord_cmd_assignrole_ephemeral === undefined ||
			data.discord_cmd_assignrole_ephemeral === null
				? true
				: Boolean(data.discord_cmd_assignrole_ephemeral),
		discord_cmd_rolelist_channel_id: emptySnowflake(data.discord_cmd_rolelist_channel_id),
		discord_cmd_rolelist_role_id: emptySnowflake(data.discord_cmd_rolelist_role_id),
		discord_cmd_rolelist_ephemeral:
			data.discord_cmd_rolelist_ephemeral === undefined ||
			data.discord_cmd_rolelist_ephemeral === null
				? true
				: Boolean(data.discord_cmd_rolelist_ephemeral),
		updated_at: data.updated_at as string | undefined,
	}
}

const ROLE_UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function parseUuidIdList(v: unknown): string[] {
	if (!Array.isArray(v)) return []
	const out: string[] = []
	for (const item of v) {
		if (typeof item !== 'string') continue
		const id = item.trim()
		if (ROLE_UUID_RE.test(id) && !out.includes(id)) out.push(id)
	}
	return out
}

/**
 * Normalize Discord snowflake paste: strip whitespace, zero-width chars,
 * and common mention/link wrappers (<@&id>, <#id>, <@id>, full channel URLs).
 */
function normalizeSnowflakeInput(raw: string): string {
	let s = raw.trim()
	// zero-width / BOM / nbsp often sneak in from Discord paste
	s = s.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
	s = s.trim()

	// <@&roleId> / <@userId> / <@!userId> / <#channelId>
	const mention = s.match(/^<@!?&?(\d{5,30})>$/)
	if (mention) return mention[1]

	// https://discord.com/channels/guildId/channelId
	const channelUrl = s.match(/discord(?:app)?\.com\/channels\/\d+\/(\d{5,30})/i)
	if (channelUrl) return channelUrl[1]

	// bare id with accidental surrounding punctuation
	const bare = s.match(/^(\d{5,30})$/)
	if (bare) return bare[1]

	// last resort: extract longest digit run if the whole string is mostly that id
	const digits = s.match(/\d{5,30}/)
	if (digits && s.replace(/\D/g, '') === digits[0]) return digits[0]

	return s
}

function parseOptionalSnowflake(
	v: unknown,
	field: string,
): { ok: true; value: string | null } | { ok: false; error: string } {
	if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
		return { ok: true, value: null }
	}
	if (typeof v !== 'string') {
		return { ok: false, error: `${field} must be a string or null` }
	}
	const id = normalizeSnowflakeInput(v)
	if (id === '') return { ok: true, value: null }
	if (!/^\d{5,30}$/.test(id)) {
		return {
			ok: false,
			error: `${field} must be a Discord snowflake ID (digits only) or empty`,
		}
	}
	return { ok: true, value: id }
}

admin.get('/settings', async (c) => {
	const db = createServiceClient(c.env)
	const { data, error } = await db.from('settings').select('*').eq('id', 1).maybeSingle()
	if (error) return c.json({ error: error.message }, 500)
	if (!data) return c.json({ error: 'Settings not found' }, 404)
	return c.json({ settings: mapAdminSettings(data as Record<string, unknown>) })
})

admin.patch('/settings', async (c) => {
	let body: {
		count_tokens?: boolean
		log_user_prompt?: boolean
		required_discord_guild_id?: string | null
		discord_invite_url?: string | null
		csam_scan_enabled?: boolean
		csam_action?: 'log' | 'log_and_block'
		discord_commands_enabled?: boolean
		discord_cmd_stats_channel_id?: string | null
		discord_cmd_stats_role_id?: string | null
		discord_cmd_stats_ephemeral?: boolean
		discord_cmd_assignrole_channel_id?: string | null
		discord_cmd_assignrole_role_id?: string | null
		discord_cmd_assignrole_target_role_id?: string | null
		discord_cmd_assignrole_excluded_role_ids?: string[] | null
		discord_cmd_assignrole_ephemeral?: boolean
		discord_cmd_rolelist_channel_id?: string | null
		discord_cmd_rolelist_role_id?: string | null
		discord_cmd_rolelist_ephemeral?: boolean
	}
	try {
		body = await c.req.json()
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400)
	}

	const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
	if (typeof body.count_tokens === 'boolean') patch.count_tokens = body.count_tokens
	if (typeof body.log_user_prompt === 'boolean') patch.log_user_prompt = body.log_user_prompt
	if (typeof body.csam_scan_enabled === 'boolean') patch.csam_scan_enabled = body.csam_scan_enabled
	if (body.csam_action !== undefined) {
		if (body.csam_action !== 'log' && body.csam_action !== 'log_and_block') {
			return c.json({ error: "csam_action must be 'log' or 'log_and_block'" }, 400)
		}
		patch.csam_action = body.csam_action
	}
	if (typeof body.discord_commands_enabled === 'boolean') {
		patch.discord_commands_enabled = body.discord_commands_enabled
	}
	if (typeof body.discord_cmd_stats_ephemeral === 'boolean') {
		patch.discord_cmd_stats_ephemeral = body.discord_cmd_stats_ephemeral
	}
	if (typeof body.discord_cmd_assignrole_ephemeral === 'boolean') {
		patch.discord_cmd_assignrole_ephemeral = body.discord_cmd_assignrole_ephemeral
	}
	if (typeof body.discord_cmd_rolelist_ephemeral === 'boolean') {
		patch.discord_cmd_rolelist_ephemeral = body.discord_cmd_rolelist_ephemeral
	}
	if ('required_discord_guild_id' in body) {
		const v = body.required_discord_guild_id
		if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
			patch.required_discord_guild_id = null
		} else if (typeof v === 'string') {
			// Discord snowflakes are numeric strings
			const id = v.trim()
			if (!/^\d{5,30}$/.test(id)) {
				return c.json(
					{ error: 'required_discord_guild_id must be a Discord server snowflake ID (digits only)' },
					400,
				)
			}
			patch.required_discord_guild_id = id
		} else {
			return c.json({ error: 'required_discord_guild_id must be a string or null' }, 400)
		}
	}
	if ('discord_invite_url' in body) {
		const v = body.discord_invite_url
		if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
			patch.discord_invite_url = null
		} else if (typeof v === 'string') {
			const url = v.trim()
			if (!/^https?:\/\//i.test(url)) {
				return c.json({ error: 'discord_invite_url must be an http(s) URL or empty' }, 400)
			}
			patch.discord_invite_url = url
		} else {
			return c.json({ error: 'discord_invite_url must be a string or null' }, 400)
		}
	}

	const snowflakeFields = [
		'discord_cmd_stats_channel_id',
		'discord_cmd_stats_role_id',
		'discord_cmd_assignrole_channel_id',
		'discord_cmd_assignrole_role_id',
		'discord_cmd_rolelist_channel_id',
		'discord_cmd_rolelist_role_id',
	] as const
	for (const field of snowflakeFields) {
		if (field in body) {
			const parsed = parseOptionalSnowflake(body[field], field)
			if (!parsed.ok) return c.json({ error: parsed.error }, 400)
			patch[field] = parsed.value
		}
	}

	if ('discord_cmd_assignrole_excluded_role_ids' in body) {
		const raw = body.discord_cmd_assignrole_excluded_role_ids
		if (raw === null || raw === undefined) {
			patch.discord_cmd_assignrole_excluded_role_ids = []
		} else if (!Array.isArray(raw)) {
			return c.json(
				{ error: 'discord_cmd_assignrole_excluded_role_ids must be an array of role UUIDs' },
				400,
			)
		} else {
			const ids = parseUuidIdList(raw)
			if (ids.length !== raw.filter((x) => x !== null && x !== undefined && String(x).trim() !== '').length) {
				// allow only valid UUIDs; reject if any non-empty entry failed
				for (const item of raw) {
					if (item === null || item === undefined) continue
					const s = String(item).trim()
					if (s === '') continue
					if (!ROLE_UUID_RE.test(s)) {
						return c.json(
							{
								error:
									'discord_cmd_assignrole_excluded_role_ids must contain only website role UUIDs',
							},
							400,
						)
					}
				}
			}
			// Validate each id exists in roles table
			const dbCheck = createServiceClient(c.env)
			for (const id of ids) {
				try {
					const role = await getRoleById(dbCheck, id)
					if (!role) {
						return c.json({ error: `Excluded role not found: ${id}` }, 400)
					}
				} catch (e) {
					return c.json(
						{ error: e instanceof Error ? e.message : 'Failed to validate excluded roles' },
						500,
					)
				}
			}
			patch.discord_cmd_assignrole_excluded_role_ids = ids
		}
	}

	if (Object.keys(patch).length <= 1) {
		return c.json({ error: 'No valid fields to update' }, 400)
	}

	const db = createServiceClient(c.env)
	const { data, error } = await db.from('settings').update(patch).eq('id', 1).select('*').single()
	if (error) return c.json({ error: error.message }, 500)
	invalidateSettingsCache()
	return c.json({ settings: mapAdminSettings(data as Record<string, unknown>) })
})

/** Register /stats, /assignrole, /rolelist (uses required_discord_guild_id). */
admin.post('/discord/register-commands', async (c) => {
	const result = await doRegisterCommands(c.env)
	if (!result.ok) {
		return c.json(
			{
				error: result.error,
				status: result.status,
				body: result.body,
			},
			result.status && result.status >= 400 && result.status < 600 ? 502 : 400,
		)
	}
	return c.json({
		ok: true,
		count: result.count,
		guild_id: result.guild_id,
		role_choices: result.role_choices,
		commands: ['stats', 'assignrole', 'rolelist'],
	})
})

export default admin

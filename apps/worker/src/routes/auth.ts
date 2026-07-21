import { Hono } from 'hono'
import {
	clearOwnerSessionCookie,
	createOwnerSessionToken,
	generateApiKey,
	ownerAuthStatus,
	setOwnerSessionCookie,
	verifyUserJwt,
} from '../lib/auth'
import { createServiceClient } from '../lib/db'
import { computeIsActive } from '../lib/discordGuild'
import { listExposedModelsWithStats } from '../lib/exposedModels'
import {
	getDailyQuotaWindow,
	getUserUsageStats,
	getWindowUsage,
	sumUserTokens,
} from '../lib/rateLimit'
import { getDefaultRole, getRoleById, getUserRoleLimits } from '../lib/roles'
import { getSettings, publicInviteFromSettings } from '../lib/settings'
import type { Env, Role } from '../types'

function userWithRole(
	row: Record<string, unknown>,
	role: Role | null,
	extras?: { discord_invite_url?: string | null },
): Record<string, unknown> {
	const isActive = Boolean(row.is_active)
	return {
		id: row.id,
		discord_id: row.discord_id,
		discord_username: row.discord_username,
		api_key: row.api_key,
		registered_at: row.registered_at,
		last_ip: row.last_ip,
		is_active: isActive,
		admin_disabled: Boolean(row.admin_disabled),
		role_id: (row.role_id as string | null) ?? role?.id ?? null,
		role: role
			? {
					id: role.id,
					name: role.name,
					requests_per_day: role.requests_per_day,
					requests_per_minute: role.requests_per_minute,
					tokens_per_day: role.tokens_per_day,
					tokens_per_minute: role.tokens_per_minute,
					is_default: role.is_default,
				}
			: null,
		// Only expose invite when disabled (reduces noise for active users)
		discord_invite_url: !isActive ? (extras?.discord_invite_url ?? null) : null,
	}
}

/** Owner login/logout/me — mounted at /api/admin (no session required for login) */
export const adminAuth = new Hono<{ Bindings: Env }>()

adminAuth.post('/login', async (c) => {
	let body: { username?: string; password?: string }
	try {
		body = await c.req.json()
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400)
	}
	const username = body.username?.trim() ?? ''
	const password = body.password ?? ''
	if (!username || !password) {
		return c.json({ error: 'Username and password required' }, 400)
	}
	// Trim secrets too — wrangler secret put can retain trailing newlines
	const expectedUser = (c.env.OWNER_LOGIN ?? '').trim()
	const expectedPass = (c.env.OWNER_PASSWORD ?? '').trim()
	if (username !== expectedUser || password.trim() !== expectedPass) {
		return c.json({ error: 'Invalid credentials' }, 401)
	}
	// Token payload must use the env login string (verify compares to OWNER_LOGIN)
	const token = await createOwnerSessionToken(c.env, expectedUser)
	// Cookie still set for same-origin (Pages reverse-proxy). Clients MUST also
	// store `token` and send it back — third-party cookies often fail in
	// incognito / Yandex / Safari.
	setOwnerSessionCookie(c, token)
	return c.json({ ok: true, token })
})

adminAuth.post('/logout', async (c) => {
	clearOwnerSessionCookie(c)
	return c.json({ ok: true })
})

adminAuth.get('/me', async (c) => {
	const status = await ownerAuthStatus(c)
	if (!status.ok) {
		return c.json(
			{
				error: 'Unauthorized',
				reason: status.reason,
				hint:
					status.reason === 'no_token'
						? 'No session. Sign in again. Frontend must send X-Owner-Session or Authorization Bearer from login token.'
						: 'Session token invalid or expired. Sign in again. If this persists, redeploy the Worker so login returns a token.',
			},
			401,
		)
	}
	return c.json({ ok: true, role: 'owner' })
})

/** User profile ensure/me — mounted at /api/user */
export const userAuth = new Hono<{ Bindings: Env }>()

userAuth.post('/ensure', async (c) => {
	const user = await verifyUserJwt(c.env, c.req.header('Authorization'))
	if (!user) return c.json({ error: 'Unauthorized' }, 401)

	const meta = user.user_metadata ?? {}
	const discordId =
		(meta.provider_id as string | undefined) ??
		(meta.sub as string | undefined) ??
		user.id
	const discordUsername =
		(meta.full_name as string | undefined) ??
		(meta.name as string | undefined) ??
		(meta.preferred_username as string | undefined) ??
		(meta.user_name as string | undefined) ??
		null

	const db = createServiceClient(c.env)
	const settings = await getSettings(db)
	const inviteUrl = publicInviteFromSettings(settings)

	let defaultRole: Role | null = null
	try {
		defaultRole = await getDefaultRole(db)
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
	}

	const { data: existing, error: selErr } = await db
		.from('app_users')
		.select('*')
		.eq('id', user.id)
		.maybeSingle()

	if (selErr) return c.json({ error: selErr.message }, 500)

	if (existing) {
		const adminDisabled = Boolean(existing.admin_disabled)
		const activeResult = await computeIsActive({
			adminDisabled,
			requiredGuildId: settings.required_discord_guild_id,
			discordUserId: discordId,
			botToken: c.env.DISCORD_BOT_TOKEN,
			previousIsActive: Boolean(existing.is_active),
		})

		const patch: Record<string, unknown> = {
			discord_username: discordUsername ?? existing.discord_username,
			discord_id: discordId,
			is_active: activeResult.is_active,
			// Never clear admin_disabled here
		}
		// Heal legacy rows missing role_id after migration
		if (!existing.role_id && defaultRole) {
			patch.role_id = defaultRole.id
		}
		const { data: updated, error: upErr } = await db
			.from('app_users')
			.update(patch)
			.eq('id', user.id)
			.select('*')
			.single()
		if (upErr) return c.json({ error: upErr.message }, 500)
		let role: Role | null = null
		try {
			role = updated.role_id
				? await getRoleById(db, updated.role_id as string)
				: defaultRole
		} catch {
			role = defaultRole
		}
		return c.json({
			user: userWithRole(updated as Record<string, unknown>, role, {
				discord_invite_url: inviteUrl,
			}),
		})
	}

	// New user: default not admin-disabled; compute is_active from guild gate
	const activeResult = await computeIsActive({
		adminDisabled: false,
		requiredGuildId: settings.required_discord_guild_id,
		discordUserId: discordId,
		botToken: c.env.DISCORD_BOT_TOKEN,
		// Fail-open on API errors for brand-new users too (avoid lockout if Discord is down)
		previousIsActive: true,
	})

	const apiKey = generateApiKey()
	const { data: created, error: insErr } = await db
		.from('app_users')
		.insert({
			id: user.id,
			discord_id: discordId,
			discord_username: discordUsername,
			api_key: apiKey,
			role_id: defaultRole?.id ?? null,
			admin_disabled: false,
			is_active: activeResult.is_active,
		})
		.select('*')
		.single()

	if (insErr) return c.json({ error: insErr.message }, 500)
	return c.json({
		user: userWithRole(created as Record<string, unknown>, defaultRole, {
			discord_invite_url: inviteUrl,
		}),
	})
})

userAuth.get('/me', async (c) => {
	const user = await verifyUserJwt(c.env, c.req.header('Authorization'))
	if (!user) return c.json({ error: 'Unauthorized' }, 401)

	const db = createServiceClient(c.env)
	const settings = await getSettings(db)
	const inviteUrl = publicInviteFromSettings(settings)

	const { data, error } = await db.from('app_users').select('*').eq('id', user.id).maybeSingle()
	if (error) return c.json({ error: error.message }, 500)
	if (!data) return c.json({ error: 'Profile not found. Call POST /api/user/ensure first.' }, 404)

	let role: Role | null = null
	try {
		if (data.role_id) role = await getRoleById(db, data.role_id as string)
		if (!role) role = await getDefaultRole(db)
	} catch (e) {
		return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
	}
	return c.json({
		user: userWithRole(data as Record<string, unknown>, role, {
			discord_invite_url: inviteUrl,
		}),
	})
})

/**
 * Exposed models with channel-namespaced public ids + success stats.
 * Filtered by the user's role (restricted channels hidden).
 */
userAuth.get('/models', async (c) => {
	const user = await verifyUserJwt(c.env, c.req.header('Authorization'))
	if (!user) return c.json({ error: 'Unauthorized' }, 401)

	const db = createServiceClient(c.env)
	const { data: profile, error: pErr } = await db
		.from('app_users')
		.select('role_id')
		.eq('id', user.id)
		.maybeSingle()
	if (pErr) return c.json({ error: pErr.message }, 500)
	if (!profile) return c.json({ error: 'Profile not found. Call POST /api/user/ensure first.' }, 404)

	const { models, error } = await listExposedModelsWithStats(db, {
		filterByRole: true,
		roleId: (profile.role_id as string | null) ?? null,
	})
	if (error) return c.json({ error }, 500)
	return c.json({ models })
})

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

/**
 * RPM/RPD usage for the signed-in user (limits from their role).
 * Only successful requests count toward limits; errors are reported separately.
 */
userAuth.get('/usage', async (c) => {
	const user = await verifyUserJwt(c.env, c.req.header('Authorization'))
	if (!user) return c.json({ error: 'Unauthorized' }, 401)

	const db = createServiceClient(c.env)
	const { data: profile, error: pErr } = await db
		.from('app_users')
		.select('role_id')
		.eq('id', user.id)
		.maybeSingle()
	if (pErr) return c.json({ error: pErr.message }, 500)
	if (!profile) return c.json({ error: 'Profile not found. Call POST /api/user/ensure first.' }, 404)

	let limits: {
		requests_per_minute: number | null
		requests_per_day: number | null
		tokens_per_minute: number | null
		tokens_per_day: number | null
	}
	let role: Role | null = null
	try {
		const resolved = await getUserRoleLimits(db, profile.role_id as string | null)
		limits = resolved.limits
		role = resolved.role
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
			getWindowUsage(db, user.id, minuteSince, false),
			getWindowUsage(db, user.id, dayWindow.sinceIso, true),
			sumUserTokens(db, user.id, minuteSince, false),
			sumUserTokens(db, user.id, dayWindow.sinceIso, true),
			getUserUsageStats(db, user.id, dayWindow.sinceIso),
		])
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e)
		return c.json({ error: msg }, 500)
	}

	const tokenBucket = (used: number, limit: number | null) => usageBucket(used, 0, limit)

	return c.json({
		limits: {
			requests_per_minute: limits.requests_per_minute,
			requests_per_day: limits.requests_per_day,
			tokens_per_minute: limits.tokens_per_minute,
			tokens_per_day: limits.tokens_per_day,
		},
		role: role
			? {
					id: role.id,
					name: role.name,
				}
			: null,
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

/**
 * Rotate only this user's API key. Never deletes the user row.
 */
userAuth.post('/rotate-key', async (c) => {
	const user = await verifyUserJwt(c.env, c.req.header('Authorization'))
	if (!user) return c.json({ error: 'Unauthorized' }, 401)

	const db = createServiceClient(c.env)
	const { data: existing, error: selErr } = await db
		.from('app_users')
		.select('id')
		.eq('id', user.id)
		.maybeSingle()
	if (selErr) return c.json({ error: selErr.message }, 500)
	if (!existing) {
		return c.json({ error: 'Profile not found. Call POST /api/user/ensure first.' }, 404)
	}

	// Retry once on rare unique api_key collision
	let lastError: string | null = null
	for (let attempt = 0; attempt < 2; attempt++) {
		const apiKey = generateApiKey()
		const { data: updated, error: upErr } = await db
			.from('app_users')
			.update({ api_key: apiKey })
			.eq('id', user.id)
			.select('*')
			.single()
		if (!upErr && updated) {
			let role: Role | null = null
			try {
				if (updated.role_id) role = await getRoleById(db, updated.role_id as string)
				if (!role) role = await getDefaultRole(db)
			} catch {
				/* ignore */
			}
			return c.json({ user: userWithRole(updated as Record<string, unknown>, role) })
		}
		lastError = upErr?.message ?? 'Update failed'
		// unique_violation → retry; anything else bail
		if (upErr && !/duplicate|unique/i.test(upErr.message)) {
			return c.json({ error: upErr.message }, 500)
		}
	}
	return c.json({ error: lastError ?? 'Failed to rotate key' }, 500)
})

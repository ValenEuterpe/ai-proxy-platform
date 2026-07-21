import type { SupabaseClient } from '@supabase/supabase-js'
import {
	getDailyQuotaWindow,
	getUserUsageStats,
	getWindowUsage,
	sumUserTokens,
} from './rateLimit'
import { getRoleById, getUserRoleLimits, listRoles } from './roles'
import type { Settings } from './settings'

export type InteractionMember = {
	roles?: string[]
	user?: { id: string; username?: string; global_name?: string | null }
}

export type InteractionUser = {
	id: string
	username?: string
	global_name?: string | null
}

export type InteractionData = {
	name: string
	options?: {
		type: number
		name: string
		value?: string | number | boolean
		options?: InteractionData['options']
	}[]
	resolved?: {
		users?: Record<string, InteractionUser>
		members?: Record<string, { roles?: string[]; nick?: string | null }>
	}
}

export type DiscordInteraction = {
	type: number
	guild_id?: string
	channel_id?: string
	member?: InteractionMember
	user?: InteractionUser
	data?: InteractionData
}

const FLAG_EPHEMERAL = 64

export type CommandKind = 'stats' | 'assignrole' | 'rolelist'

export function messageResponse(content: string, ephemeral: boolean) {
	return {
		type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
		data: {
			content,
			flags: ephemeral ? FLAG_EPHEMERAL : 0,
		},
	}
}

function snowflakeOk(id: string | null | undefined): id is string {
	return typeof id === 'string' && /^\d{5,30}$/.test(id.trim())
}

/** Channel + Discord-role gates for a command. Returns error message or null if ok. */
export function checkCommandGates(
	settings: Settings,
	kind: CommandKind,
	channelId: string | undefined,
	memberRoles: string[] | undefined,
): string | null {
	let channelGate: string | null = null
	let roleGate: string | null = null
	if (kind === 'stats') {
		channelGate = settings.discord_cmd_stats_channel_id
		roleGate = settings.discord_cmd_stats_role_id
	} else if (kind === 'assignrole') {
		channelGate = settings.discord_cmd_assignrole_channel_id
		roleGate = settings.discord_cmd_assignrole_role_id
	} else {
		channelGate = settings.discord_cmd_rolelist_channel_id
		roleGate = settings.discord_cmd_rolelist_role_id
	}

	if (snowflakeOk(channelGate)) {
		if (!channelId || channelId !== channelGate.trim()) {
			return 'This command cannot be run in this channel.'
		}
	}

	if (snowflakeOk(roleGate)) {
		const roles = memberRoles ?? []
		if (!roles.includes(roleGate.trim())) {
			return 'Your role does not have permission to run this command.'
		}
	}

	return null
}

function invokerUserId(interaction: DiscordInteraction): string | null {
	return interaction.member?.user?.id ?? interaction.user?.id ?? null
}

function optionUserId(data: InteractionData | undefined, name: string): string | null {
	const opt = data?.options?.find((o) => o.name === name)
	if (!opt || opt.value === undefined || opt.value === null) return null
	const v = String(opt.value).trim()
	return snowflakeOk(v) ? v : null
}

function optionString(data: InteractionData | undefined, name: string): string | null {
	const opt = data?.options?.find((o) => o.name === name)
	if (!opt || opt.value === undefined || opt.value === null) return null
	const v = String(opt.value).trim()
	return v === '' ? null : v
}

function resolveUserLabel(data: InteractionData | undefined, userId: string): string {
	const u = data?.resolved?.users?.[userId]
	if (u?.global_name) return u.global_name
	if (u?.username) return u.username
	return `<@${userId}>`
}

function fmtLimit(used: number, limit: number | null): string {
	if (limit == null) return `${used} / ∞`
	return `${used} / ${limit}`
}

function fmtCap(limit: number | null): string {
	return limit == null ? '∞' : String(limit)
}

async function formatUserStats(
	db: SupabaseClient,
	appUser: {
		id: string
		discord_username: string | null
		discord_id: string
		is_active: boolean
		role_id?: string | null
	},
	label: string,
): Promise<string> {
	const { limits, role } = await getUserRoleLimits(db, appUser.role_id ?? null)
	const now = Date.now()
	const minuteSince = new Date(now - 60_000).toISOString()
	const dayWindow = getDailyQuotaWindow(now)

	const [minute, day, tokensMinute, tokensDay, stats] = await Promise.all([
		getWindowUsage(db, appUser.id, minuteSince, false),
		getWindowUsage(db, appUser.id, dayWindow.sinceIso, true),
		sumUserTokens(db, appUser.id, minuteSince, false),
		sumUserTokens(db, appUser.id, dayWindow.sinceIso, true),
		getUserUsageStats(db, appUser.id, dayWindow.sinceIso),
	])

	const roleName = role?.name ?? '—'
	const status = appUser.is_active ? 'active' : 'disabled'
	const lines = [
		`**Stats for ${label}**`,
		`Discord: \`${appUser.discord_username ?? appUser.discord_id}\` · Account: **${status}** · Role: **${roleName}**`,
		'',
		`**Requests (today):** ${fmtLimit(day.success, limits.requests_per_day)} success · ${day.errors} errors`,
		`**Requests (last min):** ${fmtLimit(minute.success, limits.requests_per_minute)} success · ${minute.errors} errors`,
		`**Tokens (today):** ${fmtLimit(tokensDay, limits.tokens_per_day)}`,
		`**Tokens (last min):** ${fmtLimit(tokensMinute, limits.tokens_per_minute)}`,
		`**All-time:** ${stats.calls_all_time.success} success · ${stats.calls_all_time.errors} errors · ${stats.tokens_all_time} tokens`,
	]

	if (stats.top_models.length > 0) {
		const top = stats.top_models
			.slice(0, 3)
			.map((m) => `\`${m.model_id}\` (${m.requests})`)
			.join(', ')
		lines.push(`**Top models:** ${top}`)
	}

	return lines.join('\n')
}

export async function handleStatsCommand(
	db: SupabaseClient,
	settings: Settings,
	interaction: DiscordInteraction,
): Promise<ReturnType<typeof messageResponse>> {
	const ephemeral = settings.discord_cmd_stats_ephemeral
	const gate = checkCommandGates(
		settings,
		'stats',
		interaction.channel_id,
		interaction.member?.roles,
	)
	if (gate) return messageResponse(gate, true)

	const targetId = optionUserId(interaction.data, 'user') ?? invokerUserId(interaction)
	if (!targetId) {
		return messageResponse('Could not determine the Discord user.', true)
	}

	const label = resolveUserLabel(interaction.data, targetId)

	const { data: appUser, error } = await db
		.from('app_users')
		.select('id, discord_id, discord_username, is_active, role_id')
		.eq('discord_id', targetId)
		.maybeSingle()

	if (error) {
		console.error('stats discord lookup', error)
		return messageResponse('Failed to look up user. Try again later.', true)
	}

	if (!appUser) {
		const self = invokerUserId(interaction) === targetId
		return messageResponse(
			self
				? 'You are not registered on the website. Log in with Discord on the dashboard first.'
				: `**${label}** is not registered on the website.`,
			ephemeral,
		)
	}

	try {
		const text = await formatUserStats(
			db,
			appUser as {
				id: string
				discord_username: string | null
				discord_id: string
				is_active: boolean
				role_id?: string | null
			},
			label,
		)
		return messageResponse(text, ephemeral)
	} catch (e) {
		console.error('stats format', e)
		return messageResponse('Failed to load stats. Try again later.', true)
	}
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * /assignrole — sets website app_users.role_id from the `role` option (always overrides).
 */
export async function handleAssignRoleCommand(
	db: SupabaseClient,
	settings: Settings,
	interaction: DiscordInteraction,
): Promise<ReturnType<typeof messageResponse>> {
	const ephemeral = settings.discord_cmd_assignrole_ephemeral
	const gate = checkCommandGates(
		settings,
		'assignrole',
		interaction.channel_id,
		interaction.member?.roles,
	)
	if (gate) return messageResponse(gate, true)

	if (!interaction.guild_id?.trim()) {
		return messageResponse('This command can only be used in a server.', true)
	}

	const roleArg = optionString(interaction.data, 'role')
	if (!roleArg || !UUID_RE.test(roleArg)) {
		return messageResponse(
			'Pick a website role from the `role` option. If the list is empty, open Admin → Settings → Register slash commands after creating roles.',
			true,
		)
	}

	let targetRole: Awaited<ReturnType<typeof getRoleById>>
	try {
		targetRole = await getRoleById(db, roleArg)
	} catch (e) {
		console.error('assignrole getRoleById', e)
		return messageResponse('Failed to load website role. Try again later.', true)
	}
	if (!targetRole) {
		return messageResponse(
			'That website role no longer exists. Re-register slash commands after updating roles.',
			true,
		)
	}

	const excluded = settings.discord_cmd_assignrole_excluded_role_ids ?? []
	if (excluded.includes(targetRole.id)) {
		return messageResponse(
			`Website role **${targetRole.name}** is excluded from /assignrole. Pick another role.`,
			true,
		)
	}

	const ids: string[] = []
	for (const name of ['user1', 'user2', 'user3', 'user4', 'user5'] as const) {
		const id = optionUserId(interaction.data, name)
		if (id && !ids.includes(id)) ids.push(id)
	}
	if (ids.length === 0) {
		return messageResponse('Provide at least one user (`user1`).', true)
	}

	const lines: string[] = []
	for (const discordUserId of ids) {
		const label = resolveUserLabel(interaction.data, discordUserId)
		const { data: appUser, error: lookErr } = await db
			.from('app_users')
			.select('id, role_id, discord_username')
			.eq('discord_id', discordUserId)
			.maybeSingle()

		if (lookErr) {
			console.error('assignrole lookup', lookErr)
			lines.push(`❌ ${label} — lookup failed`)
			continue
		}
		if (!appUser) {
			lines.push(
				`❌ ${label} — not registered on the website (they must log in with Discord first)`,
			)
			continue
		}

		const prevRoleId = (appUser.role_id as string | null) ?? null
		let prevName: string | null = null
		if (prevRoleId && prevRoleId !== targetRole.id) {
			try {
				const prev = await getRoleById(db, prevRoleId)
				prevName = prev?.name ?? null
			} catch {
				prevName = null
			}
		}

		// Always write role_id so re-running the command overrides (or re-applies) the role.
		const { error: updErr } = await db
			.from('app_users')
			.update({ role_id: targetRole.id })
			.eq('id', appUser.id)

		if (updErr) {
			console.error('assignrole update', updErr)
			lines.push(`❌ ${label} — failed to update role`)
			continue
		}

		if (prevRoleId === targetRole.id) {
			lines.push(`✅ ${label} — website role set to **${targetRole.name}** (unchanged)`)
		} else if (prevName) {
			lines.push(
				`✅ ${label} — website role **${prevName}** → **${targetRole.name}**`,
			)
		} else {
			lines.push(`✅ ${label} — website role set to **${targetRole.name}**`)
		}
	}

	return messageResponse(lines.join('\n'), ephemeral)
}

/**
 * /rolelist — list website roles with RPM / RPD / TPM / TPD.
 */
export async function handleRoleListCommand(
	db: SupabaseClient,
	settings: Settings,
	interaction: DiscordInteraction,
): Promise<ReturnType<typeof messageResponse>> {
	const ephemeral = settings.discord_cmd_rolelist_ephemeral
	const gate = checkCommandGates(
		settings,
		'rolelist',
		interaction.channel_id,
		interaction.member?.roles,
	)
	if (gate) return messageResponse(gate, true)

	try {
		const roles = await listRoles(db)
		if (roles.length === 0) {
			return messageResponse('No website roles configured yet.', ephemeral)
		}

		const lines = [
			'**Website proxy roles**',
			'`RPM` requests/min · `RPD` requests/day · `TPM` tokens/min · `TPD` tokens/day',
			'',
		]

		for (const r of roles) {
			const def = r.is_default ? ' · *default*' : ''
			lines.push(
				`**${r.name}**${def}`,
				`RPM \`${fmtCap(r.requests_per_minute)}\` · RPD \`${fmtCap(r.requests_per_day)}\` · TPM \`${fmtCap(r.tokens_per_minute)}\` · TPD \`${fmtCap(r.tokens_per_day)}\``,
			)
		}

		const text = lines.join('\n')
		// Discord message limit 2000
		if (text.length > 1900) {
			return messageResponse(text.slice(0, 1900) + '\n…', ephemeral)
		}
		return messageResponse(text, ephemeral)
	} catch (e) {
		console.error('rolelist', e)
		return messageResponse('Failed to load roles. Try again later.', true)
	}
}

import type { SupabaseClient } from '@supabase/supabase-js'
import { addGuildMemberRole } from './discordApi'
import {
	getDailyQuotaWindow,
	getUserUsageStats,
	getWindowUsage,
	sumUserTokens,
} from './rateLimit'
import { getUserRoleLimits } from './roles'
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

/** Channel + role gates for a command. Returns error message or null if ok. */
export function checkCommandGates(
	settings: Settings,
	kind: 'stats' | 'assignrole',
	channelId: string | undefined,
	memberRoles: string[] | undefined,
): string | null {
	const channelGate =
		kind === 'stats'
			? settings.discord_cmd_stats_channel_id
			: settings.discord_cmd_assignrole_channel_id
	const roleGate =
		kind === 'stats' ? settings.discord_cmd_stats_role_id : settings.discord_cmd_assignrole_role_id

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

function resolveUserLabel(
	data: InteractionData | undefined,
	userId: string,
): string {
	const u = data?.resolved?.users?.[userId]
	if (u?.global_name) return u.global_name
	if (u?.username) return u.username
	return `<@${userId}>`
}

function fmtLimit(used: number, limit: number | null): string {
	if (limit == null) return `${used} / ∞`
	return `${used} / ${limit}`
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

	const targetId =
		optionUserId(interaction.data, 'user') ?? invokerUserId(interaction)
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

export async function handleAssignRoleCommand(
	botToken: string | undefined,
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

	const guildId = interaction.guild_id?.trim()
	if (!guildId) {
		return messageResponse('This command can only be used in a server.', true)
	}

	const targetRole = settings.discord_cmd_assignrole_target_role_id?.trim() || null
	if (!snowflakeOk(targetRole)) {
		return messageResponse(
			'Target role is not configured. Set it in Admin → Settings → Discord Commands.',
			true,
		)
	}

	const token = botToken?.trim()
	if (!token) {
		return messageResponse('Bot token is not configured on the worker.', true)
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
	for (const userId of ids) {
		const label = resolveUserLabel(interaction.data, userId)
		const result = await addGuildMemberRole(token, guildId, userId, targetRole)
		if (result.ok) {
			lines.push(`✅ ${label} — role assigned`)
		} else {
			lines.push(`❌ ${label} — failed (${result.status}): ${result.message}`)
		}
	}

	return messageResponse(lines.join('\n'), ephemeral)
}

import type { SupabaseClient } from '@supabase/supabase-js'

export type CsamAction = 'log' | 'log_and_block'

export type Settings = {
	count_tokens: boolean
	log_user_prompt: boolean
	/** Rate limit columns kept in DB for history; enforcement uses roles. */
	requests_per_day: number | null
	requests_per_minute: number | null
	/** Empty/null = Discord server gate off */
	required_discord_guild_id: string | null
	/** Optional invite shown when account is disabled */
	discord_invite_url: string | null
	/** Master on/off for CSAM content scan (request path). */
	csam_scan_enabled: boolean
	/** On hit: log only, or log + HTTP 400 before upstream. */
	csam_action: CsamAction
	/** Master on/off for Discord slash commands. */
	discord_commands_enabled: boolean
	discord_cmd_stats_channel_id: string | null
	discord_cmd_stats_role_id: string | null
	discord_cmd_stats_ephemeral: boolean
	discord_cmd_assignrole_channel_id: string | null
	discord_cmd_assignrole_role_id: string | null
	/** Role the bot assigns when /assignrole succeeds. */
	discord_cmd_assignrole_target_role_id: string | null
	discord_cmd_assignrole_ephemeral: boolean
}

type CacheEntry = { value: Settings; expiresAt: number }

let cache: CacheEntry | null = null
const TTL_MS = 30_000

const defaults: Settings = {
	count_tokens: false,
	log_user_prompt: false,
	requests_per_day: null,
	requests_per_minute: null,
	required_discord_guild_id: null,
	discord_invite_url: null,
	csam_scan_enabled: true,
	csam_action: 'log',
	discord_commands_enabled: false,
	discord_cmd_stats_channel_id: null,
	discord_cmd_stats_role_id: null,
	discord_cmd_stats_ephemeral: true,
	discord_cmd_assignrole_channel_id: null,
	discord_cmd_assignrole_role_id: null,
	discord_cmd_assignrole_target_role_id: null,
	discord_cmd_assignrole_ephemeral: true,
}

function parseCsamAction(v: unknown): CsamAction {
	return v === 'log_and_block' ? 'log_and_block' : 'log'
}

function emptyToNull(v: unknown): string | null {
	if (v === null || v === undefined) return null
	const s = String(v).trim()
	return s === '' ? null : s
}

export async function getSettings(db: SupabaseClient): Promise<Settings> {
	const now = Date.now()
	if (cache && cache.expiresAt > now) return cache.value

	const { data, error } = await db.from('settings').select('*').eq('id', 1).maybeSingle()
	if (error || !data) {
		return cache?.value ?? defaults
	}

	const value: Settings = {
		count_tokens: Boolean(data.count_tokens),
		log_user_prompt: Boolean(data.log_user_prompt),
		requests_per_day: data.requests_per_day ?? null,
		requests_per_minute: data.requests_per_minute ?? null,
		required_discord_guild_id: emptyToNull(data.required_discord_guild_id),
		discord_invite_url: emptyToNull(data.discord_invite_url),
		// Default true if column missing (pre-migration)
		csam_scan_enabled:
			data.csam_scan_enabled === undefined || data.csam_scan_enabled === null
				? true
				: Boolean(data.csam_scan_enabled),
		csam_action: parseCsamAction(data.csam_action),
		discord_commands_enabled: Boolean(data.discord_commands_enabled),
		discord_cmd_stats_channel_id: emptyToNull(data.discord_cmd_stats_channel_id),
		discord_cmd_stats_role_id: emptyToNull(data.discord_cmd_stats_role_id),
		discord_cmd_stats_ephemeral:
			data.discord_cmd_stats_ephemeral === undefined || data.discord_cmd_stats_ephemeral === null
				? true
				: Boolean(data.discord_cmd_stats_ephemeral),
		discord_cmd_assignrole_channel_id: emptyToNull(data.discord_cmd_assignrole_channel_id),
		discord_cmd_assignrole_role_id: emptyToNull(data.discord_cmd_assignrole_role_id),
		discord_cmd_assignrole_target_role_id: emptyToNull(
			data.discord_cmd_assignrole_target_role_id,
		),
		discord_cmd_assignrole_ephemeral:
			data.discord_cmd_assignrole_ephemeral === undefined ||
			data.discord_cmd_assignrole_ephemeral === null
				? true
				: Boolean(data.discord_cmd_assignrole_ephemeral),
	}
	cache = { value, expiresAt: now + TTL_MS }
	return value
}

export function invalidateSettingsCache(): void {
	cache = null
}

/** Public-safe slice returned with user profile for disabled UI. */
export function publicInviteFromSettings(settings: Settings): string | null {
	return settings.discord_invite_url
}

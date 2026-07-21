/**
 * Discord guild membership check via bot token.
 * Requires the bot to be in the guild with Server Members Intent enabled.
 */

export type GuildMembershipResult =
	| { status: 'member' }
	| { status: 'not_member' }
	| { status: 'error'; message: string }

/**
 * GET /guilds/{guild.id}/members/{user.id}
 * 200 → member, 404 → not in server, other → error (caller should fail open for existing users).
 */
export async function checkGuildMembership(
	botToken: string,
	guildId: string,
	discordUserId: string,
): Promise<GuildMembershipResult> {
	const token = botToken.trim()
	const guild = guildId.trim()
	const userId = discordUserId.trim()
	if (!token || !guild || !userId) {
		return { status: 'error', message: 'Missing bot token, guild id, or discord user id' }
	}

	const url = `https://discord.com/api/v10/guilds/${encodeURIComponent(guild)}/members/${encodeURIComponent(userId)}`
	try {
		const res = await fetch(url, {
			method: 'GET',
			headers: {
				Authorization: `Bot ${token}`,
				'Content-Type': 'application/json',
			},
		})
		if (res.status === 200) return { status: 'member' }
		if (res.status === 404) return { status: 'not_member' }
		const body = await res.text().catch(() => '')
		return {
			status: 'error',
			message: `Discord API ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
		}
	} catch (e) {
		return {
			status: 'error',
			message: e instanceof Error ? e.message : String(e),
		}
	}
}

export type ComputeActiveOpts = {
	adminDisabled: boolean
	/** null/empty = gate off */
	requiredGuildId: string | null | undefined
	discordUserId: string
	botToken: string | null | undefined
	/**
	 * Previous is_active for fail-open on API errors (existing users).
	 * For brand-new users pass true so fail-open leaves them active.
	 */
	previousIsActive: boolean
}

/**
 * Resolve is_active:
 * - admin_disabled → always false
 * - gate off → true
 * - member → true
 * - not member → false
 * - API/config error → fail open (keep previousIsActive)
 */
export async function computeIsActive(opts: ComputeActiveOpts): Promise<{
	is_active: boolean
	/** Why inactive when is_active is false; null when active */
	disable_source: 'admin' | 'guild' | null
	guild_check?: GuildMembershipResult
}> {
	if (opts.adminDisabled) {
		return { is_active: false, disable_source: 'admin' }
	}

	const guildId = opts.requiredGuildId?.trim() || null
	if (!guildId) {
		return { is_active: true, disable_source: null }
	}

	const botToken = opts.botToken?.trim() || null
	if (!botToken) {
		console.warn(
			'required_discord_guild_id is set but DISCORD_BOT_TOKEN is missing — fail open (not mass-disabling)',
		)
		return {
			is_active: opts.previousIsActive,
			disable_source: opts.previousIsActive ? null : 'guild',
			guild_check: { status: 'error', message: 'DISCORD_BOT_TOKEN not configured' },
		}
	}

	const result = await checkGuildMembership(botToken, guildId, opts.discordUserId)
	if (result.status === 'member') {
		return { is_active: true, disable_source: null, guild_check: result }
	}
	if (result.status === 'not_member') {
		return { is_active: false, disable_source: 'guild', guild_check: result }
	}

	// Fail open on API errors
	console.warn('Discord guild membership check failed (fail open):', result.message)
	return {
		is_active: opts.previousIsActive,
		disable_source: opts.previousIsActive ? null : 'guild',
		guild_check: result,
	}
}

/**
 * Discord REST helpers for slash-command registration and role assignment.
 */

const API = 'https://discord.com/api/v10'

export type DiscordCommandDef = {
	name: string
	description: string
	options?: {
		type: number
		name: string
		description: string
		required?: boolean
	}[]
}

/** Slash command option type USER */
export const OPT_USER = 6

export function defaultCommandDefinitions(): DiscordCommandDef[] {
	return [
		{
			name: 'stats',
			description: 'Show proxy usage stats for you or another Discord user',
			options: [
				{
					type: OPT_USER,
					name: 'user',
					description: 'User to look up (defaults to you)',
					required: false,
				},
			],
		},
		{
			name: 'assignrole',
			description: 'Assign the configured website proxy role to up to 5 registered users',
			options: [
				{ type: OPT_USER, name: 'user1', description: 'First user', required: true },
				{ type: OPT_USER, name: 'user2', description: 'Second user', required: false },
				{ type: OPT_USER, name: 'user3', description: 'Third user', required: false },
				{ type: OPT_USER, name: 'user4', description: 'Fourth user', required: false },
				{ type: OPT_USER, name: 'user5', description: 'Fifth user', required: false },
			],
		},
	]
}

export async function registerGuildCommands(
	botToken: string,
	applicationId: string,
	guildId: string,
	commands: DiscordCommandDef[] = defaultCommandDefinitions(),
): Promise<{ ok: true; count: number } | { ok: false; status: number; body: string }> {
	const url = `${API}/applications/${encodeURIComponent(applicationId)}/guilds/${encodeURIComponent(guildId)}/commands`
	const res = await fetch(url, {
		method: 'PUT',
		headers: {
			Authorization: `Bot ${botToken.trim()}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(commands),
	})
	const body = await res.text().catch(() => '')
	if (!res.ok) {
		return { ok: false, status: res.status, body: body.slice(0, 500) }
	}
	let count = commands.length
	try {
		const parsed = JSON.parse(body) as unknown
		if (Array.isArray(parsed)) count = parsed.length
	} catch {
		/* ignore */
	}
	return { ok: true, count }
}

/**
 * PUT /guilds/{guild.id}/members/{user.id}/roles/{role.id}
 * 204 = success; 204 also when already has role in practice Discord returns 204.
 */
export async function addGuildMemberRole(
	botToken: string,
	guildId: string,
	userId: string,
	roleId: string,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
	const url = `${API}/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`
	try {
		const res = await fetch(url, {
			method: 'PUT',
			headers: {
				Authorization: `Bot ${botToken.trim()}`,
				'Content-Type': 'application/json',
				'X-Audit-Log-Reason': 'assignrole slash command',
			},
		})
		if (res.status === 204 || res.status === 200) return { ok: true }
		const body = await res.text().catch(() => '')
		return {
			ok: false,
			status: res.status,
			message: body.slice(0, 300) || `HTTP ${res.status}`,
		}
	} catch (e) {
		return {
			ok: false,
			status: 0,
			message: e instanceof Error ? e.message : String(e),
		}
	}
}

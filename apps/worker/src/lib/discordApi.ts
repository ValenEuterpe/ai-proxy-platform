/**
 * Discord REST helpers for slash-command registration.
 */

const API = 'https://discord.com/api/v10'

export type DiscordCommandChoice = {
	name: string
	value: string
}

export type DiscordCommandOption = {
	type: number
	name: string
	description: string
	required?: boolean
	choices?: DiscordCommandChoice[]
}

export type DiscordCommandDef = {
	name: string
	description: string
	options?: DiscordCommandOption[]
}

/** Slash command option types */
export const OPT_STRING = 3
export const OPT_USER = 6

/** Discord allows max 25 choices per option. */
const MAX_CHOICES = 25

export type RoleChoiceSource = { id: string; name: string }

/**
 * Build guild command definitions.
 * `websiteRoles` populates /assignrole `role` choices (value = roles.id UUID).
 */
export function buildCommandDefinitions(
	websiteRoles: RoleChoiceSource[] = [],
): DiscordCommandDef[] {
	const choices: DiscordCommandChoice[] = websiteRoles.slice(0, MAX_CHOICES).map((r) => ({
		name: r.name.slice(0, 100) || r.id.slice(0, 100),
		value: r.id,
	}))

	const assignOptions: DiscordCommandOption[] = [
		{
			type: OPT_STRING,
			name: 'role',
			description: 'Website proxy role to assign (from Admin → Roles)',
			required: true,
			...(choices.length > 0 ? { choices } : {}),
		},
		{ type: OPT_USER, name: 'user1', description: 'First user', required: true },
		{ type: OPT_USER, name: 'user2', description: 'Second user', required: false },
		{ type: OPT_USER, name: 'user3', description: 'Third user', required: false },
		{ type: OPT_USER, name: 'user4', description: 'Fourth user', required: false },
		{ type: OPT_USER, name: 'user5', description: 'Fifth user', required: false },
	]

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
			description: 'Assign a website proxy role to up to 5 registered users (overrides previous)',
			options: assignOptions,
		},
		{
			name: 'rolelist',
			description: 'List website proxy roles and their RPM / RPD / TPM / TPD limits',
		},
	]
}

export async function registerGuildCommands(
	botToken: string,
	applicationId: string,
	guildId: string,
	commands: DiscordCommandDef[],
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

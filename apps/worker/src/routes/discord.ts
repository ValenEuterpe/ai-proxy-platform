import { Hono } from 'hono'
import { createServiceClient } from '../lib/db'
import { registerGuildCommands } from '../lib/discordApi'
import {
	handleAssignRoleCommand,
	handleStatsCommand,
	messageResponse,
	type DiscordInteraction,
} from '../lib/discordCommands'
import { verifyDiscordInteraction } from '../lib/discordCrypto'
import { getSettings } from '../lib/settings'
import type { Env } from '../types'

const discord = new Hono<{ Bindings: Env }>()

/**
 * Discord Interactions endpoint (public).
 * Must verify Ed25519 signature on every request.
 * POST /api/discord/interactions
 */
discord.post('/interactions', async (c) => {
	const publicKey = c.env.DISCORD_PUBLIC_KEY?.trim()
	if (!publicKey) {
		console.error('DISCORD_PUBLIC_KEY not configured')
		return c.text('Discord interactions not configured', 503)
	}

	const signature = c.req.header('X-Signature-Ed25519') ?? ''
	const timestamp = c.req.header('X-Signature-Timestamp') ?? ''
	const rawBody = await c.req.text()

	const valid = await verifyDiscordInteraction(publicKey, signature, timestamp, rawBody)
	if (!valid) {
		return c.text('invalid request signature', 401)
	}

	let interaction: DiscordInteraction
	try {
		interaction = JSON.parse(rawBody) as DiscordInteraction
	} catch {
		return c.json({ error: 'Invalid JSON' }, 400)
	}

	// PING
	if (interaction.type === 1) {
		return c.json({ type: 1 })
	}

	// APPLICATION_COMMAND
	if (interaction.type === 2) {
		const db = createServiceClient(c.env)
		const settings = await getSettings(db)

		if (!settings.discord_commands_enabled) {
			return c.json(messageResponse('Discord commands are disabled.', true))
		}

		const name = interaction.data?.name
		if (name === 'stats') {
			const res = await handleStatsCommand(db, settings, interaction)
			return c.json(res)
		}
		if (name === 'assignrole') {
			const res = await handleAssignRoleCommand(
				c.env.DISCORD_BOT_TOKEN,
				settings,
				interaction,
			)
			return c.json(res)
		}

		return c.json(messageResponse(`Unknown command: ${name ?? '?'}`, true))
	}

	return c.json({ error: 'Unsupported interaction type' }, 400)
})

/**
 * Admin-only registration is mounted from admin.ts.
 * Export helper for admin route to call.
 */
export async function doRegisterCommands(env: Env): Promise<
	| { ok: true; count: number; guild_id: string }
	| { ok: false; error: string; status?: number; body?: string }
> {
	const token = env.DISCORD_BOT_TOKEN?.trim()
	const appId = env.DISCORD_APPLICATION_ID?.trim()
	if (!token) return { ok: false, error: 'DISCORD_BOT_TOKEN is not configured' }
	if (!appId) return { ok: false, error: 'DISCORD_APPLICATION_ID is not configured' }

	const db = createServiceClient(env)
	const settings = await getSettings(db)
	const guildId = settings.required_discord_guild_id?.trim()
	if (!guildId) {
		return {
			ok: false,
			error:
				'Set Required Discord server ID in Settings (used as the guild for command registration).',
		}
	}

	const result = await registerGuildCommands(token, appId, guildId)
	if (!result.ok) {
		return {
			ok: false,
			error: 'Discord API rejected command registration',
			status: result.status,
			body: result.body,
		}
	}
	return { ok: true, count: result.count, guild_id: guildId }
}

export default discord

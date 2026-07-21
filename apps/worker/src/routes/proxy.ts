import { Hono, type Context } from 'hono'
import {
	consumeForLogging,
	forwardToChannel,
	passthroughHeaders,
	truncateForLog,
} from '../lib/channelClient'
import { detectCsam, type CsamDetectResult } from '../lib/csamShield'
import { createServiceClient } from '../lib/db'
import { buildPublicModelId, parsePublicModelId } from '../lib/modelId'
import { checkRateLimits } from '../lib/rateLimit'
import { getUserRoleLimits, listAccessibleChannelIds, userCanAccessChannel } from '../lib/roles'
import { getSettings } from '../lib/settings'
import {
	countTokens,
	extractTextFromCompletion,
	extractTextFromMessages,
} from '../lib/tokenCount'
import type { AppUser, Env } from '../types'

type ProxyEnv = {
	Bindings: Env
	Variables: {
		apiUser: AppUser
		apiKey: string
	}
}

const proxy = new Hono<ProxyEnv>()

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string | null {
	return (
		c.req.header('cf-connecting-ip') ??
		c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
		null
	)
}

proxy.use('*', async (c, next) => {
	const auth = c.req.header('Authorization')
	if (!auth?.startsWith('Bearer ')) {
		return c.json({ error: { message: 'Missing API key', type: 'invalid_request_error' } }, 401)
	}
	const apiKey = auth.slice(7).trim()
	if (!apiKey) {
		return c.json({ error: { message: 'Missing API key', type: 'invalid_request_error' } }, 401)
	}

	const db = createServiceClient(c.env)
	const { data: user, error } = await db
		.from('app_users')
		.select('*')
		.eq('api_key', apiKey)
		.maybeSingle()

	if (error) {
		return c.json({ error: { message: 'Auth lookup failed', type: 'server_error' } }, 500)
	}
	if (!user) {
		return c.json({ error: { message: 'Invalid API key', type: 'invalid_request_error' } }, 401)
	}
	if (!user.is_active) {
		return c.json(
			{ error: { message: 'API key disabled', type: 'invalid_request_error', code: 'key_disabled' } },
			401,
		)
	}

	c.set('apiUser', user as AppUser)
	c.set('apiKey', apiKey)

	const ip = clientIp(c)
	if (ip) {
		c.executionCtx.waitUntil(
			(async () => {
				const { error: upErr } = await db
					.from('app_users')
					.update({ last_ip: ip })
					.eq('id', user.id)
				if (upErr) console.error('last_ip update failed', upErr)
			})(),
		)
	}

	await next()
})

type ResolvedModel = {
	modelRowId: string
	channel_id: string
	base_url: string
	api_key: string
	rawModelId: string
	publicModelId: string
}

async function resolveModelChannel(
	db: ReturnType<typeof createServiceClient>,
	publicModel: string,
): Promise<ResolvedModel | null> {
	// Public ids are `<channelName>/<rawModelId>` — split on the first slash.
	const parsed = parsePublicModelId(publicModel)
	if (parsed) {
		const { data: channel, error: chErr } = await db
			.from('channels')
			.select('id, name, base_url, api_key, is_active')
			.eq('name', parsed.channelName)
			.eq('is_active', true)
			.maybeSingle()

		if (chErr || !channel || !channel.base_url || !channel.api_key) return null

		const { data: model, error: mErr } = await db
			.from('models')
			.select('id')
			.eq('channel_id', channel.id)
			.eq('model_id', parsed.rawModelId)
			.eq('is_exposed', true)
			.maybeSingle()

		if (mErr || !model) return null

		return {
			modelRowId: model.id as string,
			channel_id: channel.id,
			base_url: channel.base_url,
			api_key: channel.api_key,
			rawModelId: parsed.rawModelId,
			publicModelId: publicModel,
		}
	}

	// Fallback: bare model id with no channel prefix — only if exactly one
	// exposed match exists across active channels (avoids silent ambiguity).
	const { data: matches, error } = await db
		.from('models')
		.select('id, model_id, channel_id, channels(name, base_url, api_key, is_active)')
		.eq('model_id', publicModel)
		.eq('is_exposed', true)

	if (error || !matches?.length) return null

	const active = matches
		.map((m) => {
			const chRel = m.channels as
				| { name?: string; base_url?: string; api_key?: string; is_active?: boolean }
				| { name?: string; base_url?: string; api_key?: string; is_active?: boolean }[]
				| null
			const ch = Array.isArray(chRel) ? chRel[0] : chRel
			return { m, ch }
		})
		.filter((x) => x.ch?.is_active && x.ch.base_url && x.ch.api_key && x.ch.name)

	if (active.length !== 1) return null
	const only = active[0]!
	return {
		modelRowId: only.m.id as string,
		channel_id: only.m.channel_id as string,
		base_url: only.ch!.base_url as string,
		api_key: only.ch!.api_key as string,
		rawModelId: only.m.model_id as string,
		publicModelId: buildPublicModelId(only.ch!.name as string, only.m.model_id as string),
	}
}

type CsamLogFields = {
	csam_flagged: boolean
	csam_reason: string | null
	csam_snippet: string | null
	csam_source: string | null
}

async function logAndStats(opts: {
	env: Env
	userId: string
	apiKey: string
	modelId: string
	modelRowId: string
	channelId: string
	ip: string | null
	statusCode: number
	isError: boolean
	promptTokens: number | null
	completionTokens: number | null
	promptContent: unknown | null
	responseContent: unknown | null
	csam?: CsamLogFields | null
	/** Sticky watch: set app_users.log_user_prompt = true after a CSAM flag. */
	enableUserPromptLog?: boolean
}): Promise<void> {
	const db = createServiceClient(opts.env)
	const csam = opts.csam
	const { error: logErr } = await db.from('logs').insert({
		user_id: opts.userId,
		api_key: opts.apiKey,
		model_id: opts.modelId,
		channel_id: opts.channelId,
		ip_address: opts.ip,
		prompt_tokens: opts.promptTokens,
		completion_tokens: opts.completionTokens,
		status_code: opts.statusCode,
		is_error: opts.isError,
		prompt_content: opts.promptContent,
		response_content: opts.responseContent,
		csam_flagged: csam?.csam_flagged ?? false,
		csam_reason: csam?.csam_reason ?? null,
		csam_snippet: csam?.csam_snippet ?? null,
		csam_source: csam?.csam_source ?? null,
	})
	if (logErr) console.error('log insert failed', logErr)

	if (opts.enableUserPromptLog) {
		const { error: upErr } = await db
			.from('app_users')
			.update({ log_user_prompt: true })
			.eq('id', opts.userId)
			.eq('log_user_prompt', false)
		if (upErr) console.error('user log_user_prompt sticky update failed', upErr)
	}

	const { data: st } = await db
		.from('model_stats')
		.select('total_requests, total_errors')
		.eq('model_id', opts.modelRowId)
		.maybeSingle()

	if (st) {
		const { error: upErr } = await db
			.from('model_stats')
			.update({
				total_requests: Number(st.total_requests) + 1,
				total_errors: Number(st.total_errors) + (opts.isError ? 1 : 0),
				updated_at: new Date().toISOString(),
			})
			.eq('model_id', opts.modelRowId)
		if (upErr) console.error('model_stats update failed', upErr)
	} else {
		const { error: insErr } = await db.from('model_stats').insert({
			model_id: opts.modelRowId,
			total_requests: 1,
			total_errors: opts.isError ? 1 : 0,
		})
		if (insErr) console.error('model_stats insert failed', insErr)
	}
}

proxy.post('/chat/completions', async (c) => {
	return handleCompletion(c, '/v1/chat/completions')
})

proxy.post('/completions', async (c) => {
	return handleCompletion(c, '/v1/completions')
})

async function handleCompletion(
	c: Context<ProxyEnv>,
	upstreamPath: string,
): Promise<Response> {
	const user = c.get('apiUser')
	const apiKey = c.get('apiKey')
	const db = createServiceClient(c.env)
	const settings = await getSettings(db)

	let roleLimits: Awaited<ReturnType<typeof getUserRoleLimits>>['limits']
	try {
		const { limits } = await getUserRoleLimits(db, user.role_id)
		roleLimits = limits
	} catch (e) {
		console.error(e)
		return c.json({ error: { message: 'Role lookup failed', type: 'server_error' } }, 500)
	}

	try {
		const rl = await checkRateLimits(db, user.id, roleLimits)
		if (!rl.ok) {
			return c.json(
				{
					error: {
						message: `Rate limit exceeded (${rl.reason}): ${rl.current}/${rl.limit}`,
						type: 'rate_limit_error',
						code: 'rate_limit_exceeded',
					},
				},
				429,
			)
		}
	} catch (e) {
		console.error(e)
		return c.json({ error: { message: 'Rate limit check failed', type: 'server_error' } }, 500)
	}

	let body: Record<string, unknown>
	try {
		body = (await c.req.json()) as Record<string, unknown>
	} catch {
		return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }, 400)
	}

	const modelId = typeof body.model === 'string' ? body.model : ''
	if (!modelId) {
		return c.json({ error: { message: 'model is required', type: 'invalid_request_error' } }, 400)
	}

	const resolved = await resolveModelChannel(db, modelId)
	if (!resolved) {
		return c.json(
			{
				error: {
					message: `Model '${modelId}' not found or not available. Use the public id from GET /v1/models (format: channel/model-id, e.g. cli/gemini-3.5-flash).`,
					type: 'invalid_request_error',
					code: 'model_not_found',
				},
			},
			404,
		)
	}

	try {
		const allowed = await userCanAccessChannel(db, user.role_id, resolved.channel_id)
		if (!allowed) {
			return c.json(
				{
					error: {
						message: `Your role does not have access to model '${modelId}'.`,
						type: 'invalid_request_error',
						code: 'model_access_denied',
					},
				},
				403,
			)
		}
	} catch (e) {
		console.error(e)
		return c.json({ error: { message: 'Access check failed', type: 'server_error' } }, 500)
	}

	// CSAM: sync request scan only (sub-ms–few ms). Never buffers the stream.
	let csamResult: CsamDetectResult | null = null
	if (settings.csam_scan_enabled) {
		try {
			csamResult = detectCsam({
				messages: Array.isArray(body.messages)
					? (body.messages as { role?: string; content?: unknown }[])
					: undefined,
				prompt: body.prompt,
			})
		} catch (e) {
			// Detection must never break the proxy path
			console.error('csam scan failed', e instanceof Error ? e.message : e)
			csamResult = null
		}
	}

	const userLogPrompt = Boolean(user.log_user_prompt)
	const storePrompt =
		settings.log_user_prompt || userLogPrompt || Boolean(csamResult?.flagged)
	const csamFields: CsamLogFields | null = csamResult
		? {
				csam_flagged: true,
				csam_reason: csamResult.reason,
				// Short window only — full body lives in prompt_content when forced
				csam_snippet: csamResult.snippet.slice(0, 500),
				csam_source: 'request',
			}
		: null
	const enableStickyUserLog = Boolean(csamResult?.flagged) && !userLogPrompt

	// log_and_block: still write evidence log, then 400 before upstream
	if (csamResult && settings.csam_action === 'log_and_block') {
		c.executionCtx.waitUntil(
			logAndStats({
				env: c.env,
				userId: user.id,
				apiKey,
				modelId: resolved.publicModelId,
				modelRowId: resolved.modelRowId,
				channelId: resolved.channel_id,
				ip: clientIp(c),
				statusCode: 400,
				isError: true,
				promptTokens: null,
				completionTokens: null,
				promptContent: truncateForLog(body),
				responseContent: truncateForLog({
					error: 'Request blocked by content policy.',
					code: 'CSAM_SHIELD',
					reason: csamResult.reason,
				}),
				csam: csamFields,
				enableUserPromptLog: enableStickyUserLog,
			}),
		)
		return c.json(
			{
				error: {
					message: 'Request blocked by content policy.',
					type: 'invalid_request_error',
					code: 'CSAM_SHIELD',
					reason: csamResult.reason,
				},
			},
			400,
		)
	}

	const streamFlag = Boolean(body.stream)
	// Forward the channel's native model id upstream, not the namespaced public id.
	const bodyStr = JSON.stringify({ ...body, model: resolved.rawModelId })
	let upstream: Response
	try {
		upstream = await forwardToChannel(resolved.base_url, resolved.api_key, upstreamPath, {
			method: 'POST',
			body: bodyStr,
		})
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e)
		c.executionCtx.waitUntil(
			logAndStats({
				env: c.env,
				userId: user.id,
				apiKey,
				modelId: resolved.publicModelId,
				modelRowId: resolved.modelRowId,
				channelId: resolved.channel_id,
				ip: clientIp(c),
				statusCode: 502,
				isError: true,
				promptTokens: null,
				completionTokens: null,
				promptContent: storePrompt ? truncateForLog(body) : null,
				// Always store transport errors for owner debugging
				responseContent: truncateForLog({ error: msg, type: 'upstream_unreachable' }),
				csam: csamFields,
				enableUserPromptLog: enableStickyUserLog,
			}),
		)
		return c.json(
			{ error: { message: `Upstream unreachable: ${msg}`, type: 'server_error' } },
			502,
		)
	}

	const status = upstream.status
	const isError = status >= 400
	const headers = passthroughHeaders(upstream)
	const ip = clientIp(c)

	const finishLog = async (
		promptTokens: number | null,
		completionTokens: number | null,
		responseContent: unknown | null,
	) => {
		let pt = promptTokens
		let ct = completionTokens
		if (settings.count_tokens) {
			const promptText =
				extractTextFromMessages(body.messages) ||
				(typeof body.prompt === 'string' ? body.prompt : '')
			pt = countTokens(promptText)
			if (responseContent && typeof responseContent === 'object') {
				const streamText = (responseContent as { stream_text?: string }).stream_text
				if (typeof streamText === 'string') {
					ct = countTokens(streamText)
				} else {
					ct = countTokens(extractTextFromCompletion(responseContent))
				}
			} else if (typeof responseContent === 'string') {
				ct = countTokens(responseContent)
			}
		}
		// Always persist error bodies so owners can debug even when log_user_prompt is off.
		// Success prompt/response gated by global OR per-user OR CSAM force-log.
		const promptContent = storePrompt ? truncateForLog(body) : null
		const responseForLog = isError
			? truncateForLog(responseContent)
			: storePrompt
				? truncateForLog(responseContent)
				: null
		await logAndStats({
			env: c.env,
			userId: user.id,
			apiKey,
			modelId: resolved.publicModelId,
			modelRowId: resolved.modelRowId,
			channelId: resolved.channel_id,
			ip,
			statusCode: status,
			isError,
			promptTokens: pt,
			completionTokens: ct,
			promptContent,
			responseContent: responseForLog,
			csam: csamFields,
			enableUserPromptLog: enableStickyUserLog,
		})
	}

	if (!upstream.body) {
		const text = await upstream.text()
		let json: unknown = null
		try {
			json = text ? JSON.parse(text) : null
		} catch {
			json = text
		}
		const usage =
			json && typeof json === 'object'
				? (json as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage
				: undefined
		c.executionCtx.waitUntil(
			finishLog(usage?.prompt_tokens ?? null, usage?.completion_tokens ?? null, json),
		)
		return new Response(text, { status, headers })
	}

	const [clientBranch, logBranch] = upstream.body.tee()

	c.executionCtx.waitUntil(
		(async () => {
			const captured = await consumeForLogging(logBranch, streamFlag)
			let responseContent: unknown = captured.responseJson
			if (storePrompt && streamFlag) {
				responseContent = {
					stream_text: captured.responseText,
					last_chunk: captured.responseJson,
				}
			}
			await finishLog(
				captured.prompt_tokens,
				captured.completion_tokens,
				responseContent,
			)
		})(),
	)

	return new Response(clientBranch, { status, headers })
}

proxy.get('/models', async (c) => {
	const user = c.get('apiUser')
	const db = createServiceClient(c.env)
	const { data, error } = await db
		.from('models')
		.select('model_id, created_at, channel_id, channels(name, is_active)')
		.eq('is_exposed', true)
		.order('model_id')

	if (error) {
		return c.json({ error: { message: 'Failed to list models', type: 'server_error' } }, 500)
	}

	let allowedChannels: Set<string> | null = null
	try {
		const access = await listAccessibleChannelIds(db, user.role_id)
		if (!access.allOpen) allowedChannels = access.allowedIds
	} catch (e) {
		console.error(e)
		return c.json({ error: { message: 'Failed to resolve channel access', type: 'server_error' } }, 500)
	}

	const list: { id: string; object: string; created: number; owned_by: string }[] = []
	for (const m of data ?? []) {
		const chRel = m.channels as
			| { name?: string; is_active?: boolean }
			| { name?: string; is_active?: boolean }[]
			| null
		const ch = Array.isArray(chRel) ? chRel[0] : chRel
		if (!ch?.is_active || !ch.name) continue
		if (allowedChannels && !allowedChannels.has(m.channel_id as string)) continue
		list.push({
			id: buildPublicModelId(ch.name, m.model_id),
			object: 'model',
			created: Math.floor(new Date(m.created_at).getTime() / 1000),
			owned_by: ch.name,
		})
	}

	return c.json({ object: 'list', data: list })
})

export default proxy

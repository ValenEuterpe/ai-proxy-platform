/**
 * API base URL strategy:
 * - Production builds always use same-origin (`''`) so `/api` and `/v1` go through
 *   Cloudflare Pages Functions → Worker. That makes cookies first-party and
 *   avoids cross-site cookie blocks (incognito / Yandex / Safari).
 * - Dev: use VITE_WORKER_API_URL or Vite proxy (relative).
 *
 * Owner auth: login returns a token; we store it (memory + sessionStorage) and send
 * `X-Owner-Session` on every admin request. Cookies are a bonus, not required.
 */

const OWNER_TOKEN_KEY = 'owner_session_token'

/** In-memory fallback when sessionStorage is blocked (some private modes). */
let memoryOwnerToken: string | null = null

function resolveApiBase(): string {
	const configured = (import.meta.env.VITE_WORKER_API_URL as string | undefined)
		?.trim()
		.replace(/\/+$/, '')

	// Production: force same-origin so a leftover workers.dev env cannot break auth.
	if (import.meta.env.PROD) {
		return ''
	}
	// Dev: explicit worker URL, or relative (vite proxy)
	return configured ?? ''
}

const base = resolveApiBase()

export function apiBaseUrl(): string {
	if (base) return base
	if (typeof window !== 'undefined') return window.location.origin
	return ''
}

export function getOwnerToken(): string | null {
	if (memoryOwnerToken) return memoryOwnerToken
	try {
		return sessionStorage.getItem(OWNER_TOKEN_KEY)
	} catch {
		return null
	}
}

export function setOwnerToken(token: string | null): void {
	memoryOwnerToken = token
	try {
		if (token) sessionStorage.setItem(OWNER_TOKEN_KEY, token)
		else sessionStorage.removeItem(OWNER_TOKEN_KEY)
	} catch {
		// storage blocked — memory still holds the token for this page session
	}
}

async function request<T>(
	path: string,
	init: RequestInit & { json?: unknown } = {},
): Promise<T> {
	const headers = new Headers(init.headers)
	if (init.json !== undefined) {
		headers.set('Content-Type', 'application/json')
	}

	const isAdmin = path.startsWith('/api/admin')
	const isLogin = path === '/api/admin/login'
	if (isAdmin && !isLogin) {
		const token = getOwnerToken()
		if (token) {
			// Primary: custom header (never mistaken for user JWT, not cookie-dependent)
			if (!headers.has('X-Owner-Session')) {
				headers.set('X-Owner-Session', token)
			}
			// Also send Bearer for compatibility
			if (!headers.has('Authorization')) {
				headers.set('Authorization', `Bearer ${token}`)
			}
		}
	}

	const url = `${base}${path}`
	let res: Response
	try {
		res = await fetch(url, {
			...init,
			headers,
			credentials: 'include',
			body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
		})
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e)
		throw new Error(
			`Network error calling ${url}: ${msg}. If production, redeploy Pages with functions/ proxying /api to the Worker.`,
		)
	}

	const text = await res.text()
	let data: T & { error?: string; reason?: string; hint?: string } = {} as T & {
		error?: string
		reason?: string
		hint?: string
	}
	try {
		data = text ? (JSON.parse(text) as typeof data) : data
	} catch {
		// Non-JSON (e.g. HTML from Pages SPA fallback if _redirects missing)
		if (!res.ok) {
			throw new Error(
				`Request failed (${res.status}) at ${url}. Response was not JSON — is /api reverse-proxied to the Worker?`,
			)
		}
	}

	if (!res.ok) {
		if (res.status === 401 && isAdmin && !isLogin) {
			setOwnerToken(null)
		}
		const err = data.error
		const baseMsg =
			typeof err === 'string'
				? err
				: err && typeof err === 'object' && err !== null && 'message' in err
					? String((err as { message?: string }).message)
					: `Request failed (${res.status})`
		const extra = [data.reason, data.hint].filter(Boolean).join(' — ')
		throw new Error(extra ? `${baseMsg} (${extra})` : baseMsg)
	}
	return data as T
}

export type Role = {
	id: string
	name: string
	requests_per_day: number | null
	requests_per_minute: number | null
	tokens_per_day: number | null
	tokens_per_minute: number | null
	is_default: boolean
	created_at?: string
}

export type AppUser = {
	id: string
	discord_id: string
	discord_username: string | null
	api_key: string
	registered_at: string
	last_ip: string | null
	is_active: boolean
	admin_disabled?: boolean
	role_id?: string | null
	role?: {
		id: string
		name: string
		requests_per_day: number | null
		requests_per_minute: number | null
		tokens_per_day: number | null
		tokens_per_minute: number | null
		is_default: boolean
	} | null
	/** Present when disabled and owner configured an invite */
	discord_invite_url?: string | null
}

export type UserStats = {
	calls_all_time: { success: number; errors: number }
	calls_today: { success: number; errors: number }
	tokens_all_time: number
	tokens_today: number
	top_models: {
		model_id: string
		requests: number
		success: number
		errors: number
		tokens: number
	}[]
}

export type AdminUser = {
	id: string
	discord_id: string
	discord_username: string | null
	registered_at: string
	last_ip: string | null
	is_active: boolean
	admin_disabled: boolean
	disable_reason: 'admin' | 'guild' | null
	role_id: string | null
	role_name: string | null
	/** Per-user prompt logging (auto-on after CSAM flag). */
	log_user_prompt?: boolean
}

export type AdminLog = {
	id: number
	user_id: string | null
	discord_username: string | null
	discord_id: string | null
	model_id: string | null
	channel_id: string | null
	ip_address: string | null
	prompt_tokens: number | null
	completion_tokens: number | null
	status_code: number | null
	is_error: boolean
	prompt_content: unknown | null
	response_content: unknown | null
	created_at: string
	csam_flagged?: boolean
	csam_reason?: string | null
	csam_snippet?: string | null
	csam_source?: string | null
	csam_reviewed?: boolean
	csam_reviewed_at?: string | null
	csam_review_note?: string | null
}

export type CsamAction = 'log' | 'log_and_block'

export type Settings = {
	count_tokens: boolean
	log_user_prompt: boolean
	/** Empty/null = Discord server membership gate off */
	required_discord_guild_id: string | null
	discord_invite_url: string | null
	/** Master CSAM shield on/off */
	csam_scan_enabled?: boolean
	/** log = flag only; log_and_block = flag + HTTP 400 */
	csam_action?: CsamAction
	/** Discord slash commands master switch */
	discord_commands_enabled?: boolean
	discord_cmd_stats_channel_id?: string | null
	discord_cmd_stats_role_id?: string | null
	discord_cmd_stats_ephemeral?: boolean
	discord_cmd_assignrole_channel_id?: string | null
	discord_cmd_assignrole_role_id?: string | null
	/** Website roles.id UUID assigned via /assignrole (not a Discord role) */
	discord_cmd_assignrole_target_role_id?: string | null
	discord_cmd_assignrole_ephemeral?: boolean
	updated_at?: string
}

export type ChannelRow = {
	id: string
	name: string
	base_url: string
	api_key_masked: string
	created_at: string
	is_active: boolean
	model_count: number
	/** Empty = open to all roles */
	role_ids: string[]
}

export type UsageWindow = {
	success: number
	errors: number
	limit: number | null
	remaining: number | null
	unlimited: boolean
	/** ISO timestamp when the daily quota resets (day window only). */
	resets_at?: string
}

export type ModelTestResult = {
	ok: boolean
	via: 'provider' | 'proxy'
	public_model_id: string
	raw_model_id?: string
	request_url?: string
	client_url?: string
	client_body?: unknown
	request_body?: unknown
	status?: number
	error?: string | null
	body?: unknown
	looks_like_cloudflare_block?: boolean
	duration_ms?: number
}

export type ExposedModel = {
	public_id: string
	total_requests: number
	success_rate: number | null
}

export const api = {
	health: () => request<{ ok: boolean }>('/health'),

	publicModels: () => request<{ models: ExposedModel[] }>('/api/public/models'),

	adminLogin: async (username: string, password: string) => {
		const res = await request<{ ok: boolean; token?: string }>('/api/admin/login', {
			method: 'POST',
			json: { username, password },
		})
		if (!res.token) {
			throw new Error(
				'Login OK but Worker did not return a session token. Redeploy apps/worker (wrangler deploy), hard-refresh the site, then try again.',
			)
		}
		setOwnerToken(res.token)
		return res
	},

	adminLogout: async () => {
		try {
			return await request<{ ok: boolean }>('/api/admin/logout', { method: 'POST' })
		} finally {
			setOwnerToken(null)
		}
	},

	adminMe: () => request<{ ok: boolean; role: string }>('/api/admin/me'),

	listChannels: () =>
		request<{
			channels: ChannelRow[]
		}>('/api/admin/channels'),

	getChannel: (id: string) =>
		request<{
			channel: {
				id: string
				name: string
				base_url: string
				api_key_masked: string
				api_key: string
				created_at: string
				is_active: boolean
				role_ids: string[]
			}
			models: {
				id: string
				model_id: string
				display_name: string | null
				is_exposed: boolean
				created_at: string
			}[]
		}>(`/api/admin/channels/${id}`),

	testChannel: (base_url: string, api_key: string) =>
		request<{ models: { id: string; name?: string }[] }>('/api/admin/channels/test', {
			method: 'POST',
			json: { base_url, api_key },
		}),

	createChannel: (body: {
		name: string
		base_url: string
		api_key: string
		models: { id: string; name?: string; is_exposed?: boolean }[]
		role_ids?: string[]
	}) =>
		request<{ channel: unknown }>('/api/admin/channels', {
			method: 'POST',
			json: body,
		}),

	patchChannel: (
		id: string,
		body: {
			is_active?: boolean
			name?: string
			base_url?: string
			api_key?: string
			models?: { id: string; name?: string; is_exposed?: boolean }[]
			role_ids?: string[]
		},
	) =>
		request<{ channel: ChannelRow }>(`/api/admin/channels/${id}`, {
			method: 'PATCH',
			json: body,
		}),

	deleteChannel: (id: string) =>
		request<{ ok: boolean }>(`/api/admin/channels/${id}`, { method: 'DELETE' }),

	listModels: () =>
		request<{
			models: {
				id: string
				channel_id: string
				channel_name: string | null
				model_id: string
				display_name: string | null
				is_exposed: boolean
				created_at: string
				total_requests: number
				total_errors: number
				success_rate: number | null
			}[]
		}>('/api/admin/models'),

	patchModel: (id: string, body: { is_exposed?: boolean; display_name?: string | null }) =>
		request<{ model: unknown }>(`/api/admin/models/${id}`, {
			method: 'PATCH',
			json: body,
		}),

	testModel: (
		id: string,
		body: { via: 'provider' | 'proxy'; message?: string; max_tokens?: number },
	) =>
		request<ModelTestResult>(`/api/admin/models/${id}/test`, {
			method: 'POST',
			json: body,
		}),

	listUsers: (q?: string) => {
		const qs = q ? `?q=${encodeURIComponent(q)}` : ''
		return request<{ users: AdminUser[] }>(`/api/admin/users${qs}`)
	},

	getUser: (id: string) =>
		request<{
			user: AdminUser
			limits: {
				requests_per_minute: number | null
				requests_per_day: number | null
				tokens_per_minute: number | null
				tokens_per_day: number | null
			}
			minute: UsageWindow
			day: UsageWindow
			tokens_minute: UsageWindow
			tokens_day: UsageWindow
			stats: UserStats
		}>(`/api/admin/users/${id}`),

	patchUser: (
		id: string,
		body: { is_active?: boolean; role_id?: string | null; log_user_prompt?: boolean },
	) =>
		request<{ user: AdminUser }>(`/api/admin/users/${id}`, {
			method: 'PATCH',
			json: body,
		}),

	listRoles: () => request<{ roles: Role[] }>('/api/admin/roles'),

	createRole: (body: {
		name: string
		requests_per_day?: number | null
		requests_per_minute?: number | null
		tokens_per_day?: number | null
		tokens_per_minute?: number | null
		is_default?: boolean
	}) =>
		request<{ role: Role }>('/api/admin/roles', {
			method: 'POST',
			json: body,
		}),

	patchRole: (
		id: string,
		body: {
			name?: string
			requests_per_day?: number | null
			requests_per_minute?: number | null
			tokens_per_day?: number | null
			tokens_per_minute?: number | null
			is_default?: boolean
		},
	) =>
		request<{ role: Role }>(`/api/admin/roles/${id}`, {
			method: 'PATCH',
			json: body,
		}),

	deleteRole: (id: string) =>
		request<{ ok: boolean }>(`/api/admin/roles/${id}`, { method: 'DELETE' }),

	listLogs: (params: {
		page?: number
		user_id?: string
		model_id?: string
		from?: string
		to?: string
		errors_only?: boolean
		/** Only CSAM-flagged rows */
		csam?: boolean
		/** Filter reviewed state when viewing CSAM queue */
		csam_reviewed?: boolean
	}) => {
		const sp = new URLSearchParams()
		if (params.page) sp.set('page', String(params.page))
		if (params.user_id) sp.set('user_id', params.user_id)
		if (params.model_id) sp.set('model_id', params.model_id)
		if (params.from) sp.set('from', params.from)
		if (params.to) sp.set('to', params.to)
		if (params.errors_only) sp.set('errors_only', '1')
		if (params.csam) sp.set('csam', '1')
		if (params.csam_reviewed === true) sp.set('csam_reviewed', '1')
		if (params.csam_reviewed === false) sp.set('csam_reviewed', '0')
		const qs = sp.toString()
		return request<{
			logs: AdminLog[]
			total: number
			page: number
			page_size: number
		}>(`/api/admin/logs${qs ? `?${qs}` : ''}`)
	},

	patchCsamReview: (
		id: number,
		body: { reviewed?: boolean; note?: string | null },
	) =>
		request<{ log: AdminLog }>(`/api/admin/logs/${id}/csam-review`, {
			method: 'PATCH',
			json: body,
		}),

	/** content = null prompt/response/snippet; csam = delete flagged rows; csam_reviewed = delete reviewed flagged rows */
	pruneLogs: (body: {
		mode: 'content' | 'csam' | 'csam_reviewed'
		dry_run?: boolean
	}) =>
		request<{
			mode: 'content' | 'csam' | 'csam_reviewed'
			dry_run: boolean
			affected: number
			complete: boolean
			remaining?: number
		}>('/api/admin/logs/prune', {
			method: 'POST',
			json: body,
		}),

	getSettings: () => request<{ settings: Settings }>('/api/admin/settings'),

	patchSettings: (body: Partial<Settings>) =>
		request<{ settings: Settings }>('/api/admin/settings', {
			method: 'PATCH',
			json: body,
		}),

	registerDiscordCommands: () =>
		request<{
			ok: boolean
			count: number
			guild_id: string
			commands: string[]
		}>('/api/admin/discord/register-commands', {
			method: 'POST',
		}),

	userEnsure: (accessToken: string) =>
		request<{ user: AppUser }>('/api/user/ensure', {
			method: 'POST',
			headers: { Authorization: `Bearer ${accessToken}` },
		}),

	userMe: (accessToken: string) =>
		request<{ user: AppUser }>('/api/user/me', {
			headers: { Authorization: `Bearer ${accessToken}` },
		}),

	userModels: (accessToken: string) =>
		request<{
			models: { public_id: string; total_requests: number; success_rate: number | null }[]
		}>('/api/user/models', {
			headers: { Authorization: `Bearer ${accessToken}` },
		}),

	userUsage: (accessToken: string) =>
		request<{
			limits: {
				requests_per_minute: number | null
				requests_per_day: number | null
				tokens_per_minute: number | null
				tokens_per_day: number | null
			}
			minute: UsageWindow
			day: UsageWindow
			tokens_minute: UsageWindow
			tokens_day: UsageWindow
			stats: UserStats
		}>('/api/user/usage', {
			headers: { Authorization: `Bearer ${accessToken}` },
		}),

	userRotateKey: (accessToken: string) =>
		request<{ user: AppUser }>('/api/user/rotate-key', {
			method: 'POST',
			headers: { Authorization: `Bearer ${accessToken}` },
		}),
}


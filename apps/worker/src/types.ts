export type Env = {
	SUPABASE_URL: string
	SUPABASE_SERVICE_ROLE_KEY: string
	OWNER_LOGIN: string
	OWNER_PASSWORD: string
	SESSION_SECRET: string
	CORS_ORIGIN?: string
	/** Bot token for optional Discord guild membership gate (wrangler secret). */
	DISCORD_BOT_TOKEN?: string
}

export type Role = {
	id: string
	name: string
	requests_per_day: number | null
	requests_per_minute: number | null
	tokens_per_day: number | null
	tokens_per_minute: number | null
	is_default: boolean
	created_at: string
}

/** Rate limits sourced from a role (null = unlimited). */
export type RoleLimits = {
	requests_per_day: number | null
	requests_per_minute: number | null
	tokens_per_day: number | null
	tokens_per_minute: number | null
}

export type AppUser = {
	id: string
	discord_id: string
	discord_username: string | null
	api_key: string
	registered_at: string
	last_ip: string | null
	is_active: boolean
	/** Owner-initiated disable; guild gate must not clear this. */
	admin_disabled?: boolean
	/** Present after 002_roles migration; may be null until backfill/ensure. */
	role_id?: string | null
	/** Per-user prompt logging (admin toggle; auto-on after CSAM flag). */
	log_user_prompt?: boolean
}

export type Channel = {
	id: string
	name: string
	base_url: string
	api_key: string
	created_at: string
	is_active: boolean
}

export type Model = {
	id: string
	channel_id: string
	model_id: string
	display_name: string | null
	is_exposed: boolean
	created_at: string
}

export type ModelStats = {
	model_id: string
	total_requests: number
	total_errors: number
	updated_at: string
}

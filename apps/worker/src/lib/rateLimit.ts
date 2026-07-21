import type { SupabaseClient } from '@supabase/supabase-js'
import type { RoleLimits } from '../types'

export type RateLimitResult =
	| { ok: true }
	| {
			ok: false
			reason: 'per_minute' | 'per_day' | 'tokens_per_minute' | 'tokens_per_day'
			limit: number
			current: number
	  }

export type WindowUsage = {
	success: number
	errors: number
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

/** Alias kept for call sites that pass role limits. */
export type RateLimitConfig = RoleLimits

/** Daily RPD resets at midnight (12:00 AM) US Eastern (America/New_York, observes DST). */
export const DAILY_QUOTA_TZ = 'America/New_York'
export const DAILY_QUOTA_RESET_HOUR = 0
export const DAILY_QUOTA_RESET_MINUTE = 0

export type DailyQuotaWindow = {
	/** Inclusive start of the current daily period (ISO). */
	sinceIso: string
	/** Instant when the next daily period begins (ISO). */
	resetsAtIso: string
}

type ZonedParts = {
	year: number
	month: number
	day: number
	hour: number
	minute: number
	second: number
}

function getZonedParts(date: Date, timeZone: string): ZonedParts {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(date)
	const get = (type: Intl.DateTimeFormatPartTypes): number => {
		const v = parts.find((p) => p.type === type)?.value
		return v ? Number(v) : 0
	}
	return {
		year: get('year'),
		month: get('month'),
		day: get('day'),
		hour: get('hour'),
		minute: get('minute'),
		second: get('second'),
	}
}

function addCalendarDays(
	year: number,
	month: number,
	day: number,
	delta: number,
): { year: number; month: number; day: number } {
	const dt = new Date(Date.UTC(year, month - 1, day + delta))
	return {
		year: dt.getUTCFullYear(),
		month: dt.getUTCMonth() + 1,
		day: dt.getUTCDate(),
	}
}

/**
 * Convert a civil wall-clock time in `timeZone` to a UTC Date.
 * Iteratively resolves the zone offset (handles DST). If the wall time falls
 * in a spring-forward gap (e.g. 2:00 AM on the day clocks jump 2→3), lands on
 * the first valid instant after the gap.
 */
export function zonedWallTimeToUtc(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	second = 0,
	timeZone = DAILY_QUOTA_TZ,
): Date {
	let utcMs = Date.UTC(year, month - 1, day, hour, minute, second)
	for (let i = 0; i < 4; i++) {
		const parts = getZonedParts(new Date(utcMs), timeZone)
		const asIfUtc = Date.UTC(
			parts.year,
			parts.month - 1,
			parts.day,
			parts.hour,
			parts.minute,
			parts.second,
		)
		const wanted = Date.UTC(year, month - 1, day, hour, minute, second)
		const diff = wanted - asIfUtc
		if (diff === 0) break
		utcMs += diff
	}
	return new Date(utcMs)
}

/**
 * Current daily quota window: from the most recent midnight Eastern through
 * the next midnight Eastern.
 */
export function getDailyQuotaWindow(nowMs: number = Date.now()): DailyQuotaWindow {
	const nowParts = getZonedParts(new Date(nowMs), DAILY_QUOTA_TZ)
	let periodStart = zonedWallTimeToUtc(
		nowParts.year,
		nowParts.month,
		nowParts.day,
		DAILY_QUOTA_RESET_HOUR,
		DAILY_QUOTA_RESET_MINUTE,
	)

	if (nowMs < periodStart.getTime()) {
		const prev = addCalendarDays(nowParts.year, nowParts.month, nowParts.day, -1)
		periodStart = zonedWallTimeToUtc(
			prev.year,
			prev.month,
			prev.day,
			DAILY_QUOTA_RESET_HOUR,
			DAILY_QUOTA_RESET_MINUTE,
		)
	}

	const startParts = getZonedParts(periodStart, DAILY_QUOTA_TZ)
	const nextDay = addCalendarDays(startParts.year, startParts.month, startParts.day, 1)
	const resetsAt = zonedWallTimeToUtc(
		nextDay.year,
		nextDay.month,
		nextDay.day,
		DAILY_QUOTA_RESET_HOUR,
		DAILY_QUOTA_RESET_MINUTE,
	)

	return {
		sinceIso: periodStart.toISOString(),
		resetsAtIso: resetsAt.toISOString(),
	}
}

async function countLogs(
	db: SupabaseClient,
	userId: string,
	sinceIso: string,
	isError: boolean,
	/** Inclusive lower bound when true (daily windows); exclusive when false (rolling minute). */
	inclusive = false,
): Promise<number> {
	let q = db
		.from('logs')
		.select('id', { count: 'exact', head: true })
		.eq('user_id', userId)
		.eq('is_error', isError)
	q = inclusive ? q.gte('created_at', sinceIso) : q.gt('created_at', sinceIso)
	const { count, error } = await q
	if (error) throw new Error(error.message)
	return count ?? 0
}

/** Successful + error counts in a time window (errors do not count toward RPM/RPD). */
export async function getWindowUsage(
	db: SupabaseClient,
	userId: string,
	sinceIso: string,
	inclusive = false,
): Promise<WindowUsage> {
	const [success, errors] = await Promise.all([
		countLogs(db, userId, sinceIso, false, inclusive),
		countLogs(db, userId, sinceIso, true, inclusive),
	])
	return { success, errors }
}

/**
 * Sum prompt+completion tokens on successful logs in a window.
 * Null token fields count as 0. Prefer RPC when migration 004 is applied;
 * falls back to a bounded select if the RPC is missing.
 */
export async function sumUserTokens(
	db: SupabaseClient,
	userId: string,
	sinceIso: string,
	inclusive = false,
): Promise<number> {
	const { data, error } = await db.rpc('sum_user_tokens', {
		p_user_id: userId,
		p_since: sinceIso,
		p_inclusive: inclusive,
	})
	if (!error) {
		const n = typeof data === 'number' ? data : Number(data)
		return Number.isFinite(n) ? n : 0
	}

	// Fallback if RPC not deployed yet (do not block proxy hard-fail on missing fn)
	if (!/function|does not exist|schema cache/i.test(error.message)) {
		throw new Error(error.message)
	}

	let q = db
		.from('logs')
		.select('prompt_tokens, completion_tokens')
		.eq('user_id', userId)
		.eq('is_error', false)
	q = inclusive ? q.gte('created_at', sinceIso) : q.gt('created_at', sinceIso)
	const { data: rows, error: selErr } = await q.limit(50_000)
	if (selErr) throw new Error(selErr.message)
	let sum = 0
	for (const r of rows ?? []) {
		sum += (r.prompt_tokens ?? 0) + (r.completion_tokens ?? 0)
	}
	return sum
}

export async function getUserUsageStats(
	db: SupabaseClient,
	userId: string,
	daySinceIso: string,
): Promise<UserStats> {
	const { data, error } = await db.rpc('user_usage_stats', {
		p_user_id: userId,
		p_day_since: daySinceIso,
	})
	if (!error && data && typeof data === 'object') {
		const d = data as Record<string, unknown>
		const callsAll = (d.calls_all_time ?? {}) as { success?: number; errors?: number }
		const callsToday = (d.calls_today ?? {}) as { success?: number; errors?: number }
		const top = Array.isArray(d.top_models) ? d.top_models : []
		return {
			calls_all_time: {
				success: Number(callsAll.success ?? 0),
				errors: Number(callsAll.errors ?? 0),
			},
			calls_today: {
				success: Number(callsToday.success ?? 0),
				errors: Number(callsToday.errors ?? 0),
			},
			tokens_all_time: Number(d.tokens_all_time ?? 0),
			tokens_today: Number(d.tokens_today ?? 0),
			top_models: top.map((m: Record<string, unknown>) => ({
				model_id: String(m.model_id ?? ''),
				requests: Number(m.requests ?? 0),
				success: Number(m.success ?? 0),
				errors: Number(m.errors ?? 0),
				tokens: Number(m.tokens ?? 0),
			})),
		}
	}

	if (error && !/function|does not exist|schema cache/i.test(error.message)) {
		throw new Error(error.message)
	}

	// Fallback without RPC
	const { data: rows, error: selErr } = await db
		.from('logs')
		.select('is_error, created_at, model_id, prompt_tokens, completion_tokens')
		.eq('user_id', userId)
		.limit(100_000)
	if (selErr) throw new Error(selErr.message)

	const daySinceMs = new Date(daySinceIso).getTime()
	let allS = 0
	let allE = 0
	let todayS = 0
	let todayE = 0
	let tokAll = 0
	let tokToday = 0
	const byModel = new Map<
		string,
		{ requests: number; success: number; errors: number; tokens: number }
	>()

	for (const r of rows ?? []) {
		const err = Boolean(r.is_error)
		const tokens = (r.prompt_tokens ?? 0) + (r.completion_tokens ?? 0)
		const today = new Date(r.created_at as string).getTime() >= daySinceMs
		if (err) {
			allE++
			if (today) todayE++
		} else {
			allS++
			tokAll += tokens
			if (today) {
				todayS++
				tokToday += tokens
			}
		}
		const mid = r.model_id as string | null
		if (mid) {
			const cur = byModel.get(mid) ?? { requests: 0, success: 0, errors: 0, tokens: 0 }
			cur.requests++
			if (err) cur.errors++
			else {
				cur.success++
				cur.tokens += tokens
			}
			byModel.set(mid, cur)
		}
	}

	const top_models = [...byModel.entries()]
		.map(([model_id, v]) => ({ model_id, ...v }))
		.sort((a, b) => b.requests - a.requests)
		.slice(0, 5)

	return {
		calls_all_time: { success: allS, errors: allE },
		calls_today: { success: todayS, errors: todayE },
		tokens_all_time: tokAll,
		tokens_today: tokToday,
		top_models,
	}
}

/**
 * Rate limits only count successful requests (`is_error = false`).
 * Failed/upstream-error logs are kept for history but do not burn quota.
 * Limits come from the user's role (`RoleLimits`), not global settings.
 *
 * Token limits use prompt_tokens + completion_tokens (null → 0).
 *
 * Per-day uses a fixed Eastern reset at midnight (not a rolling 24h window).
 * Per-minute remains a rolling 60-second window.
 */
export async function checkRateLimits(
	db: SupabaseClient,
	userId: string,
	limits: RateLimitConfig,
): Promise<RateLimitResult> {
	if (limits.requests_per_minute != null) {
		const since = new Date(Date.now() - 60_000).toISOString()
		const current = await countLogs(db, userId, since, false, false)
		if (current >= limits.requests_per_minute) {
			return {
				ok: false,
				reason: 'per_minute',
				limit: limits.requests_per_minute,
				current,
			}
		}
	}

	if (limits.requests_per_day != null) {
		const { sinceIso } = getDailyQuotaWindow()
		const current = await countLogs(db, userId, sinceIso, false, true)
		if (current >= limits.requests_per_day) {
			return {
				ok: false,
				reason: 'per_day',
				limit: limits.requests_per_day,
				current,
			}
		}
	}

	const needTokenMinute = limits.tokens_per_minute != null
	const needTokenDay = limits.tokens_per_day != null
	if (needTokenMinute || needTokenDay) {
		const minuteSince = new Date(Date.now() - 60_000).toISOString()
		const { sinceIso: daySince } = getDailyQuotaWindow()

		if (needTokenMinute) {
			const current = await sumUserTokens(db, userId, minuteSince, false)
			if (current >= limits.tokens_per_minute!) {
				return {
					ok: false,
					reason: 'tokens_per_minute',
					limit: limits.tokens_per_minute!,
					current,
				}
			}
		}

		if (needTokenDay) {
			const current = await sumUserTokens(db, userId, daySince, true)
			if (current >= limits.tokens_per_day!) {
				return {
					ok: false,
					reason: 'tokens_per_day',
					limit: limits.tokens_per_day!,
					current,
				}
			}
		}
	}

	return { ok: true }
}

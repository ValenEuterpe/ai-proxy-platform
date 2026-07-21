import { describe, expect, it } from 'vitest'
import {
	getDailyQuotaWindow,
	zonedWallTimeToUtc,
	DAILY_QUOTA_TZ,
	DAILY_QUOTA_RESET_HOUR,
	DAILY_QUOTA_RESET_MINUTE,
} from '../src/lib/rateLimit'

/** Format a Date in America/New_York as HH:mm for assertions. */
function easternHHmm(d: Date): string {
	return new Intl.DateTimeFormat('en-US', {
		timeZone: DAILY_QUOTA_TZ,
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).format(d)
}

describe('getDailyQuotaWindow', () => {
	it('uses period starting at today midnight ET when after reset', () => {
		// 2025-01-15 14:00 EST = 19:00 UTC (EST = UTC-5 in winter)
		const now = Date.parse('2025-01-15T19:00:00.000Z')
		const { sinceIso, resetsAtIso } = getDailyQuotaWindow(now)

		const since = new Date(sinceIso)
		const resets = new Date(resetsAtIso)

		expect(easternHHmm(since)).toBe('00:00')
		expect(easternHHmm(resets)).toBe('00:00')
		expect(since.getTime()).toBeLessThanOrEqual(now)
		expect(resets.getTime()).toBeGreaterThan(now)
		// ~24h apart in winter
		expect(resets.getTime() - since.getTime()).toBe(24 * 60 * 60 * 1000)
		// Midnight EST = 05:00 UTC
		expect(sinceIso).toBe('2025-01-15T05:00:00.000Z')
		expect(resetsAtIso).toBe('2025-01-16T05:00:00.000Z')
	})

	it('uses yesterday midnight ET when just before today midnight', () => {
		// 2025-01-15 00:00 EST is 05:00 UTC; 1 minute before that is still Jan 14 period
		// 2025-01-14 23:00 EST = 2025-01-15 04:00 UTC
		const now = Date.parse('2025-01-15T04:00:00.000Z')
		const { sinceIso, resetsAtIso } = getDailyQuotaWindow(now)

		expect(sinceIso).toBe('2025-01-14T05:00:00.000Z')
		expect(resetsAtIso).toBe('2025-01-15T05:00:00.000Z')
		expect(new Date(sinceIso).getTime()).toBeLessThanOrEqual(now)
		expect(new Date(resetsAtIso).getTime()).toBeGreaterThan(now)
	})

	it('includes the instant of reset in the new period', () => {
		const reset = Date.parse('2025-01-15T05:00:00.000Z')
		const { sinceIso, resetsAtIso } = getDailyQuotaWindow(reset)
		expect(sinceIso).toBe('2025-01-15T05:00:00.000Z')
		expect(resetsAtIso).toBe('2025-01-16T05:00:00.000Z')
	})

	it('handles EDT (summer) offset', () => {
		// 2025-07-15 14:00 EDT = 18:00 UTC (EDT = UTC-4)
		const now = Date.parse('2025-07-15T18:00:00.000Z')
		const { sinceIso, resetsAtIso } = getDailyQuotaWindow(now)
		// Midnight EDT = 04:00 UTC
		expect(sinceIso).toBe('2025-07-15T04:00:00.000Z')
		expect(resetsAtIso).toBe('2025-07-16T04:00:00.000Z')
		expect(easternHHmm(new Date(sinceIso))).toBe('00:00')
	})

	it('window length is 23h or 25h across DST transitions', () => {
		// Spring forward 2025: clocks jump 2:00 → 3:00 on March 9 in US
		const beforeSpring = Date.parse('2025-03-09T06:00:00.000Z')
		const w1 = getDailyQuotaWindow(beforeSpring)
		const afterSpring = Date.parse('2025-03-09T12:00:00.000Z')
		const w2 = getDailyQuotaWindow(afterSpring)
		const len1 = new Date(w1.resetsAtIso).getTime() - new Date(w1.sinceIso).getTime()
		const len2 = new Date(w2.resetsAtIso).getTime() - new Date(w2.sinceIso).getTime()
		expect([23, 24, 25].some((h) => len1 === h * 3600_000 || len2 === h * 3600_000)).toBe(true)
		expect(len1).toBeGreaterThan(22 * 3600_000)
		expect(len2).toBeGreaterThan(22 * 3600_000)
	})
})

describe('zonedWallTimeToUtc', () => {
	it('maps winter midnight Eastern to 05:00 UTC', () => {
		const d = zonedWallTimeToUtc(2025, 1, 15, DAILY_QUOTA_RESET_HOUR, DAILY_QUOTA_RESET_MINUTE)
		expect(d.toISOString()).toBe('2025-01-15T05:00:00.000Z')
	})

	it('maps summer midnight Eastern to 04:00 UTC', () => {
		const d = zonedWallTimeToUtc(2025, 7, 15, DAILY_QUOTA_RESET_HOUR, DAILY_QUOTA_RESET_MINUTE)
		expect(d.toISOString()).toBe('2025-07-15T04:00:00.000Z')
	})
})

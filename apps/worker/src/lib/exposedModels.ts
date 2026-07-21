import type { SupabaseClient } from '@supabase/supabase-js'
import { buildPublicModelId } from './modelId'
import { listAccessibleChannelIds } from './roles'

export type ExposedModelStat = {
	public_id: string
	total_requests: number
	success_rate: number | null
}

export type ListExposedOptions = {
	/** When set, only models on channels this role can access. */
	roleId?: string | null
	/** When true, filter by role access. When false/omitted, show all exposed (public). */
	filterByRole?: boolean
}

/**
 * Exposed models on active channels, with aggregate success stats.
 * Used by authenticated user dashboard (role-filtered) and public landing (all).
 */
export async function listExposedModelsWithStats(
	db: SupabaseClient,
	opts: ListExposedOptions = {},
): Promise<{ models: ExposedModelStat[]; error: string | null }> {
	const { data: models, error } = await db
		.from('models')
		.select('id, model_id, is_exposed, channel_id, channels(name, is_active)')
		.eq('is_exposed', true)
		.order('model_id')

	if (error) return { models: [], error: error.message }

	let allowedChannels: Set<string> | null = null
	if (opts.filterByRole) {
		try {
			const access = await listAccessibleChannelIds(db, opts.roleId)
			if (!access.allOpen) allowedChannels = access.allowedIds
		} catch (e) {
			return { models: [], error: e instanceof Error ? e.message : String(e) }
		}
	}

	const rows = (models ?? [])
		.map((m) => {
			const chRel = m.channels as
				| { name?: string; is_active?: boolean }
				| { name?: string; is_active?: boolean }[]
				| null
			const ch = Array.isArray(chRel) ? chRel[0] : chRel
			return {
				rowId: m.id as string,
				modelId: m.model_id as string,
				channelId: m.channel_id as string,
				ch,
			}
		})
		.filter((r) => {
			if (!r.ch?.is_active || !r.ch.name) return false
			if (allowedChannels && !allowedChannels.has(r.channelId)) return false
			return true
		})

	const statsMap = new Map<string, { total: number; errors: number }>()
	if (rows.length > 0) {
		const { data: stats } = await db
			.from('model_stats')
			.select('model_id, total_requests, total_errors')
			.in(
				'model_id',
				rows.map((r) => r.rowId),
			)
		for (const s of stats ?? []) {
			statsMap.set(s.model_id, {
				total: Number(s.total_requests),
				errors: Number(s.total_errors),
			})
		}
	}

	const list = rows.map((r) => {
		const st = statsMap.get(r.rowId)
		const total = st?.total ?? 0
		const errors = st?.errors ?? 0
		return {
			public_id: buildPublicModelId(r.ch!.name as string, r.modelId),
			total_requests: total,
			success_rate: total === 0 ? null : ((total - errors) / total) * 100,
		}
	})

	return { models: list, error: null }
}

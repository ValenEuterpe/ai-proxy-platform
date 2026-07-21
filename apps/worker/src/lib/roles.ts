import type { SupabaseClient } from '@supabase/supabase-js'
import type { Role, RoleLimits } from '../types'

export type { Role, RoleLimits }

/** Serialize a role row for API responses. */
export function mapRole(row: {
	id: string
	name: string
	requests_per_day: number | null
	requests_per_minute: number | null
	tokens_per_day?: number | null
	tokens_per_minute?: number | null
	is_default: boolean
	created_at?: string
}): Role {
	return {
		id: row.id,
		name: row.name,
		requests_per_day: row.requests_per_day ?? null,
		requests_per_minute: row.requests_per_minute ?? null,
		tokens_per_day: row.tokens_per_day ?? null,
		tokens_per_minute: row.tokens_per_minute ?? null,
		is_default: Boolean(row.is_default),
		created_at: row.created_at ?? '',
	}
}

export async function listRoles(db: SupabaseClient): Promise<Role[]> {
	const { data, error } = await db.from('roles').select('*').order('name')
	if (error) throw new Error(error.message)
	return (data ?? []).map(mapRole)
}

export async function getRoleById(db: SupabaseClient, id: string): Promise<Role | null> {
	const { data, error } = await db.from('roles').select('*').eq('id', id).maybeSingle()
	if (error) throw new Error(error.message)
	return data ? mapRole(data) : null
}

export async function getDefaultRole(db: SupabaseClient): Promise<Role | null> {
	const { data, error } = await db
		.from('roles')
		.select('*')
		.eq('is_default', true)
		.maybeSingle()
	if (error) throw new Error(error.message)
	return data ? mapRole(data) : null
}

/**
 * Resolve rate limits for a user from their role.
 * Falls back to the Default role if role_id is null/missing.
 */
export async function getUserRoleLimits(
	db: SupabaseClient,
	roleId: string | null | undefined,
): Promise<{ role: Role | null; limits: RoleLimits }> {
	let role: Role | null = null
	if (roleId) {
		role = await getRoleById(db, roleId)
	}
	if (!role) {
		role = await getDefaultRole(db)
	}
	return {
		role,
		limits: {
			requests_per_day: role?.requests_per_day ?? null,
			requests_per_minute: role?.requests_per_minute ?? null,
			tokens_per_day: role?.tokens_per_day ?? null,
			tokens_per_minute: role?.tokens_per_minute ?? null,
		},
	}
}

/**
 * Channel access:
 * - No rows in channel_roles → open to all roles
 * - One or more rows → user's role_id must be listed
 * - User with null role_id cannot access restricted channels
 */
export async function userCanAccessChannel(
	db: SupabaseClient,
	roleId: string | null | undefined,
	channelId: string,
): Promise<boolean> {
	const { data, error } = await db
		.from('channel_roles')
		.select('role_id')
		.eq('channel_id', channelId)
	if (error) throw new Error(error.message)

	const allowed = data ?? []
	if (allowed.length === 0) return true
	if (!roleId) return false
	return allowed.some((r) => r.role_id === roleId)
}

/**
 * Channel ids the role may use. Returns null when unrestricted (all channels open
 * for listing purposes — caller still filters by is_active/is_exposed).
 * When restricted set exists for some channels, returns the set of channel ids
 * that are either unrestricted OR explicitly allow this role.
 */
export async function listAccessibleChannelIds(
	db: SupabaseClient,
	roleId: string | null | undefined,
): Promise<{ allOpen: boolean; allowedIds: Set<string> }> {
	const { data: restricted, error } = await db
		.from('channel_roles')
		.select('channel_id, role_id')
	if (error) throw new Error(error.message)

	const byChannel = new Map<string, string[]>()
	for (const row of restricted ?? []) {
		const list = byChannel.get(row.channel_id) ?? []
		list.push(row.role_id)
		byChannel.set(row.channel_id, list)
	}

	if (byChannel.size === 0) {
		return { allOpen: true, allowedIds: new Set() }
	}

	const { data: channels, error: chErr } = await db.from('channels').select('id')
	if (chErr) throw new Error(chErr.message)

	const allowed = new Set<string>()
	for (const ch of channels ?? []) {
		const roles = byChannel.get(ch.id)
		if (!roles || roles.length === 0) {
			allowed.add(ch.id)
		} else if (roleId && roles.includes(roleId)) {
			allowed.add(ch.id)
		}
	}
	return { allOpen: false, allowedIds: allowed }
}

export async function setChannelRoles(
	db: SupabaseClient,
	channelId: string,
	roleIds: string[],
): Promise<void> {
	const unique = [...new Set(roleIds.filter((id) => typeof id === 'string' && id))]
	const { error: delErr } = await db.from('channel_roles').delete().eq('channel_id', channelId)
	if (delErr) throw new Error(delErr.message)
	if (unique.length === 0) return
	const { error: insErr } = await db.from('channel_roles').insert(
		unique.map((role_id) => ({ channel_id: channelId, role_id })),
	)
	if (insErr) throw new Error(insErr.message)
}

export async function getChannelRoleIds(
	db: SupabaseClient,
	channelId: string,
): Promise<string[]> {
	const { data, error } = await db
		.from('channel_roles')
		.select('role_id')
		.eq('channel_id', channelId)
	if (error) throw new Error(error.message)
	return (data ?? []).map((r) => r.role_id as string)
}

/** Map of channel_id → role_id[] for list views. */
export async function getChannelRolesMap(
	db: SupabaseClient,
): Promise<Map<string, string[]>> {
	const { data, error } = await db.from('channel_roles').select('channel_id, role_id')
	if (error) throw new Error(error.message)
	const map = new Map<string, string[]>()
	for (const row of data ?? []) {
		const list = map.get(row.channel_id) ?? []
		list.push(row.role_id)
		map.set(row.channel_id, list)
	}
	return map
}

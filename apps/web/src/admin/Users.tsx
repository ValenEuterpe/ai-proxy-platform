import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type AdminUser, type Role } from '../lib/api'
import { UserDetailModal } from './UserDetail'

type SortKey =
	| 'discord_username'
	| 'discord_id'
	| 'role_name'
	| 'registered_at'
	| 'last_ip'
	| 'is_active'
	| 'log_user_prompt'
	| 'disable_reason'

function reasonSortValue(u: AdminUser): string {
	if (u.is_active) return ''
	if (u.disable_reason === 'admin' || u.admin_disabled) return 'admin'
	return 'guild'
}

export default function UsersPage() {
	const [users, setUsers] = useState<AdminUser[]>([])
	const [roles, setRoles] = useState<Role[]>([])
	const [q, setQ] = useState('')
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [sortKey, setSortKey] = useState<SortKey>('registered_at')
	const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
	const [selectedUserId, setSelectedUserId] = useState<string | null>(null)

	const load = useCallback(async (filter?: string) => {
		setError(null)
		try {
			const [usersRes, rolesRes] = await Promise.all([
				api.listUsers(filter || undefined),
				api.listRoles(),
			])
			setUsers(usersRes.users)
			setRoles(rolesRes.roles)
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Failed to load users')
		} finally {
			setLoading(false)
		}
	}, [])

	useEffect(() => {
		const t = setTimeout(() => {
			setLoading(true)
			void load(q.trim())
		}, 250)
		return () => clearTimeout(t)
	}, [q, load])

	const sorted = useMemo(() => {
		const copy = [...users]
		copy.sort((a, b) => {
			let cmp = 0
			switch (sortKey) {
				case 'discord_username':
					cmp = (a.discord_username ?? '').localeCompare(b.discord_username ?? '')
					break
				case 'discord_id':
					cmp = a.discord_id.localeCompare(b.discord_id)
					break
				case 'role_name':
					cmp = (a.role_name ?? '').localeCompare(b.role_name ?? '')
					break
				case 'registered_at':
					cmp =
						new Date(a.registered_at).getTime() - new Date(b.registered_at).getTime()
					break
				case 'last_ip':
					cmp = (a.last_ip ?? '').localeCompare(b.last_ip ?? '')
					break
				case 'is_active':
					cmp = Number(a.is_active) - Number(b.is_active)
					break
				case 'log_user_prompt':
					cmp = Number(Boolean(a.log_user_prompt)) - Number(Boolean(b.log_user_prompt))
					break
				case 'disable_reason':
					cmp = reasonSortValue(a).localeCompare(reasonSortValue(b))
					break
			}
			return sortDir === 'asc' ? cmp : -cmp
		})
		return copy
	}, [users, sortKey, sortDir])

	function toggleSort(key: SortKey) {
		if (sortKey === key) {
			setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
		} else {
			setSortKey(key)
			setSortDir(key === 'registered_at' ? 'desc' : 'asc')
		}
	}

	function sortIndicator(key: SortKey) {
		if (sortKey === key) return sortDir === 'asc' ? '↑' : '↓'
		return '↕'
	}

	function SortHeader({
		label,
		column,
	}: {
		label: string
		column: SortKey
	}) {
		return (
			<th className="px-3 py-2 font-medium">
				<button
					type="button"
					onClick={() => toggleSort(column)}
					className="inline-flex items-center gap-1 hover:text-zinc-200"
				>
					{label}
					<span className={sortKey === column ? 'text-zinc-200' : 'text-zinc-600'}>
						{sortIndicator(column)}
					</span>
				</button>
			</th>
		)
	}

	async function toggleActive(u: AdminUser) {
		try {
			const res = await api.patchUser(u.id, { is_active: !u.is_active })
			setUsers((prev) => prev.map((x) => (x.id === u.id ? res.user : x)))
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Update failed')
		}
	}

	async function toggleLogPrompt(u: AdminUser) {
		try {
			const res = await api.patchUser(u.id, {
				log_user_prompt: !Boolean(u.log_user_prompt),
			})
			setUsers((prev) => prev.map((x) => (x.id === u.id ? res.user : x)))
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Prompt logging update failed')
		}
	}

	async function changeRole(u: AdminUser, roleId: string) {
		if (roleId === u.role_id) return
		try {
			const res = await api.patchUser(u.id, { role_id: roleId })
			setUsers((prev) => prev.map((x) => (x.id === u.id ? res.user : x)))
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Role update failed')
		}
	}

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-semibold text-white">Users</h1>
				<p className="text-sm text-zinc-400 mt-1">
					Discord accounts with issued API keys. Role controls rate limits and channel
					access. Disable blocks proxy access immediately.
				</p>
			</div>

			<div className="flex gap-2">
				<input
					className="w-full max-w-sm rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white"
					placeholder="Filter by username or Discord ID"
					value={q}
					onChange={(e) => setQ(e.target.value)}
				/>
			</div>

			{error && (
				<div className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
					{error}
				</div>
			)}

			{loading ? (
				<p className="text-sm text-zinc-500">Loading…</p>
			) : users.length === 0 ? (
				<p className="text-sm text-zinc-500">No users yet.</p>
			) : (
				<div className="overflow-x-auto rounded-xl border border-zinc-800">
					<table className="w-full text-sm text-left">
						<thead className="bg-zinc-900 text-zinc-400">
							<tr>
								<SortHeader label="Username" column="discord_username" />
								<SortHeader label="Discord ID" column="discord_id" />
								<SortHeader label="Role" column="role_name" />
								<SortHeader label="Registered" column="registered_at" />
								<SortHeader label="Last IP" column="last_ip" />
								<SortHeader label="Active" column="is_active" />
								<SortHeader label="Log prompts" column="log_user_prompt" />
								<SortHeader label="Reason" column="disable_reason" />
								<th className="px-3 py-2 font-medium" />
							</tr>
						</thead>
						<tbody className="divide-y divide-zinc-800">
							{sorted.map((u) => (
								<tr
									key={u.id}
									className="bg-zinc-950/40 cursor-pointer hover:bg-zinc-900/60"
									onClick={() => setSelectedUserId(u.id)}
								>
									<td className="px-3 py-2 text-white">{u.discord_username ?? '—'}</td>
									<td className="px-3 py-2 font-mono text-xs text-zinc-400">
										{u.discord_id}
									</td>
									<td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
										{roles.length === 0 ? (
											<span className="text-xs text-zinc-500">
												{u.role_name ?? '—'}
											</span>
										) : (
											<select
												className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-white max-w-[140px]"
												value={u.role_id ?? ''}
												onChange={(e) => void changeRole(u, e.target.value)}
											>
												{!u.role_id && (
													<option value="" disabled>
														Unassigned
													</option>
												)}
												{roles.map((r) => (
													<option key={r.id} value={r.id}>
														{r.name}
														{r.is_default ? ' (default)' : ''}
													</option>
												))}
											</select>
										)}
									</td>
									<td className="px-3 py-2 text-zinc-300">
										{new Date(u.registered_at).toLocaleString()}
									</td>
									<td className="px-3 py-2 font-mono text-xs text-zinc-400">
										{u.last_ip ?? '—'}
									</td>
									<td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
										<button
											type="button"
											onClick={() => void toggleActive(u)}
											className={`rounded-full px-2 py-0.5 text-xs ${
												u.is_active
													? 'bg-emerald-950 text-emerald-300'
													: 'bg-zinc-800 text-zinc-400'
											}`}
										>
											{u.is_active ? 'Active' : 'Disabled'}
										</button>
									</td>
									<td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
										<button
											type="button"
											title="Store this user's prompts even if global logging is off"
											onClick={() => void toggleLogPrompt(u)}
											className={`rounded-full px-2 py-0.5 text-xs ${
												u.log_user_prompt
													? 'bg-violet-950 text-violet-300'
													: 'bg-zinc-800 text-zinc-400'
											}`}
										>
											{u.log_user_prompt ? 'On' : 'Off'}
										</button>
									</td>
									<td className="px-3 py-2">
										{u.is_active ? (
											<span className="text-xs text-zinc-600">—</span>
										) : u.disable_reason === 'admin' || u.admin_disabled ? (
											<span className="rounded-full bg-amber-950/80 text-amber-300 px-2 py-0.5 text-[10px]">
												Admin
											</span>
										) : (
											<span className="rounded-full bg-zinc-800 text-zinc-400 px-2 py-0.5 text-[10px]">
												Not in server
											</span>
										)}
									</td>
									<td
										className="px-3 py-2 text-right"
										onClick={(e) => e.stopPropagation()}
									>
										<Link
											to={`/admin/logs?user_id=${u.id}`}
											className="text-xs text-violet-400 hover:underline"
										>
											Logs
										</Link>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			{selectedUserId && (
				<UserDetailModal
					userId={selectedUserId}
					roles={roles}
					onClose={() => setSelectedUserId(null)}
					onUserUpdated={(updated) => {
						setUsers((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))
					}}
				/>
			)}
		</div>
	)
}

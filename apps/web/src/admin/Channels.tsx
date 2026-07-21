import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, type ChannelRow, type Role } from '../lib/api'

type Discovered = { id: string; name?: string; selected: boolean }

type EditState = {
	id: string
	name: string
	baseUrl: string
	apiKey: string
	discovered: Discovered[] | null
	roleIds: string[]
	busy: boolean
	error: string | null
}

function RoleCheckboxes({
	roles,
	selected,
	onChange,
}: {
	roles: Role[]
	selected: string[]
	onChange: (ids: string[]) => void
}) {
	if (roles.length === 0) {
		return (
			<p className="text-xs text-zinc-500">
				No roles yet — create them under Settings. Empty selection = all roles can use this
				channel.
			</p>
		)
	}
	return (
		<div className="space-y-2">
			<p className="text-xs text-zinc-500">
				Leave all unchecked so every role can access this channel. Check one or more to
				restrict access.
			</p>
			<div className="flex flex-wrap gap-3">
				{roles.map((r) => {
					const checked = selected.includes(r.id)
					return (
						<label
							key={r.id}
							className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-200 cursor-pointer"
						>
							<input
								type="checkbox"
								checked={checked}
								onChange={(e) => {
									if (e.target.checked) onChange([...selected, r.id])
									else onChange(selected.filter((id) => id !== r.id))
								}}
							/>
							<span>
								{r.name}
								{r.is_default ? (
									<span className="text-zinc-500"> (default)</span>
								) : null}
							</span>
						</label>
					)
				})}
			</div>
		</div>
	)
}

function rolesLabel(ch: ChannelRow, roles: Role[]): string {
	const ids = ch.role_ids ?? []
	if (ids.length === 0) return 'All roles'
	const names = ids
		.map((id) => roles.find((r) => r.id === id)?.name ?? id.slice(0, 6))
		.join(', ')
	return names || `${ids.length} role(s)`
}

export default function ChannelsPage() {
	const [channels, setChannels] = useState<ChannelRow[]>([])
	const [roles, setRoles] = useState<Role[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)

	const [name, setName] = useState('')
	const [baseUrl, setBaseUrl] = useState('')
	const [apiKey, setApiKey] = useState('')
	const [createRoleIds, setCreateRoleIds] = useState<string[]>([])
	const [discovered, setDiscovered] = useState<Discovered[] | null>(null)
	const [busy, setBusy] = useState(false)
	const [formError, setFormError] = useState<string | null>(null)

	const [edit, setEdit] = useState<EditState | null>(null)

	const load = useCallback(async () => {
		setError(null)
		try {
			const [chRes, rolesRes] = await Promise.all([api.listChannels(), api.listRoles()])
			setChannels(chRes.channels)
			setRoles(rolesRes.roles)
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Failed to load channels')
		} finally {
			setLoading(false)
		}
	}, [])

	useEffect(() => {
		void load()
	}, [load])

	async function testConnection(e: FormEvent) {
		e.preventDefault()
		setFormError(null)
		setBusy(true)
		setDiscovered(null)
		try {
			const res = await api.testChannel(baseUrl, apiKey)
			setDiscovered(res.models.map((m) => ({ ...m, selected: false })))
		} catch (err) {
			setFormError(err instanceof Error ? err.message : 'Test failed')
		} finally {
			setBusy(false)
		}
	}

	async function saveChannel() {
		if (!discovered) return
		setFormError(null)
		setBusy(true)
		try {
			await api.createChannel({
				name,
				base_url: baseUrl,
				api_key: apiKey,
				models: discovered.map((m) => ({
					id: m.id,
					name: m.name,
					is_exposed: m.selected,
				})),
				role_ids: createRoleIds,
			})
			setName('')
			setBaseUrl('')
			setApiKey('')
			setCreateRoleIds([])
			setDiscovered(null)
			await load()
		} catch (err) {
			setFormError(err instanceof Error ? err.message : 'Save failed')
		} finally {
			setBusy(false)
		}
	}

	async function toggleActive(ch: ChannelRow) {
		try {
			await api.patchChannel(ch.id, { is_active: !ch.is_active })
			await load()
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Update failed')
		}
	}

	async function remove(ch: ChannelRow) {
		const ok = window.confirm(
			`Delete channel "${ch.name}"?\n\nRemoves this channel and its models/model stats.\nRequest logs are kept for statistics (model name stays; channel link on those logs is cleared).`,
		)
		if (!ok) return
		try {
			await api.deleteChannel(ch.id)
			await load()
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Delete failed')
		}
	}

	async function openEdit(ch: ChannelRow) {
		setEdit({
			id: ch.id,
			name: ch.name,
			baseUrl: ch.base_url,
			apiKey: '',
			discovered: null,
			roleIds: ch.role_ids ?? [],
			busy: true,
			error: null,
		})
		try {
			const res = await api.getChannel(ch.id)
			const models = res.models.map((m) => ({
				id: m.model_id,
				name: m.display_name ?? undefined,
				selected: m.is_exposed,
			}))
			setEdit({
				id: ch.id,
				name: res.channel.name,
				baseUrl: res.channel.base_url,
				apiKey: res.channel.api_key,
				discovered: models,
				roleIds: res.channel.role_ids ?? [],
				busy: false,
				error: null,
			})
		} catch (err) {
			setEdit((prev) =>
				prev
					? {
							...prev,
							busy: false,
							error: err instanceof Error ? err.message : 'Failed to load channel',
						}
					: null,
			)
		}
	}

	async function testEditConnection() {
		if (!edit) return
		setEdit((e) => (e ? { ...e, busy: true, error: null } : e))
		try {
			const res = await api.testChannel(edit.baseUrl, edit.apiKey)
			const prevSelected = new Map((edit.discovered ?? []).map((m) => [m.id, m.selected]))
			setEdit((e) =>
				e
					? {
							...e,
							busy: false,
							discovered: res.models.map((m) => ({
								...m,
								selected: prevSelected.get(m.id) ?? false,
							})),
						}
					: e,
			)
		} catch (err) {
			setEdit((e) =>
				e
					? {
							...e,
							busy: false,
							error: err instanceof Error ? err.message : 'Test failed',
						}
					: e,
			)
		}
	}

	async function saveEdit() {
		if (!edit) return
		setEdit((e) => (e ? { ...e, busy: true, error: null } : e))
		try {
			await api.patchChannel(edit.id, {
				name: edit.name,
				base_url: edit.baseUrl,
				api_key: edit.apiKey,
				models: (edit.discovered ?? []).map((m) => ({
					id: m.id,
					name: m.name,
					is_exposed: m.selected,
				})),
				role_ids: edit.roleIds,
			})
			setEdit(null)
			await load()
		} catch (err) {
			setEdit((e) =>
				e
					? {
							...e,
							busy: false,
							error: err instanceof Error ? err.message : 'Save failed',
						}
					: e,
			)
		}
	}

	function toggleAll(selected: boolean, list: Discovered[] | null, setList: (d: Discovered[]) => void) {
		if (!list) return
		setList(list.map((m) => ({ ...m, selected })))
	}

	return (
		<div className="space-y-8">
			<div>
				<h1 className="text-2xl font-semibold text-white">Channels</h1>
				<p className="text-sm text-zinc-400 mt-1">
					Connect OpenAI-compatible providers. Optionally restrict each channel to specific
					roles (empty = all roles).
				</p>
			</div>

			{error && (
				<div className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
					{error}
				</div>
			)}

			<section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 md:p-5">
				<h2 className="text-lg font-medium text-white mb-4">Add channel</h2>
				<form onSubmit={testConnection} className="grid gap-3 md:grid-cols-2">
					<div className="md:col-span-2">
						<label className="block text-xs text-zinc-400 mb-1">Name</label>
						<input
							className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="openrouter"
							required
						/>
						<p className="mt-1 text-xs text-zinc-500">
							Used as the model prefix users call (
							<span className="font-mono">name/model-id</span>). No slashes; must be unique.
						</p>
					</div>
					<div>
						<label className="block text-xs text-zinc-400 mb-1">Base URL</label>
						<input
							className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white"
							value={baseUrl}
							onChange={(e) => setBaseUrl(e.target.value)}
							placeholder="https://openrouter.ai/api"
							required
						/>
					</div>
					<div>
						<label className="block text-xs text-zinc-400 mb-1">API key</label>
						<input
							type="password"
							className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white"
							value={apiKey}
							onChange={(e) => setApiKey(e.target.value)}
							required
						/>
					</div>
					<div className="md:col-span-2">
						<label className="block text-xs text-zinc-400 mb-1">Allowed roles</label>
						<RoleCheckboxes
							roles={roles}
							selected={createRoleIds}
							onChange={setCreateRoleIds}
						/>
					</div>
					<div className="md:col-span-2 flex flex-wrap gap-2">
						<button
							type="submit"
							disabled={busy}
							className="rounded-lg bg-zinc-100 text-zinc-900 px-4 py-2 text-sm font-medium disabled:opacity-50"
						>
							{busy && !discovered ? 'Testing…' : 'Test connection'}
						</button>
						{discovered && (
							<button
								type="button"
								disabled={busy}
								onClick={() => void saveChannel()}
								className="rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
							>
								Save channel
							</button>
						)}
					</div>
				</form>
				{formError && <p className="mt-3 text-sm text-red-400">{formError}</p>}

				{discovered && (
					<div className="mt-5">
						<div className="flex items-center justify-between mb-2">
							<p className="text-sm text-zinc-300">
								{discovered.length} models found — check to expose
							</p>
							<div className="flex gap-2 text-xs">
								<button
									type="button"
									className="text-violet-400 hover:underline"
									onClick={() => toggleAll(true, discovered, (d) => setDiscovered(d))}
								>
									Select all
								</button>
								<button
									type="button"
									className="text-zinc-400 hover:underline"
									onClick={() => toggleAll(false, discovered, (d) => setDiscovered(d))}
								>
									Clear
								</button>
							</div>
						</div>
						<div className="max-h-64 overflow-auto rounded-lg border border-zinc-800">
							<ul className="divide-y divide-zinc-800 text-sm">
								{discovered.map((m) => (
									<li key={m.id} className="flex items-center gap-2 px-3 py-2">
										<input
											type="checkbox"
											checked={m.selected}
											onChange={(e) =>
												setDiscovered(
													(prev) =>
														prev?.map((x) =>
															x.id === m.id
																? { ...x, selected: e.target.checked }
																: x,
														) ?? null,
												)
											}
										/>
										<span className="font-mono text-zinc-200">{m.id}</span>
										{m.name && m.name !== m.id && (
											<span className="text-zinc-500 truncate">{m.name}</span>
										)}
									</li>
								))}
							</ul>
						</div>
					</div>
				)}
			</section>

			<section>
				<h2 className="text-lg font-medium text-white mb-3">Connected</h2>
				{loading ? (
					<p className="text-sm text-zinc-500">Loading…</p>
				) : channels.length === 0 ? (
					<p className="text-sm text-zinc-500">No channels yet.</p>
				) : (
					<div className="overflow-x-auto rounded-xl border border-zinc-800">
						<table className="w-full text-sm text-left">
							<thead className="bg-zinc-900 text-zinc-400">
								<tr>
									<th className="px-3 py-2 font-medium">Name</th>
									<th className="px-3 py-2 font-medium">URL</th>
									<th className="px-3 py-2 font-medium">Key</th>
									<th className="px-3 py-2 font-medium">Models</th>
									<th className="px-3 py-2 font-medium">Roles</th>
									<th className="px-3 py-2 font-medium">Active</th>
									<th className="px-3 py-2 font-medium" />
								</tr>
							</thead>
							<tbody className="divide-y divide-zinc-800">
								{channels.map((ch) => (
									<tr key={ch.id} className="bg-zinc-950/40">
										<td className="px-3 py-2 text-white">{ch.name}</td>
										<td className="px-3 py-2 font-mono text-xs text-zinc-400 max-w-[200px] truncate">
											{ch.base_url}
										</td>
										<td className="px-3 py-2 font-mono text-xs text-zinc-500">
											{ch.api_key_masked}
										</td>
										<td className="px-3 py-2">{ch.model_count}</td>
										<td className="px-3 py-2 text-xs text-zinc-300 max-w-[160px]">
											{(ch.role_ids ?? []).length === 0 ? (
												<span className="text-zinc-500">All roles</span>
											) : (
												<span title={rolesLabel(ch, roles)}>
													{rolesLabel(ch, roles)}
												</span>
											)}
										</td>
										<td className="px-3 py-2">
											<button
												type="button"
												onClick={() => void toggleActive(ch)}
												className={`rounded-full px-2 py-0.5 text-xs ${
													ch.is_active
														? 'bg-emerald-950 text-emerald-300'
														: 'bg-zinc-800 text-zinc-400'
												}`}
											>
												{ch.is_active ? 'On' : 'Off'}
											</button>
										</td>
										<td className="px-3 py-2 text-right space-x-3 whitespace-nowrap">
											<button
												type="button"
												onClick={() => void openEdit(ch)}
												className="text-xs text-violet-400 hover:underline"
											>
												Edit
											</button>
											<button
												type="button"
												onClick={() => void remove(ch)}
												className="text-xs text-red-400 hover:underline"
											>
												Delete
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>

			{edit && (
				<div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 pt-12">
					<div className="w-full max-w-2xl rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-xl">
						<div className="flex items-center justify-between mb-4">
							<h2 className="text-lg font-medium text-white">Edit channel</h2>
							<button
								type="button"
								className="text-sm text-zinc-400 hover:text-white"
								onClick={() => setEdit(null)}
							>
								Close
							</button>
						</div>
						<div className="grid gap-3 md:grid-cols-2">
							<div className="md:col-span-2">
								<label className="block text-xs text-zinc-400 mb-1">Name</label>
								<input
									className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white"
									value={edit.name}
									onChange={(e) => setEdit({ ...edit, name: e.target.value })}
								/>
							</div>
							<div>
								<label className="block text-xs text-zinc-400 mb-1">Base URL</label>
								<input
									className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white"
									value={edit.baseUrl}
									onChange={(e) => setEdit({ ...edit, baseUrl: e.target.value })}
								/>
							</div>
							<div>
								<label className="block text-xs text-zinc-400 mb-1">API key</label>
								<input
									type="password"
									className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white"
									value={edit.apiKey}
									onChange={(e) => setEdit({ ...edit, apiKey: e.target.value })}
								/>
							</div>
							<div className="md:col-span-2">
								<label className="block text-xs text-zinc-400 mb-1">Allowed roles</label>
								<RoleCheckboxes
									roles={roles}
									selected={edit.roleIds}
									onChange={(ids) => setEdit({ ...edit, roleIds: ids })}
								/>
							</div>
							<div className="md:col-span-2 flex flex-wrap gap-2">
								<button
									type="button"
									disabled={edit.busy}
									onClick={() => void testEditConnection()}
									className="rounded-lg bg-zinc-100 text-zinc-900 px-4 py-2 text-sm font-medium disabled:opacity-50"
								>
									{edit.busy ? 'Working…' : 'Re-test & refresh models'}
								</button>
								<button
									type="button"
									disabled={edit.busy}
									onClick={() => void saveEdit()}
									className="rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
								>
									Save changes
								</button>
							</div>
						</div>
						{edit.error && <p className="mt-3 text-sm text-red-400">{edit.error}</p>}
						{edit.discovered && (
							<div className="mt-5">
								<div className="flex items-center justify-between mb-2">
									<p className="text-sm text-zinc-300">
										{edit.discovered.length} models — check to expose
									</p>
									<div className="flex gap-2 text-xs">
										<button
											type="button"
											className="text-violet-400 hover:underline"
											onClick={() =>
												setEdit({
													...edit,
													discovered: edit.discovered!.map((m) => ({
														...m,
														selected: true,
													})),
												})
											}
										>
											Select all
										</button>
										<button
											type="button"
											className="text-zinc-400 hover:underline"
											onClick={() =>
												setEdit({
													...edit,
													discovered: edit.discovered!.map((m) => ({
														...m,
														selected: false,
													})),
												})
											}
										>
											Clear
										</button>
									</div>
								</div>
								<div className="max-h-72 overflow-auto rounded-lg border border-zinc-800">
									<ul className="divide-y divide-zinc-800 text-sm">
										{edit.discovered.map((m) => (
											<li key={m.id} className="flex items-center gap-2 px-3 py-2">
												<input
													type="checkbox"
													checked={m.selected}
													onChange={(e) =>
														setEdit({
															...edit,
															discovered: edit.discovered!.map((x) =>
																x.id === m.id
																	? { ...x, selected: e.target.checked }
																	: x,
															),
														})
													}
												/>
												<span className="font-mono text-zinc-200">{m.id}</span>
											</li>
										))}
									</ul>
								</div>
							</div>
						)}
					</div>
				</div>
			)}
		</div>
	)
}

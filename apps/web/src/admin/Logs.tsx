import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, type AdminLog, type AdminUser } from '../lib/api'

type ModelOption = {
	id: string
	public_id: string
}

type SortKey =
	| 'created_at'
	| 'user'
	| 'model_id'
	| 'ip_address'
	| 'status_code'
	| 'tokens'

type ViewTab = 'all' | 'csam' | 'csam_unreviewed'

function contentLabel(value: unknown): string {
	if (value === null || value === undefined) return 'not logged'
	return 'logged'
}

function formatJson(value: unknown): string {
	if (value === null || value === undefined) return 'null'
	if (typeof value === 'string') return value
	try {
		return JSON.stringify(value, null, 2)
	} catch {
		return String(value)
	}
}

function userLabel(log: AdminLog): string {
	return log.discord_username ?? log.discord_id ?? log.user_id ?? ''
}

function tokenTotal(log: AdminLog): number {
	return (log.prompt_tokens ?? 0) + (log.completion_tokens ?? 0)
}

function openDatePicker(e: MouseEvent<HTMLInputElement>) {
	const el = e.currentTarget
	try {
		el.showPicker?.()
	} catch {
		// ignore browsers that block showPicker without a direct gesture edge case
	}
}

function tabFromParams(sp: URLSearchParams): ViewTab {
	const t = sp.get('tab')
	if (t === 'csam' || t === 'csam_unreviewed') return t
	if (sp.get('csam') === '1' && sp.get('csam_reviewed') === '0') return 'csam_unreviewed'
	if (sp.get('csam') === '1') return 'csam'
	return 'all'
}

export default function LogsPage() {
	const [searchParams, setSearchParams] = useSearchParams()
	const [logs, setLogs] = useState<AdminLog[]>([])
	const [users, setUsers] = useState<AdminUser[]>([])
	const [models, setModels] = useState<ModelOption[]>([])
	const [total, setTotal] = useState(0)
	const [page, setPage] = useState(1)
	const [userId, setUserId] = useState(searchParams.get('user_id') ?? '')
	const [modelId, setModelId] = useState('')
	const [from, setFrom] = useState('')
	const [to, setTo] = useState('')
	const [errorsOnly, setErrorsOnly] = useState(
		searchParams.get('errors_only') === '1' || searchParams.get('errors_only') === 'true',
	)
	const [tab, setTab] = useState<ViewTab>(() => tabFromParams(searchParams))
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [expanded, setExpanded] = useState<number | null>(null)
	const [copiedId, setCopiedId] = useState<number | null>(null)
	const [sortKey, setSortKey] = useState<SortKey>('created_at')
	const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
	const [reviewNote, setReviewNote] = useState<Record<number, string>>({})
	const [reviewBusy, setReviewBusy] = useState<number | null>(null)
	const [pruneOpen, setPruneOpen] = useState(false)
	const [pruneBusy, setPruneBusy] = useState(false)
	const [pruneMsg, setPruneMsg] = useState<string | null>(null)

	const pageSize = 50
	const totalPages = Math.max(1, Math.ceil(total / pageSize))

	useEffect(() => {
		void Promise.all([api.listUsers(), api.listModels()])
			.then(([usersRes, modelsRes]) => {
				setUsers(usersRes.users)
				const opts = modelsRes.models.map((m) => ({
					id: m.id,
					public_id: m.channel_name ? `${m.channel_name}/${m.model_id}` : m.model_id,
				}))
				opts.sort((a, b) => a.public_id.localeCompare(b.public_id))
				setModels(opts)
			})
			.catch(() => undefined)
	}, [])

	const load = useCallback(async () => {
		setLoading(true)
		setError(null)
		try {
			const res = await api.listLogs({
				page,
				user_id: userId || undefined,
				model_id: modelId || undefined,
				from: from ? new Date(from).toISOString() : undefined,
				to: to ? new Date(to + 'T23:59:59').toISOString() : undefined,
				errors_only: errorsOnly || undefined,
				csam: tab === 'csam' || tab === 'csam_unreviewed' || undefined,
				csam_reviewed: tab === 'csam_unreviewed' ? false : undefined,
			})
			setLogs(res.logs)
			setTotal(res.total)
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Failed to load logs')
		} finally {
			setLoading(false)
		}
	}, [page, userId, modelId, from, to, errorsOnly, tab])

	useEffect(() => {
		void load()
	}, [load])

	const sorted = useMemo(() => {
		const copy = [...logs]
		copy.sort((a, b) => {
			let cmp = 0
			switch (sortKey) {
				case 'created_at':
					cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
					break
				case 'user':
					cmp = userLabel(a).localeCompare(userLabel(b))
					break
				case 'model_id':
					cmp = (a.model_id ?? '').localeCompare(b.model_id ?? '')
					break
				case 'ip_address':
					cmp = (a.ip_address ?? '').localeCompare(b.ip_address ?? '')
					break
				case 'status_code':
					cmp = (a.status_code ?? -1) - (b.status_code ?? -1)
					break
				case 'tokens':
					cmp = tokenTotal(a) - tokenTotal(b)
					break
			}
			return sortDir === 'asc' ? cmp : -cmp
		})
		return copy
	}, [logs, sortKey, sortDir])

	function toggleSort(key: SortKey) {
		if (sortKey === key) {
			setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
		} else {
			setSortKey(key)
			setSortDir(key === 'created_at' || key === 'tokens' || key === 'status_code' ? 'desc' : 'asc')
		}
	}

	function sortIndicator(key: SortKey) {
		if (sortKey === key) return sortDir === 'asc' ? '↑' : '↓'
		return '↕'
	}

	function SortHeader({ label, column }: { label: string; column: SortKey }) {
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

	function syncSearchParams(nextTab: ViewTab, nextUserId: string, nextErrors: boolean) {
		const next = new URLSearchParams()
		if (nextUserId) next.set('user_id', nextUserId)
		if (nextErrors) next.set('errors_only', '1')
		if (nextTab === 'csam') next.set('tab', 'csam')
		if (nextTab === 'csam_unreviewed') next.set('tab', 'csam_unreviewed')
		setSearchParams(next)
	}

	function applyFilters(e: { preventDefault: () => void }) {
		e.preventDefault()
		setPage(1)
		syncSearchParams(tab, userId, errorsOnly)
	}

	function changeTab(next: ViewTab) {
		setTab(next)
		setPage(1)
		setExpanded(null)
		syncSearchParams(next, userId, errorsOnly)
	}

	async function copyLog(log: AdminLog) {
		const payload = {
			id: log.id,
			created_at: log.created_at,
			user: log.discord_username ?? log.discord_id ?? log.user_id,
			discord_id: log.discord_id,
			model_id: log.model_id,
			status_code: log.status_code,
			is_error: log.is_error,
			ip_address: log.ip_address,
			prompt_tokens: log.prompt_tokens,
			completion_tokens: log.completion_tokens,
			csam_flagged: log.csam_flagged,
			csam_reason: log.csam_reason,
			csam_snippet: log.csam_snippet,
			csam_source: log.csam_source,
			csam_reviewed: log.csam_reviewed,
			csam_review_note: log.csam_review_note,
			prompt_content: log.prompt_content,
			response_content: log.response_content,
		}
		await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
		setCopiedId(log.id)
		setTimeout(() => setCopiedId(null), 1500)
	}

	async function markReviewed(log: AdminLog, reviewed: boolean) {
		setReviewBusy(log.id)
		setError(null)
		try {
			const note = reviewNote[log.id]
			const res = await api.patchCsamReview(log.id, {
				reviewed,
				note: note !== undefined ? note : undefined,
			})
			setLogs((prev) => prev.map((l) => (l.id === log.id ? { ...l, ...res.log } : l)))
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Review update failed')
		} finally {
			setReviewBusy(null)
		}
	}

	type PruneMode = 'content' | 'csam' | 'csam_reviewed'

	const pruneLabels: Record<PruneMode, string> = {
		content: 'Strip logged content (prompt/response/snippet → null; keep metadata)',
		csam: 'Delete all CSAM-flagged log rows',
		csam_reviewed: 'Delete reviewed CSAM log rows only',
	}

	async function runPrune(mode: PruneMode) {
		setError(null)
		setPruneMsg(null)
		setPruneBusy(true)
		try {
			const preview = await api.pruneLogs({ mode, dry_run: true })
			if (preview.affected === 0) {
				setPruneMsg(`Nothing to prune for: ${mode}`)
				return
			}
			const ok = window.confirm(
				`${pruneLabels[mode]}\n\nThis will affect ${preview.affected} row(s).\nThis cannot be undone.\n\nContinue?`,
			)
			if (!ok) return

			let totalAffected = 0
			let complete = false
			// Loop until complete (server batches ~10k rows per request)
			for (let i = 0; i < 100; i++) {
				const res = await api.pruneLogs({ mode, dry_run: false })
				totalAffected += res.affected
				if (res.complete) {
					complete = true
					break
				}
			}
			setPruneMsg(
				complete
					? `Pruned ${totalAffected} row(s) (${mode}).`
					: `Pruned ${totalAffected} row(s) (${mode}); more may remain — run again.`,
			)
			setPage(1)
			await load()
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Prune failed')
		} finally {
			setPruneBusy(false)
		}
	}

	const tabBtn = (id: ViewTab, label: string) => (
		<button
			type="button"
			onClick={() => changeTab(id)}
			className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
				tab === id
					? 'bg-violet-600 text-white'
					: 'bg-zinc-900 text-zinc-400 hover:text-zinc-200 border border-zinc-800'
			}`}
		>
			{label}
		</button>
	)

	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h1 className="text-2xl font-semibold text-white">Logs</h1>
					<p className="text-sm text-zinc-400 mt-1">
						Request history. CSAM hits force prompt capture for review. Export/copy is manual —
						nothing is auto-reported.
					</p>
				</div>
				<button
					type="button"
					onClick={() => {
						setPruneOpen((v) => !v)
						setPruneMsg(null)
					}}
					className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-1.5 text-sm font-medium text-red-300 hover:bg-red-950/70"
				>
					{pruneOpen ? 'Close prune' : 'Prune'}
				</button>
			</div>

			{pruneOpen && (
				<div className="rounded-xl border border-red-900/40 bg-red-950/20 p-4 space-y-3">
					<p className="text-sm text-red-200/90">
						Permanently remove stored content or CSAM rows. No backup. Confirm shows the match
						count first.
					</p>
					<div className="flex flex-wrap gap-2">
						{(
							[
								['content', 'Logged content'],
								['csam', 'All CSAM rows'],
								['csam_reviewed', 'Reviewed CSAM'],
							] as const
						).map(([mode, label]) => (
							<button
								key={mode}
								type="button"
								disabled={pruneBusy}
								onClick={() => void runPrune(mode)}
								className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 hover:border-red-800 hover:text-red-200 disabled:opacity-50"
								title={pruneLabels[mode]}
							>
								{label}
							</button>
						))}
					</div>
					{pruneBusy && <p className="text-sm text-zinc-400">Pruning…</p>}
					{pruneMsg && <p className="text-sm text-emerald-400">{pruneMsg}</p>}
				</div>
			)}

			<div className="flex flex-wrap gap-2">
				{tabBtn('all', 'All')}
				{tabBtn('csam', 'CSAM')}
				{tabBtn('csam_unreviewed', 'CSAM unreviewed')}
			</div>

			<form
				onSubmit={applyFilters}
				className="grid gap-3 md:grid-cols-5 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4"
			>
				<div>
					<label className="block text-xs text-zinc-400 mb-1">User</label>
					<select
						className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-white"
						value={userId}
						onChange={(e) => {
							setUserId(e.target.value)
							setPage(1)
						}}
					>
						<option value="">All</option>
						{users.map((u) => (
							<option key={u.id} value={u.id}>
								{u.discord_username ?? u.discord_id}
							</option>
						))}
					</select>
				</div>
				<div>
					<label className="block text-xs text-zinc-400 mb-1">Model</label>
					<select
						className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-white"
						value={modelId}
						onChange={(e) => {
							setModelId(e.target.value)
							setPage(1)
						}}
					>
						<option value="">All</option>
						{models.map((m) => (
							<option key={m.id} value={m.public_id}>
								{m.public_id}
							</option>
						))}
					</select>
				</div>
				<div>
					<label className="block text-xs text-zinc-400 mb-1">From</label>
					<input
						type="date"
						className="date-input w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-white"
						value={from}
						onChange={(e) => setFrom(e.target.value)}
						onClick={openDatePicker}
					/>
				</div>
				<div>
					<label className="block text-xs text-zinc-400 mb-1">To</label>
					<input
						type="date"
						className="date-input w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-white"
						value={to}
						onChange={(e) => setTo(e.target.value)}
						onClick={openDatePicker}
					/>
				</div>
				<div className="flex flex-col justify-end gap-2">
					<label className="inline-flex items-center gap-2 text-sm text-zinc-300">
						<input
							type="checkbox"
							checked={errorsOnly}
							onChange={(e) => {
								setErrorsOnly(e.target.checked)
								setPage(1)
							}}
						/>
						Errors only
					</label>
					<button
						type="submit"
						className="rounded-lg bg-zinc-100 text-zinc-900 px-4 py-2 text-sm font-medium"
					>
						Apply filters
					</button>
				</div>
			</form>

			{error && (
				<div className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
					{error}
				</div>
			)}

			{loading ? (
				<p className="text-sm text-zinc-500">Loading…</p>
			) : logs.length === 0 ? (
				<p className="text-sm text-zinc-500">No logs.</p>
			) : (
				<>
					<div className="overflow-x-auto rounded-xl border border-zinc-800">
						<table className="w-full text-sm text-left">
							<thead className="bg-zinc-900 text-zinc-400">
								<tr>
									<SortHeader label="Time" column="created_at" />
									<SortHeader label="User" column="user" />
									<SortHeader label="Model" column="model_id" />
									<SortHeader label="IP" column="ip_address" />
									<SortHeader label="Status" column="status_code" />
									<th className="px-3 py-2 font-medium">CSAM</th>
									<SortHeader label="Tokens" column="tokens" />
									<th className="px-3 py-2 font-medium">Detail</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-zinc-800">
								{sorted.map((log) => {
									const isErr = log.is_error || (log.status_code ?? 0) >= 400
									const flagged = Boolean(log.csam_flagged)
									return (
										<tr key={log.id} className="bg-zinc-950/40 align-top">
											<td className="px-3 py-2 text-zinc-300 whitespace-nowrap">
												{new Date(log.created_at).toLocaleString()}
											</td>
											<td className="px-3 py-2 text-white">
												{log.user_id ? (
													<Link
														to={`/admin/users/${log.user_id}`}
														className="hover:text-violet-300 hover:underline"
													>
														{log.discord_username ?? log.discord_id ?? log.user_id}
													</Link>
												) : (
													(log.discord_username ?? log.discord_id ?? '—')
												)}
											</td>
											<td className="px-3 py-2 font-mono text-xs text-zinc-300">
												{log.model_id ?? '—'}
											</td>
											<td className="px-3 py-2 font-mono text-xs text-zinc-500">
												{log.ip_address ?? '—'}
											</td>
											<td className="px-3 py-2">
												<span className={isErr ? 'text-red-400' : 'text-emerald-400'}>
													{log.status_code ?? '—'}
												</span>
											</td>
											<td className="px-3 py-2">
												{flagged ? (
													<div className="space-y-0.5">
														<span
															className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${
																log.csam_reviewed
																	? 'bg-zinc-800 text-zinc-400'
																	: 'bg-amber-950 text-amber-300 border border-amber-900/50'
															}`}
														>
															{log.csam_reviewed ? 'Reviewed' : 'Flagged'}
														</span>
														{log.csam_reason && (
															<p
																className="text-[10px] text-zinc-500 font-mono max-w-[10rem] truncate"
																title={log.csam_reason}
															>
																{log.csam_reason}
															</p>
														)}
													</div>
												) : (
													<span className="text-zinc-600 text-xs">—</span>
												)}
											</td>
											<td className="px-3 py-2 text-zinc-400 text-xs">
												{log.prompt_tokens ?? '—'} / {log.completion_tokens ?? '—'}
											</td>
											<td className="px-3 py-2">
												<div className="flex flex-wrap gap-2">
													<button
														type="button"
														className="text-xs text-violet-400 hover:underline"
														onClick={() =>
															setExpanded(expanded === log.id ? null : log.id)
														}
													>
														{expanded === log.id ? 'Hide' : 'View'} (
														{contentLabel(log.prompt_content)} /{' '}
														{contentLabel(log.response_content)})
													</button>
													<button
														type="button"
														className="text-xs text-zinc-400 hover:underline"
														onClick={() => void copyLog(log)}
													>
														{copiedId === log.id ? 'Copied' : 'Copy export'}
													</button>
												</div>
												{expanded === log.id && (
													<div className="mt-2 space-y-3 max-w-xl">
														{flagged && (
															<div className="rounded-lg border border-amber-900/40 bg-amber-950/20 p-3 space-y-2">
																<p className="text-xs text-amber-200/90">
																	<span className="font-medium">Reason:</span>{' '}
																	<span className="font-mono">{log.csam_reason ?? '—'}</span>
																</p>
																{log.csam_snippet && (
																	<p className="text-xs text-zinc-400">
																		<span className="text-zinc-500">Snippet:</span>{' '}
																		{log.csam_snippet}
																	</p>
																)}
																{log.csam_source && (
																	<p className="text-[11px] text-zinc-500">
																		Source: {log.csam_source}
																	</p>
																)}
																<label className="block">
																	<span className="text-[11px] text-zinc-500">
																		Review note
																	</span>
																	<textarea
																		className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-200 min-h-[60px]"
																		value={
																			reviewNote[log.id] ?? log.csam_review_note ?? ''
																		}
																		onChange={(e) =>
																			setReviewNote((prev) => ({
																				...prev,
																				[log.id]: e.target.value,
																			}))
																		}
																		placeholder="Optional triage note…"
																	/>
																</label>
																<div className="flex flex-wrap gap-2">
																	<button
																		type="button"
																		disabled={reviewBusy === log.id}
																		onClick={() => void markReviewed(log, true)}
																		className="rounded bg-emerald-900/60 text-emerald-200 px-2 py-1 text-xs disabled:opacity-50"
																	>
																		{log.csam_reviewed ? 'Update reviewed' : 'Mark reviewed'}
																	</button>
																	{log.csam_reviewed && (
																		<button
																			type="button"
																			disabled={reviewBusy === log.id}
																			onClick={() => void markReviewed(log, false)}
																			className="rounded border border-zinc-700 text-zinc-400 px-2 py-1 text-xs disabled:opacity-50"
																		>
																			Unreview
																		</button>
																	)}
																	{log.user_id && (
																		<Link
																			to={`/admin/users/${log.user_id}`}
																			className="rounded border border-zinc-700 text-violet-300 px-2 py-1 text-xs hover:bg-zinc-900"
																		>
																			User / disable
																		</Link>
																	)}
																</div>
															</div>
														)}
														{isErr && log.response_content == null && (
															<p className="text-xs text-amber-400">
																No error body stored (older log before error capture, or
																empty upstream response).
															</p>
														)}
														<pre className="overflow-auto rounded bg-zinc-950 border border-zinc-800 p-2 text-[11px] text-zinc-400 whitespace-pre-wrap max-h-80">
															{log.prompt_content === null &&
															log.response_content === null
																? 'not logged'
																: formatJson({
																		prompt: log.prompt_content,
																		response: log.response_content,
																	})}
														</pre>
													</div>
												)}
											</td>
										</tr>
									)
								})}
							</tbody>
						</table>
					</div>

					<div className="flex items-center justify-between text-sm text-zinc-400">
						<span>
							Page {page} / {totalPages} · {total} total
						</span>
						<div className="flex gap-2">
							<button
								type="button"
								disabled={page <= 1}
								onClick={() => setPage((p) => Math.max(1, p - 1))}
								className="rounded-lg border border-zinc-700 px-3 py-1 disabled:opacity-40"
							>
								Prev
							</button>
							<button
								type="button"
								disabled={page >= totalPages}
								onClick={() => setPage((p) => p + 1)}
								className="rounded-lg border border-zinc-700 px-3 py-1 disabled:opacity-40"
							>
								Next
							</button>
						</div>
					</div>
				</>
			)}
		</div>
	)
}

import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, type AdminUser, type Role, type UsageWindow, type UserStats } from '../lib/api'

function formatCountdown(ms: number): string {
	if (ms <= 0) return '0:00:00'
	const totalSec = Math.floor(ms / 1000)
	const h = Math.floor(totalSec / 3600)
	const m = Math.floor((totalSec % 3600) / 60)
	const s = totalSec % 60
	return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function useCountdown(resetsAt: string | undefined): string | null {
	const [label, setLabel] = useState<string | null>(() => {
		if (!resetsAt) return null
		const ms = new Date(resetsAt).getTime() - Date.now()
		return formatCountdown(ms)
	})

	useEffect(() => {
		if (!resetsAt) {
			setLabel(null)
			return
		}
		const tick = () => {
			const ms = new Date(resetsAt).getTime() - Date.now()
			setLabel(formatCountdown(ms))
		}
		tick()
		const id = window.setInterval(tick, 1000)
		return () => window.clearInterval(id)
	}, [resetsAt])

	return label
}

function formatNum(n: number): string {
	return n.toLocaleString()
}

function UsageCard({
	title,
	subtitle,
	window: w,
	countdown,
	unit = 'successful',
	showErrors = true,
}: {
	title: string
	subtitle: string
	window: UsageWindow
	countdown?: string | null
	unit?: string
	showErrors?: boolean
}) {
	const pct = w.unlimited
		? Math.min(100, w.success > 0 ? 8 : 0)
		: w.limit && w.limit > 0
			? Math.min(100, (w.success / w.limit) * 100)
			: 0
	const barColor = w.unlimited
		? 'bg-violet-500'
		: pct >= 90
			? 'bg-red-500'
			: pct >= 70
				? 'bg-amber-500'
				: 'bg-emerald-500'

	return (
		<div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 flex flex-col gap-3">
			<div className="flex items-start justify-between gap-2">
				<div>
					<p className="text-sm font-medium text-white flex items-center gap-2 flex-wrap">
						<span>{title}</span>
						{countdown != null && (
							<span
								className="font-mono text-[11px] font-normal tabular-nums text-zinc-400"
								title="Time until daily quota resets (midnight Eastern)"
							>
								resets in {countdown}
							</span>
						)}
					</p>
					<p className="text-[11px] text-zinc-500 mt-0.5">{subtitle}</p>
				</div>
				{w.unlimited ? (
					<span className="shrink-0 rounded-full bg-violet-950/80 border border-violet-800/60 px-2 py-0.5 text-[10px] font-medium text-violet-300">
						Unlimited
					</span>
				) : (
					<span className="shrink-0 rounded-full bg-zinc-900 border border-zinc-700 px-2 py-0.5 text-[10px] font-mono text-zinc-300">
						{formatNum(w.remaining ?? 0)} left
					</span>
				)}
			</div>
			<div>
				<div className="flex items-baseline justify-between mb-1.5">
					<span className="text-2xl font-semibold tabular-nums text-white tracking-tight">
						{formatNum(w.success)}
						{!w.unlimited && (
							<span className="text-sm font-normal text-zinc-500">
								{' '}
								/ {formatNum(w.limit ?? 0)}
							</span>
						)}
					</span>
					<span className="text-[11px] text-zinc-500">{unit}</span>
				</div>
				<div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
					<div
						className={`h-full rounded-full transition-all duration-500 ${barColor}`}
						style={{ width: w.unlimited ? (w.success > 0 ? '12%' : '0%') : `${pct}%` }}
					/>
				</div>
			</div>
			{showErrors && (
				<p className="text-[11px] text-zinc-500">
					{w.errors === 0 ? (
						<span>No errors in this window</span>
					) : (
						<span>
							<span className="text-red-400/90 font-medium">{w.errors}</span> error
							{w.errors === 1 ? '' : 's'}
							<span className="text-zinc-600"> · not counted toward limit</span>
						</span>
					)}
				</p>
			)}
		</div>
	)
}

function StatsCard({ stats }: { stats: UserStats }) {
	return (
		<div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 space-y-4">
			<p className="text-sm font-medium text-white">Stats</p>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-2.5">
					<p className="text-[11px] uppercase tracking-wide text-zinc-500">Calls all time</p>
					<p className="text-lg font-semibold tabular-nums text-white mt-0.5">
						{formatNum(stats.calls_all_time.success + stats.calls_all_time.errors)}
					</p>
					<p className="text-[11px] text-zinc-500 mt-0.5">
						<span className="text-emerald-400/90">
							{formatNum(stats.calls_all_time.success)} ok
						</span>
						<span className="text-zinc-600"> · </span>
						<span className="text-red-400/90">{formatNum(stats.calls_all_time.errors)} err</span>
					</p>
				</div>
				<div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-2.5">
					<p className="text-[11px] uppercase tracking-wide text-zinc-500">Calls today</p>
					<p className="text-lg font-semibold tabular-nums text-white mt-0.5">
						{formatNum(stats.calls_today.success + stats.calls_today.errors)}
					</p>
					<p className="text-[11px] text-zinc-500 mt-0.5">
						<span className="text-emerald-400/90">
							{formatNum(stats.calls_today.success)} ok
						</span>
						<span className="text-zinc-600"> · </span>
						<span className="text-red-400/90">{formatNum(stats.calls_today.errors)} err</span>
					</p>
				</div>
				<div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-2.5">
					<p className="text-[11px] uppercase tracking-wide text-zinc-500">Tokens all time</p>
					<p className="text-lg font-semibold tabular-nums text-white mt-0.5">
						{formatNum(stats.tokens_all_time)}
					</p>
				</div>
				<div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-2.5">
					<p className="text-[11px] uppercase tracking-wide text-zinc-500">Tokens today</p>
					<p className="text-lg font-semibold tabular-nums text-white mt-0.5">
						{formatNum(stats.tokens_today)}
					</p>
				</div>
			</div>
			<div>
				<p className="text-[11px] uppercase tracking-wide text-zinc-500 mb-2">Top 5 models</p>
				{stats.top_models.length === 0 ? (
					<p className="text-sm text-zinc-500">No requests yet</p>
				) : (
					<ul className="space-y-1.5">
						{stats.top_models.map((m) => (
							<li
								key={m.model_id}
								className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800/60 bg-zinc-900/30 px-3 py-2 text-sm"
							>
								<span className="font-mono text-zinc-200 truncate" title={m.model_id}>
									{m.model_id}
								</span>
								<span className="shrink-0 text-[11px] tabular-nums text-zinc-400">
									{formatNum(m.requests)} calls · {formatNum(m.tokens)} tok
								</span>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	)
}

export type UserDetailPanelProps = {
	userId: string
	roles: Role[]
	/** Modal mode: show X close. Full page: hide X, still show open-in-new-tab only when modal. */
	mode: 'modal' | 'page'
	onClose?: () => void
	onUserUpdated?: (user: AdminUser) => void
}

export function UserDetailPanel({
	userId,
	roles,
	mode,
	onClose,
	onUserUpdated,
}: UserDetailPanelProps) {
	const [user, setUser] = useState<AdminUser | null>(null)
	const [minute, setMinute] = useState<UsageWindow | null>(null)
	const [day, setDay] = useState<UsageWindow | null>(null)
	const [tokensMinute, setTokensMinute] = useState<UsageWindow | null>(null)
	const [tokensDay, setTokensDay] = useState<UsageWindow | null>(null)
	const [stats, setStats] = useState<UserStats | null>(null)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [saving, setSaving] = useState(false)

	const dayCountdown = useCountdown(day?.resets_at)
	const tokensDayCountdown = useCountdown(tokensDay?.resets_at)

	const load = useCallback(async () => {
		setLoading(true)
		setError(null)
		try {
			const res = await api.getUser(userId)
			const emptyWindow: UsageWindow = {
				success: 0,
				errors: 0,
				limit: null,
				remaining: null,
				unlimited: true,
			}
			const emptyStats: UserStats = {
				calls_all_time: { success: 0, errors: 0 },
				calls_today: { success: 0, errors: 0 },
				tokens_all_time: 0,
				tokens_today: 0,
				top_models: [],
			}
			setUser(res.user)
			setMinute(res.minute)
			setDay(res.day)
			setTokensMinute(res.tokens_minute ?? emptyWindow)
			setTokensDay(res.tokens_day ?? emptyWindow)
			setStats(res.stats ?? emptyStats)
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Failed to load user')
		} finally {
			setLoading(false)
		}
	}, [userId])

	useEffect(() => {
		void load()
	}, [load])

	async function patch(body: {
		is_active?: boolean
		role_id?: string | null
		log_user_prompt?: boolean
	}) {
		if (!user) return
		setSaving(true)
		setError(null)
		try {
			const res = await api.patchUser(user.id, body)
			setUser(res.user)
			onUserUpdated?.(res.user)
			// Role change may change limits — refresh usage buckets
			if ('role_id' in body) {
				const detail = await api.getUser(user.id)
				setUser(detail.user)
				setMinute(detail.minute)
				setDay(detail.day)
				setTokensMinute(detail.tokens_minute)
				setTokensDay(detail.tokens_day)
				setStats(detail.stats)
				onUserUpdated?.(detail.user)
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Update failed')
		} finally {
			setSaving(false)
		}
	}

	const openHref = `/admin/users/${userId}`

	return (
		<div className="flex flex-col gap-5">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					{loading && !user ? (
						<p className="text-sm text-zinc-500">Loading…</p>
					) : (
						<>
							<h2 className="text-xl font-semibold text-white truncate">
								{user?.discord_username ?? 'User'}
							</h2>
							<p className="text-xs text-zinc-500 mt-0.5">User details</p>
						</>
					)}
				</div>
				<div className="flex items-center gap-1 shrink-0">
					{mode === 'modal' && (
						<a
							href={openHref}
							target="_blank"
							rel="noreferrer"
							title="Open in new tab"
							className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 20 20"
								fill="currentColor"
								className="h-4 w-4"
								aria-hidden
							>
								<path
									fillRule="evenodd"
									d="M4.25 5.5a.75.75 0 0 0-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 0 0 .75-.75v-4a.75.75 0 0 1 1.5 0v4A2.25 2.25 0 0 1 12.75 17h-8.5A2.25 2.25 0 0 1 2 14.75v-8.5A2.25 2.25 0 0 1 4.25 4h5a.75.75 0 0 1 0 1.5h-5Z"
									clipRule="evenodd"
								/>
								<path
									fillRule="evenodd"
									d="M6.194 12.753a.75.75 0 0 0 1.06.053L16.5 4.44v2.81a.75.75 0 0 0 1.5 0v-4.5a.75.75 0 0 0-.75-.75h-4.5a.75.75 0 0 0 0 1.5h2.553l-9.056 8.194a.75.75 0 0 0-.053 1.06Z"
									clipRule="evenodd"
								/>
							</svg>
							<span className="sr-only">Open in new tab</span>
						</a>
					)}
					{mode === 'modal' && onClose && (
						<button
							type="button"
							onClick={onClose}
							title="Close"
							className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 20 20"
								fill="currentColor"
								className="h-4 w-4"
								aria-hidden
							>
								<path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
							</svg>
							<span className="sr-only">Close</span>
						</button>
					)}
					{mode === 'page' && (
						<Link
							to="/admin/users"
							className="text-xs text-zinc-400 hover:text-zinc-200 hover:underline"
						>
							← Back to users
						</Link>
					)}
				</div>
			</div>

			{error && (
				<div className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
					{error}
				</div>
			)}

			{user && (
				<>
					<div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4 space-y-3">
						<div>
							<p className="text-[11px] uppercase tracking-wide text-zinc-500">Username</p>
							<p className="text-sm text-white mt-0.5">{user.discord_username ?? '—'}</p>
						</div>
						<div>
							<p className="text-[11px] uppercase tracking-wide text-zinc-500">Discord ID</p>
							<p className="text-sm font-mono text-zinc-300 mt-0.5">{user.discord_id}</p>
						</div>
						<div className="grid gap-3 sm:grid-cols-2">
							<div>
								<p className="text-[11px] uppercase tracking-wide text-zinc-500">Registered</p>
								<p className="text-sm text-zinc-300 mt-0.5">
									{new Date(user.registered_at).toLocaleString()}
								</p>
							</div>
							<div>
								<p className="text-[11px] uppercase tracking-wide text-zinc-500">Last IP</p>
								<p className="text-sm font-mono text-zinc-400 mt-0.5">{user.last_ip ?? '—'}</p>
							</div>
						</div>
						{!user.is_active && (
							<div>
								<p className="text-[11px] uppercase tracking-wide text-zinc-500">Disabled reason</p>
								<p className="mt-1">
									{user.disable_reason === 'admin' || user.admin_disabled ? (
										<span className="rounded-full bg-amber-950/80 text-amber-300 px-2 py-0.5 text-[10px]">
											Admin
										</span>
									) : (
										<span className="rounded-full bg-zinc-800 text-zinc-400 px-2 py-0.5 text-[10px]">
											Not in server
										</span>
									)}
								</p>
							</div>
						)}
					</div>

					<div>
						<p className="text-sm font-medium text-zinc-300 mb-2">Usage</p>
						{minute && day && tokensMinute && tokensDay ? (
							<div className="grid gap-3 sm:grid-cols-2">
								<UsageCard
									title="Requests / minute"
									subtitle="Rolling last 60 seconds"
									window={minute}
								/>
								<UsageCard
									title="Requests / day"
									subtitle="Resets daily at midnight Eastern"
									window={day}
									countdown={dayCountdown}
								/>
								<UsageCard
									title="Tokens / minute"
									subtitle="Prompt + completion · rolling 60s"
									window={tokensMinute}
									unit="tokens"
									showErrors={false}
								/>
								<UsageCard
									title="Tokens / day"
									subtitle="Prompt + completion · midnight Eastern"
									window={tokensDay}
									countdown={tokensDayCountdown}
									unit="tokens"
									showErrors={false}
								/>
							</div>
						) : (
							<p className="text-sm text-zinc-500">Loading usage…</p>
						)}
					</div>

					{stats && (
						<div>
							<p className="text-sm font-medium text-zinc-300 mb-2">Overview</p>
							<StatsCard stats={stats} />
						</div>
					)}

					<div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4 space-y-4">
						<div>
							<label className="block text-[11px] uppercase tracking-wide text-zinc-500 mb-1.5">
								Role
							</label>
							{roles.length === 0 ? (
								<span className="text-sm text-zinc-500">{user.role_name ?? '—'}</span>
							) : (
								<select
									disabled={saving}
									className="w-full max-w-xs rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white disabled:opacity-50"
									value={user.role_id ?? ''}
									onChange={(e) => void patch({ role_id: e.target.value })}
								>
									{!user.role_id && (
										<option value="" disabled>
											Unassigned
										</option>
									)}
									{roles.map((r) => {
										const req =
											r.requests_per_minute != null || r.requests_per_day != null
												? ` · ${r.requests_per_minute ?? '∞'} rpm · ${r.requests_per_day ?? '∞'} rpd`
												: ''
										const tok =
											r.tokens_per_minute != null || r.tokens_per_day != null
												? ` · ${r.tokens_per_minute ?? '∞'} tpm · ${r.tokens_per_day ?? '∞'} tpd`
												: ''
										return (
											<option key={r.id} value={r.id}>
												{r.name}
												{r.is_default ? ' (default)' : ''}
												{req}
												{tok}
											</option>
										)
									})}
								</select>
							)}
						</div>

						<div>
							<label className="block text-[11px] uppercase tracking-wide text-zinc-500 mb-1.5">
								Status
							</label>
							<button
								type="button"
								disabled={saving}
								onClick={() => void patch({ is_active: !user.is_active })}
								className={`rounded-full px-3 py-1 text-xs font-medium disabled:opacity-50 ${
									user.is_active
										? 'bg-emerald-950 text-emerald-300 border border-emerald-900/50'
										: 'bg-zinc-800 text-zinc-400 border border-zinc-700'
								}`}
							>
								{user.is_active ? 'Active' : 'Disabled'}
							</button>
							<p className="text-[11px] text-zinc-500 mt-1.5">
								Click to {user.is_active ? 'disable' : 'enable'} proxy access
							</p>
						</div>

						<div>
							<label className="flex items-center justify-between gap-3 max-w-md">
								<span>
									<span className="block text-[11px] uppercase tracking-wide text-zinc-500">
										Prompt logging
									</span>
									<span className="text-[11px] text-zinc-500 mt-1 block">
										When on, store this user&apos;s prompts/responses even if global logging is
										off. Auto-enabled after a CSAM flag; you can turn it off after review.
									</span>
								</span>
								<input
									type="checkbox"
									disabled={saving}
									checked={Boolean(user.log_user_prompt)}
									onChange={(e) => void patch({ log_user_prompt: e.target.checked })}
									className="h-4 w-4"
								/>
							</label>
						</div>

						<div className="flex flex-wrap gap-3">
							<Link
								to={`/admin/logs?user_id=${user.id}`}
								className="text-xs text-violet-400 hover:underline"
							>
								View logs →
							</Link>
							<Link
								to={`/admin/logs?user_id=${user.id}&tab=csam`}
								className="text-xs text-amber-400/90 hover:underline"
							>
								CSAM flags →
							</Link>
						</div>
					</div>
				</>
			)}
		</div>
	)
}

export function UserDetailModal({
	userId,
	roles,
	onClose,
	onUserUpdated,
}: {
	userId: string
	roles: Role[]
	onClose: () => void
	onUserUpdated?: (user: AdminUser) => void
}) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose()
		}
		document.addEventListener('keydown', onKey)
		const prev = document.body.style.overflow
		document.body.style.overflow = 'hidden'
		return () => {
			document.removeEventListener('keydown', onKey)
			document.body.style.overflow = prev
		}
	}, [onClose])

	return (
		<div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-8">
			<button
				type="button"
				aria-label="Close overlay"
				className="absolute inset-0 bg-black/70 backdrop-blur-[2px]"
				onClick={onClose}
			/>
			<div
				role="dialog"
				aria-modal="true"
				className="relative z-10 w-full max-w-2xl max-h-[min(90vh,880px)] overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/50 p-5 sm:p-6"
			>
				<UserDetailPanel
					userId={userId}
					roles={roles}
					mode="modal"
					onClose={onClose}
					onUserUpdated={onUserUpdated}
				/>
			</div>
		</div>
	)
}

export default function UserDetailPage() {
	const { id } = useParams<{ id: string }>()
	const navigate = useNavigate()
	const [roles, setRoles] = useState<Role[]>([])

	useEffect(() => {
		void api.listRoles().then((r) => setRoles(r.roles)).catch(() => undefined)
	}, [])

	if (!id) {
		return (
			<div className="space-y-4">
				<p className="text-sm text-zinc-500">Missing user id.</p>
				<button
					type="button"
					className="text-xs text-violet-400 hover:underline"
					onClick={() => navigate('/admin/users')}
				>
					Back to users
				</button>
			</div>
		)
	}

	return (
		<div className="max-w-2xl">
			<UserDetailPanel userId={id} roles={roles} mode="page" />
		</div>
	)
}

import { useCallback, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { api, apiBaseUrl, type AppUser, type UsageWindow, type UserStats } from '../lib/api'
import { supabase } from '../lib/supabaseClient'

type ExposedModel = {
	public_id: string
	total_requests: number
	success_rate: number | null
}

type UserLog = {
	id: number
	model_id: string | null
	status_code: number | null
	prompt_tokens: number | null
	completion_tokens: number | null
	is_error: boolean | null
	created_at: string
}

type UsageState = {
	minute: UsageWindow
	day: UsageWindow
	tokens_minute: UsageWindow
	tokens_day: UsageWindow
	stats: UserStats
}

function formatNum(n: number): string {
	return n.toLocaleString()
}

const LOG_PAGE = 50

function formatCountdown(ms: number): string {
	if (ms <= 0) return '0:00:00'
	const totalSec = Math.floor(ms / 1000)
	const h = Math.floor(totalSec / 3600)
	const m = Math.floor((totalSec % 3600) / 60)
	const s = totalSec % 60
	return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** Live countdown to an ISO reset instant. */
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
	/** Optional live countdown shown next to the title (daily card). */
	countdown?: string | null
	unit?: string
	showErrors?: boolean
}) {
	const pct = w.unlimited
		? Math.min(100, w.success > 0 ? 8 : 0)
		: w.limit && w.limit > 0
			? Math.min(100, (w.success / w.limit) * 100)
			: 0
	const barColor =
		w.unlimited
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

function RateLimitCards({ usage }: { usage: UsageState }) {
	const dayCountdown = useCountdown(usage.day.resets_at)
	const tokensDayCountdown = useCountdown(usage.tokens_day.resets_at)
	return (
		<div className="space-y-3">
			<div className="grid gap-3 sm:grid-cols-2">
				<UsageCard
					title="Requests / minute"
					subtitle="Rolling last 60 seconds"
					window={usage.minute}
				/>
				<UsageCard
					title="Requests / day"
					subtitle="Resets daily at midnight Eastern"
					window={usage.day}
					countdown={dayCountdown}
				/>
				<UsageCard
					title="Tokens / minute"
					subtitle="Prompt + completion · rolling 60s"
					window={usage.tokens_minute}
					unit="tokens"
					showErrors={false}
				/>
				<UsageCard
					title="Tokens / day"
					subtitle="Prompt + completion · midnight Eastern"
					window={usage.tokens_day}
					countdown={tokensDayCountdown}
					unit="tokens"
					showErrors={false}
				/>
			</div>
			<div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 space-y-3">
				<p className="text-sm font-medium text-white">Your stats</p>
				<div className="grid gap-2 sm:grid-cols-2">
					<div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-2">
						<p className="text-[11px] text-zinc-500">Calls all time</p>
						<p className="text-base font-semibold tabular-nums text-white">
							{formatNum(
								usage.stats.calls_all_time.success + usage.stats.calls_all_time.errors,
							)}
						</p>
						<p className="text-[11px] text-zinc-500">
							{formatNum(usage.stats.calls_all_time.success)} ok ·{' '}
							{formatNum(usage.stats.calls_all_time.errors)} err
						</p>
					</div>
					<div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-2">
						<p className="text-[11px] text-zinc-500">Calls today</p>
						<p className="text-base font-semibold tabular-nums text-white">
							{formatNum(usage.stats.calls_today.success + usage.stats.calls_today.errors)}
						</p>
						<p className="text-[11px] text-zinc-500">
							{formatNum(usage.stats.calls_today.success)} ok ·{' '}
							{formatNum(usage.stats.calls_today.errors)} err
						</p>
					</div>
					<div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-2">
						<p className="text-[11px] text-zinc-500">Tokens all time</p>
						<p className="text-base font-semibold tabular-nums text-white">
							{formatNum(usage.stats.tokens_all_time)}
						</p>
					</div>
					<div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-2">
						<p className="text-[11px] text-zinc-500">Tokens today</p>
						<p className="text-base font-semibold tabular-nums text-white">
							{formatNum(usage.stats.tokens_today)}
						</p>
					</div>
				</div>
				{usage.stats.top_models.length > 0 && (
					<div>
						<p className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1.5">
							Top models
						</p>
						<ul className="space-y-1">
							{usage.stats.top_models.map((m) => (
								<li
									key={m.model_id}
									className="flex justify-between gap-2 text-sm text-zinc-300"
								>
									<span className="font-mono truncate">{m.model_id}</span>
									<span className="shrink-0 tabular-nums text-zinc-500 text-xs">
										{formatNum(m.requests)} · {formatNum(m.tokens)} tok
									</span>
								</li>
							))}
						</ul>
					</div>
				)}
			</div>
		</div>
	)
}

export default function Dashboard() {
	const [session, setSession] = useState<Session | null>(null)
	const [user, setUser] = useState<AppUser | null>(null)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [revealed, setRevealed] = useState(false)
	const [copied, setCopied] = useState(false)
	const [copiedWhat, setCopiedWhat] = useState<string | null>(null)
	const [models, setModels] = useState<ExposedModel[]>([])
	const [logs, setLogs] = useState<UserLog[]>([])
	const [logPage, setLogPage] = useState(0)
	const [logTotal, setLogTotal] = useState(0)
	const [logsLoading, setLogsLoading] = useState(false)
	const [usage, setUsage] = useState<UsageState | null>(null)
	const [usageLoading, setUsageLoading] = useState(false)
	const [rotating, setRotating] = useState(false)
	const [rotateNotice, setRotateNotice] = useState<string | null>(null)

	useEffect(() => {
		let cancelled = false
		supabase.auth.getSession().then(({ data }) => {
			if (!cancelled) setSession(data.session)
		})
		const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
			setSession(s)
		})
		return () => {
			cancelled = true
			sub.subscription.unsubscribe()
		}
	}, [])

	useEffect(() => {
		if (!session?.access_token) {
			setUser(null)
			setLoading(false)
			return
		}
		let cancelled = false
		setLoading(true)
		setError(null)
		api
			.userEnsure(session.access_token)
			.then((res) => {
				if (!cancelled) setUser(res.user)
			})
			.catch((e) => {
				if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load profile')
			})
			.finally(() => {
				if (!cancelled) setLoading(false)
			})
		return () => {
			cancelled = true
		}
	}, [session?.access_token])

	const loadUsage = useCallback(async (token: string) => {
		setUsageLoading(true)
		try {
			const res = await api.userUsage(token)
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
			setUsage({
				minute: res.minute,
				day: res.day,
				tokens_minute: res.tokens_minute ?? emptyWindow,
				tokens_day: res.tokens_day ?? emptyWindow,
				stats: res.stats ?? emptyStats,
			})
		} catch (e) {
			// Non-fatal — don't blank the whole dashboard
			console.error(e)
		} finally {
			setUsageLoading(false)
		}
	}, [])

	useEffect(() => {
		if (!session?.access_token || !user?.is_active) {
			setModels([])
			return
		}
		const token = session.access_token
		let cancelled = false
		;(async () => {
			try {
				const res = await api.userModels(token)
				if (!cancelled) setModels(res.models)
			} catch (e) {
				if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load models')
			}
		})()
		return () => {
			cancelled = true
		}
	}, [session?.access_token, user?.is_active])

	useEffect(() => {
		if (!session?.access_token || !user?.is_active) {
			setUsage(null)
			return
		}
		const token = session.access_token
		void loadUsage(token)
		const id = window.setInterval(() => {
			if (document.visibilityState === 'visible') void loadUsage(token)
		}, 30_000)
		return () => window.clearInterval(id)
	}, [session?.access_token, user?.is_active, loadUsage])

	useEffect(() => {
		if (!session) return
		let cancelled = false
		setLogsLoading(true)
		;(async () => {
			const from = logPage * LOG_PAGE
			const to = from + LOG_PAGE - 1
			const { data, error: lErr, count } = await supabase
				.from('logs')
				.select(
					'id, model_id, status_code, prompt_tokens, completion_tokens, is_error, created_at',
					{ count: 'exact' },
				)
				.order('created_at', { ascending: false })
				.range(from, to)
			if (cancelled) return
			if (lErr) {
				setError(lErr.message)
			} else {
				setLogs((data as UserLog[]) ?? [])
				setLogTotal(count ?? 0)
			}
			setLogsLoading(false)
			// Refresh usage when logs page changes (recent activity)
			if (session.access_token) void loadUsage(session.access_token)
		})()
		return () => {
			cancelled = true
		}
	}, [session, logPage, loadUsage])

	async function signInDiscord() {
		setError(null)
		const { error: err } = await supabase.auth.signInWithOAuth({
			provider: 'discord',
			options: {
				redirectTo: `${window.location.origin}/dashboard`,
			},
		})
		if (err) setError(err.message)
	}

	async function signOut() {
		await supabase.auth.signOut()
		setUser(null)
	}

	async function copyKey() {
		if (!user?.api_key) return
		await navigator.clipboard.writeText(user.api_key)
		setCopied(true)
		setTimeout(() => setCopied(false), 1500)
	}

	async function copyText(label: string, text: string) {
		await navigator.clipboard.writeText(text)
		setCopiedWhat(label)
		setTimeout(() => setCopiedWhat(null), 1500)
	}

	async function rotateKey() {
		if (!session?.access_token || rotating) return
		const ok = window.confirm(
			'Rotate your API key?\n\nYour current key will stop working immediately. Update any apps or scripts that use it.',
		)
		if (!ok) return
		setRotating(true)
		setRotateNotice(null)
		setError(null)
		try {
			const res = await api.userRotateKey(session.access_token)
			setUser(res.user)
			setRevealed(true)
			setRotateNotice('New key ready — copy it now. The old key no longer works.')
			setTimeout(() => setRotateNotice(null), 8000)
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Failed to rotate key')
		} finally {
			setRotating(false)
		}
	}

	// Public API base = this site (Pages origin). Never workers.dev.
	const publicApiBase = apiBaseUrl() || (typeof window !== 'undefined' ? window.location.origin : '')

	const masked =
		user?.api_key && user.api_key.length > 10
			? `${user.api_key.slice(0, 6)}${'•'.repeat(16)}${user.api_key.slice(-4)}`
			: user?.api_key

	const logPages = Math.max(1, Math.ceil(logTotal / LOG_PAGE))

	return (
		<div className="min-h-screen px-4 py-10 max-w-3xl mx-auto">
			<div className="flex items-center justify-between mb-8">
				<div>
					<h1 className="text-2xl font-semibold text-white">Dashboard</h1>
					<p className="text-sm text-zinc-400 mt-1">Your API key and usage</p>
				</div>
				{session && (
					<button
						type="button"
						onClick={() => void signOut()}
						className="text-sm text-zinc-400 hover:text-white"
					>
						Sign out
					</button>
				)}
			</div>

			{error && (
				<div className="mb-4 rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
					{error}
				</div>
			)}

			{!session ? (
				<div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 text-center">
					<p className="text-zinc-300 mb-4">Sign in with Discord to get your API key.</p>
					<button
						type="button"
						onClick={() => void signInDiscord()}
						className="rounded-lg bg-[#5865F2] hover:bg-[#4752C4] px-4 py-2 text-sm font-medium text-white"
					>
						Continue with Discord
					</button>
				</div>
			) : loading ? (
				<p className="text-sm text-zinc-500">Loading profile…</p>
			) : user && !user.is_active ? (
				<div className="space-y-6">
					<div className="rounded-xl border border-red-900/40 bg-red-950/30 p-6 md:p-8 text-center">
						<p className="text-sm text-zinc-400 mb-1">Signed in as</p>
						<p className="text-white font-medium mb-4">
							{user.discord_username ?? user.discord_id}
						</p>
						<p className="text-base md:text-lg text-red-200 font-medium leading-relaxed">
							Your account has been disabled. Please contact administration.
						</p>
						{user.discord_invite_url && (
							<a
								href={user.discord_invite_url}
								target="_blank"
								rel="noopener noreferrer"
								className="mt-6 inline-flex items-center justify-center rounded-lg bg-[#5865F2] hover:bg-[#4752C4] px-4 py-2.5 text-sm font-medium text-white"
							>
								Join Discord
							</a>
						)}
						<p className="text-xs text-zinc-500 mt-6">
							If you recently joined the required server, sign out and sign in again.
						</p>
					</div>
				</div>
			) : user ? (
				<div className="space-y-6">
					<div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
						<p className="text-sm text-zinc-400 mb-1">Signed in as</p>
						<p className="text-white font-medium">
							{user.discord_username ?? user.discord_id}
						</p>
						<div className="mt-3 flex flex-wrap items-center gap-2">
							<span className="text-xs text-zinc-500">Role</span>
							<span className="rounded-full bg-violet-950/80 border border-violet-800/60 px-2.5 py-0.5 text-xs font-medium text-violet-200">
								{user.role?.name ?? 'Default'}
							</span>
						</div>
					</div>

					<div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
						<div className="flex items-center justify-between mb-3">
							<div>
								<p className="text-sm font-medium text-zinc-200">Rate limits & stats</p>
								<p className="text-[11px] text-zinc-500 mt-0.5">
									Limits come from your role
									{user.role?.name ? ` (${user.role.name})` : ''}. Only successful
									requests count toward RPM / RPD / TPM / TPD. Tokens = prompt +
									completion.
								</p>
							</div>
							{usageLoading && !usage && (
								<span className="text-[11px] text-zinc-500">Loading…</span>
							)}
						</div>
						{usage ? (
							<RateLimitCards usage={usage} />
						) : (
							<p className="text-sm text-zinc-500">
								{usageLoading ? 'Loading usage…' : 'Usage unavailable.'}
							</p>
						)}
					</div>

					<div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
						<div className="flex items-center justify-between mb-2">
							<p className="text-sm font-medium text-zinc-300">API key</p>
							<div className="flex gap-3">
								<button
									type="button"
									onClick={() => setRevealed((v) => !v)}
									className="text-xs text-violet-400 hover:underline"
								>
									{revealed ? 'Hide' : 'Reveal'}
								</button>
								<button
									type="button"
									onClick={() => void copyKey()}
									className="text-xs text-violet-400 hover:underline"
								>
									{copied ? 'Copied' : 'Copy'}
								</button>
								<button
									type="button"
									disabled={rotating}
									onClick={() => void rotateKey()}
									className="text-xs text-amber-400/90 hover:underline disabled:opacity-50"
								>
									{rotating ? 'Rotating…' : 'Rotate key'}
								</button>
							</div>
						</div>
						<code className="block break-all rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-200 font-mono">
							{revealed ? user.api_key : masked}
						</code>
						{rotateNotice && (
							<p className="mt-2 text-xs text-emerald-400">{rotateNotice}</p>
						)}
					</div>

					<div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 space-y-4">
						<p className="text-sm font-medium text-zinc-300">How to use</p>
						<p className="text-xs text-zinc-500">
							OpenAI-compatible API. Base URL is this site. Use the{' '}
							<span className="font-mono text-zinc-400">Public ID</span> from the table below
							(format <span className="font-mono">channel/model</span>), not the bare upstream
							name. Paths: <span className="font-mono">/v1/models</span>,{' '}
							<span className="font-mono">/v1/chat/completions</span>,{' '}
							<span className="font-mono">/v1/completions</span>.
						</p>

						<div>
							<div className="flex items-center justify-between mb-1">
								<p className="text-xs text-zinc-400">Base URL</p>
								<button
									type="button"
									onClick={() => void copyText('base', publicApiBase)}
									className="text-xs text-violet-400 hover:underline"
								>
									{copiedWhat === 'base' ? 'Copied' : 'Copy'}
								</button>
							</div>
							<code className="block break-all rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2 text-xs text-zinc-200 font-mono">
								{publicApiBase}
							</code>
						</div>

						{(() => {
							const keyPlaceholder = revealed ? user.api_key : 'YOUR_API_KEY'
							const sampleModel = models[0]?.public_id ?? 'channel/model-id'
							const modelsCurl = `curl ${publicApiBase}/v1/models \\\n  -H "Authorization: Bearer ${keyPlaceholder}"`
							const chatCurl = `curl ${publicApiBase}/v1/chat/completions \\\n  -H "Authorization: Bearer ${keyPlaceholder}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${sampleModel}","messages":[{"role":"user","content":"hi"}]}'`
							return (
								<>
									<div>
										<div className="flex items-center justify-between mb-1">
											<p className="text-xs text-zinc-400">List models</p>
											<button
												type="button"
												onClick={() => void copyText('models', modelsCurl)}
												className="text-xs text-violet-400 hover:underline"
											>
												{copiedWhat === 'models' ? 'Copied' : 'Copy'}
											</button>
										</div>
										<pre className="overflow-x-auto rounded-lg bg-zinc-950 border border-zinc-800 p-3 text-xs text-zinc-300 font-mono whitespace-pre-wrap">
											{modelsCurl}
										</pre>
									</div>
									<div>
										<div className="flex items-center justify-between mb-1">
											<p className="text-xs text-zinc-400">Chat completions</p>
											<button
												type="button"
												onClick={() => void copyText('chat', chatCurl)}
												className="text-xs text-violet-400 hover:underline"
											>
												{copiedWhat === 'chat' ? 'Copied' : 'Copy'}
											</button>
										</div>
										<pre className="overflow-x-auto rounded-lg bg-zinc-950 border border-zinc-800 p-3 text-xs text-zinc-300 font-mono whitespace-pre-wrap">
											{chatCurl}
										</pre>
									</div>
								</>
							)
						})()}
					</div>

					<div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
						<p className="text-sm font-medium text-zinc-300 mb-3">Exposed models</p>
						{models.length === 0 ? (
							<p className="text-sm text-zinc-500">No models exposed yet.</p>
						) : (
							<div className="overflow-x-auto">
								<table className="w-full text-sm text-left">
									<thead className="text-zinc-400">
										<tr>
											<th className="pb-2 font-medium">Model</th>
											<th className="pb-2 font-medium">Requests</th>
											<th className="pb-2 font-medium">Success</th>
										</tr>
									</thead>
									<tbody className="divide-y divide-zinc-800">
										{models.map((m) => (
											<tr key={m.public_id}>
												<td className="py-2 font-mono text-xs text-zinc-200">{m.public_id}</td>
												<td className="py-2 text-zinc-400">{m.total_requests}</td>
												<td className="py-2 text-zinc-400">
													{m.success_rate === null ? '—' : `${m.success_rate.toFixed(1)}%`}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</div>

					<div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
						<p className="text-sm font-medium text-zinc-300 mb-3">Your requests</p>
						{logsLoading ? (
							<p className="text-sm text-zinc-500">Loading logs…</p>
						) : logs.length === 0 ? (
							<p className="text-sm text-zinc-500">No requests yet.</p>
						) : (
							<>
								<div className="overflow-x-auto">
									<table className="w-full text-sm text-left">
										<thead className="text-zinc-400">
											<tr>
												<th className="pb-2 font-medium">Time</th>
												<th className="pb-2 font-medium">Model</th>
												<th className="pb-2 font-medium">Status</th>
												<th className="pb-2 font-medium">Tokens</th>
											</tr>
										</thead>
										<tbody className="divide-y divide-zinc-800">
											{logs.map((log) => (
												<tr key={log.id}>
													<td className="py-2 text-zinc-300 whitespace-nowrap text-xs">
														{new Date(log.created_at).toLocaleString()}
													</td>
													<td className="py-2 font-mono text-xs">{log.model_id ?? '—'}</td>
													<td className="py-2 text-xs">
														<span
															className={
																log.is_error || (log.status_code ?? 0) >= 400
																	? 'text-red-400'
																	: 'text-emerald-400'
															}
														>
															{log.status_code ?? '—'}
														</span>
														{log.is_error ? (
															<span className="ml-1 text-[10px] text-red-400/70">err</span>
														) : null}
													</td>
													<td className="py-2 text-xs text-zinc-400">
														{log.prompt_tokens ?? '—'} / {log.completion_tokens ?? '—'}
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
								<div className="flex items-center justify-between mt-3 text-xs text-zinc-500">
									<span>
										Page {logPage + 1} / {logPages}
									</span>
									<div className="flex gap-2">
										<button
											type="button"
											disabled={logPage <= 0}
											onClick={() => setLogPage((p) => Math.max(0, p - 1))}
											className="rounded border border-zinc-700 px-2 py-1 disabled:opacity-40"
										>
											Prev
										</button>
										<button
											type="button"
											disabled={logPage + 1 >= logPages}
											onClick={() => setLogPage((p) => p + 1)}
											className="rounded border border-zinc-700 px-2 py-1 disabled:opacity-40"
										>
											Next
										</button>
									</div>
								</div>
							</>
						)}
					</div>
				</div>
			) : (
				<p className="text-sm text-zinc-500">No profile.</p>
			)}
		</div>
	)
}

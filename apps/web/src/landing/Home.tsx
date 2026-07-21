import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { Link } from 'react-router-dom'
import { api, apiBaseUrl, type ExposedModel } from '../lib/api'
import { supabase } from '../lib/supabaseClient'

function DiscordIcon({ className }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
		</svg>
	)
}

function successClass(rate: number | null): string {
	if (rate === null) return 'text-faint'
	if (rate >= 99) return 'text-success'
	if (rate >= 90) return 'text-warn'
	return 'text-danger'
}

export default function Home() {
	const [session, setSession] = useState<Session | null>(null)
	const [sessionReady, setSessionReady] = useState(false)
	const [models, setModels] = useState<ExposedModel[]>([])
	const [modelsLoading, setModelsLoading] = useState(true)
	const [modelsError, setModelsError] = useState<string | null>(null)
	const [authError, setAuthError] = useState<string | null>(null)
	const [authLoading, setAuthLoading] = useState(false)
	const [copiedWhat, setCopiedWhat] = useState<string | null>(null)

	const publicApiBase =
		apiBaseUrl() || (typeof window !== 'undefined' ? window.location.origin : '')
	const signedIn = Boolean(session)

	useEffect(() => {
		let cancelled = false
		supabase.auth.getSession().then(({ data }) => {
			if (!cancelled) {
				setSession(data.session)
				setSessionReady(true)
			}
		})
		const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
			setSession(s)
			setSessionReady(true)
		})
		return () => {
			cancelled = true
			sub.subscription.unsubscribe()
		}
	}, [])

	useEffect(() => {
		let cancelled = false
		;(async () => {
			setModelsLoading(true)
			setModelsError(null)
			try {
				const res = await api.publicModels()
				if (!cancelled) setModels(res.models)
			} catch (e) {
				if (!cancelled) setModelsError(e instanceof Error ? e.message : 'Failed to load models')
			} finally {
				if (!cancelled) setModelsLoading(false)
			}
		})()
		return () => {
			cancelled = true
		}
	}, [])

	async function signInDiscord() {
		setAuthError(null)
		setAuthLoading(true)
		const { error } = await supabase.auth.signInWithOAuth({
			provider: 'discord',
			options: {
				redirectTo: `${window.location.origin}/dashboard`,
			},
		})
		if (error) {
			setAuthError(error.message)
			setAuthLoading(false)
		}
	}

	async function copyText(key: string, text: string) {
		try {
			await navigator.clipboard.writeText(text)
			setCopiedWhat(key)
			window.setTimeout(() => setCopiedWhat((w) => (w === key ? null : w)), 1500)
		} catch {
			// clipboard may be blocked
		}
	}

	const sampleModel = models[0]?.public_id ?? 'channel/model-id'
	const modelsCurl = `curl ${publicApiBase}/v1/models \\\n  -H "Authorization: Bearer YOUR_API_KEY"`
	const chatCurl = `curl ${publicApiBase}/v1/chat/completions \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${sampleModel}","messages":[{"role":"user","content":"hi"}]}'`

	return (
		<div className="min-h-screen flex flex-col bg-bg text-text-secondary">
			<header className="border-b border-border">
				<div className="mx-auto max-w-5xl px-4 py-4 flex items-center justify-between gap-4">
					<span className="text-lg font-semibold tracking-tight text-text">Brunway</span>
					<div className="flex items-center gap-3 min-h-9">
						{sessionReady &&
							(signedIn ? (
								<Link
									to="/dashboard"
									className="inline-flex items-center rounded-control bg-accent hover:bg-accent-hover px-3.5 py-2 text-sm font-medium text-text transition-colors"
								>
									Open dashboard
								</Link>
							) : (
								<>
									<Link
										to="/dashboard"
										className="text-sm text-muted hover:text-text transition-colors"
									>
										Dashboard
									</Link>
									<button
										type="button"
										onClick={() => void signInDiscord()}
										disabled={authLoading}
										className="inline-flex items-center gap-2 rounded-control bg-discord hover:bg-discord-hover disabled:opacity-60 px-3.5 py-2 text-sm font-medium text-text transition-colors"
									>
										<DiscordIcon className="h-4 w-4" />
										{authLoading ? 'Redirecting…' : 'Continue with Discord'}
									</button>
								</>
							))}
					</div>
				</div>
			</header>

			<main className="flex-1 mx-auto w-full max-w-5xl px-4 py-12 sm:py-16 space-y-14">
				<section className="max-w-2xl space-y-6">
					<p className="text-xs font-medium uppercase tracking-widest text-accent-soft">
						OpenAI-compatible API
					</p>
					<h1 className="text-4xl sm:text-5xl font-semibold tracking-tight text-text leading-[1.1]">
						One endpoint.
						<br />
						Curated models.
					</h1>
					<p className="text-base sm:text-lg text-muted leading-relaxed max-w-xl">
						{signedIn
							? 'You’re signed in. Open the dashboard for your API key, usage, and request history — same OpenAI-compatible base URL below.'
							: 'Brunway is a private OpenAI-compatible proxy. Sign in with Discord, get an API key, and call models through a single base URL — same paths you already know.'}
					</p>
					<div className="flex flex-wrap items-center gap-3 pt-1 min-h-11">
						{sessionReady &&
							(signedIn ? (
								<>
									<Link
										to="/dashboard"
										className="inline-flex items-center rounded-control bg-accent hover:bg-accent-hover px-5 py-2.5 text-sm font-medium text-text transition-colors"
									>
										Go to dashboard
									</Link>
									<a
										href="#quick-start"
										className="text-sm text-muted hover:text-accent-soft transition-colors px-2"
									>
										View API guide →
									</a>
								</>
							) : (
								<>
									<button
										type="button"
										onClick={() => void signInDiscord()}
										disabled={authLoading}
										className="inline-flex items-center gap-2 rounded-control bg-discord hover:bg-discord-hover disabled:opacity-60 px-5 py-2.5 text-sm font-medium text-text transition-colors"
									>
										<DiscordIcon className="h-5 w-5" />
										{authLoading ? 'Redirecting…' : 'Continue with Discord'}
									</button>
									<a
										href="#quick-start"
										className="text-sm text-muted hover:text-accent-soft transition-colors px-2"
									>
										View API guide →
									</a>
								</>
							))}
					</div>
					{authError && (
						<div className="rounded-control border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger">
							{authError}
						</div>
					)}
				</section>

				<section id="quick-start" className="space-y-4 scroll-mt-8">
					<div>
						<h2 className="text-lg font-semibold text-text">Quick start</h2>
						<p className="mt-1 text-sm text-muted">
							OpenAI-compatible. Base URL is this site. Use the{' '}
							<span className="font-mono text-faint">Public ID</span> from the models table
							(format <span className="font-mono text-faint">channel/model</span>). Paths:{' '}
							<span className="font-mono text-faint">/v1/models</span>,{' '}
							<span className="font-mono text-faint">/v1/chat/completions</span>,{' '}
							<span className="font-mono text-faint">/v1/completions</span>.
						</p>
					</div>

					<div className="rounded-card border border-border bg-surface p-5 space-y-4">
						<div>
							<div className="flex items-center justify-between mb-1.5">
								<p className="text-xs text-muted">Base URL</p>
								<button
									type="button"
									onClick={() => void copyText('base', publicApiBase)}
									className="text-xs text-accent-soft hover:underline"
								>
									{copiedWhat === 'base' ? 'Copied' : 'Copy'}
								</button>
							</div>
							<code className="block break-all rounded-control bg-elevated border border-border px-3 py-2 text-xs text-text-secondary font-mono">
								{publicApiBase}
							</code>
						</div>

						<div>
							<div className="flex items-center justify-between mb-1.5">
								<p className="text-xs text-muted">List models</p>
								<button
									type="button"
									onClick={() => void copyText('models', modelsCurl)}
									className="text-xs text-accent-soft hover:underline"
								>
									{copiedWhat === 'models' ? 'Copied' : 'Copy'}
								</button>
							</div>
							<pre className="overflow-x-auto rounded-control bg-elevated border border-border p-3 text-xs text-text-secondary font-mono whitespace-pre-wrap">
								{modelsCurl}
							</pre>
						</div>

						<div>
							<div className="flex items-center justify-between mb-1.5">
								<p className="text-xs text-muted">Chat completions</p>
								<button
									type="button"
									onClick={() => void copyText('chat', chatCurl)}
									className="text-xs text-accent-soft hover:underline"
								>
									{copiedWhat === 'chat' ? 'Copied' : 'Copy'}
								</button>
							</div>
							<pre className="overflow-x-auto rounded-control bg-elevated border border-border p-3 text-xs text-text-secondary font-mono whitespace-pre-wrap">
								{chatCurl}
							</pre>
						</div>

						<p className="text-xs text-faint">
							{signedIn ? (
								<>
									Your API key is on the{' '}
									<Link
										to="/dashboard"
										className="text-muted hover:text-accent-soft underline-offset-2 hover:underline"
									>
										dashboard
									</Link>
									.
								</>
							) : (
								<>
									Your API key is issued after Discord sign-in on the{' '}
									<Link
										to="/dashboard"
										className="text-muted hover:text-accent-soft underline-offset-2 hover:underline"
									>
										dashboard
									</Link>
									.
								</>
							)}
						</p>
					</div>
				</section>

				<section className="space-y-4">
					<div className="flex items-end justify-between gap-4">
						<div>
							<h2 className="text-lg font-semibold text-text">Models</h2>
							<p className="mt-1 text-sm text-muted">
								Exposed models and availability from recent traffic.
							</p>
						</div>
					</div>

					<div className="rounded-card border border-border bg-surface p-5">
						{modelsLoading ? (
							<p className="text-sm text-faint">Loading models…</p>
						) : modelsError ? (
							<div className="rounded-control border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger">
								{modelsError}
							</div>
						) : models.length === 0 ? (
							<p className="text-sm text-faint">No models exposed yet.</p>
						) : (
							<div className="overflow-x-auto">
								<table className="w-full text-sm text-left">
									<thead className="text-muted">
										<tr>
											<th className="pb-3 font-medium">Model</th>
											<th className="pb-3 font-medium">Requests</th>
											<th className="pb-3 font-medium">Availability</th>
										</tr>
									</thead>
									<tbody className="divide-y divide-border">
										{models.map((m) => (
											<tr key={m.public_id}>
												<td className="py-2.5 font-mono text-xs text-text-secondary">
													{m.public_id}
												</td>
												<td className="py-2.5 text-muted tabular-nums">
													{m.total_requests.toLocaleString()}
												</td>
												<td className={`py-2.5 tabular-nums font-medium ${successClass(m.success_rate)}`}>
													{m.success_rate === null ? '—' : `${m.success_rate.toFixed(1)}%`}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</div>
				</section>
			</main>

			<footer className="border-t border-border mt-auto">
				<div className="mx-auto max-w-5xl px-4 py-6 flex flex-wrap items-center justify-between gap-3 text-xs text-faint">
					<span>Brunway</span>
					<Link to="/admin" className="hover:text-muted transition-colors">
						Owner
					</Link>
				</div>
			</footer>
		</div>
	)
}

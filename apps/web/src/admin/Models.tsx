import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, apiBaseUrl, type ModelTestResult } from '../lib/api'

type ModelRow = {
	id: string
	channel_id: string
	channel_name: string | null
	model_id: string
	display_name: string | null
	is_exposed: boolean
	created_at: string
	total_requests: number
	total_errors: number
	success_rate: number | null
}

type SortKey =
	| 'model_id'
	| 'channel_name'
	| 'total_requests'
	| 'total_errors'
	| 'success_rate'
	| 'is_exposed'

const NUMERIC_SORT_KEYS: SortKey[] = ['total_requests', 'total_errors', 'success_rate']

export default function ModelsPage() {
	const [models, setModels] = useState<ModelRow[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [sortKey, setSortKey] = useState<SortKey>('model_id')
	const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
	const [testingId, setTestingId] = useState<string | null>(null)
	const [testResult, setTestResult] = useState<ModelTestResult | null>(null)
	const [copied, setCopied] = useState(false)

	const load = useCallback(async () => {
		setError(null)
		try {
			const res = await api.listModels()
			setModels(res.models)
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Failed to load models')
		} finally {
			setLoading(false)
		}
	}, [])

	useEffect(() => {
		void load()
	}, [load])

	const sorted = useMemo(() => {
		const copy = [...models]
		copy.sort((a, b) => {
			let cmp = 0
			switch (sortKey) {
				case 'model_id':
					cmp = a.model_id.localeCompare(b.model_id)
					break
				case 'channel_name':
					cmp = (a.channel_name ?? '').localeCompare(b.channel_name ?? '')
					break
				case 'total_requests':
					cmp = a.total_requests - b.total_requests
					break
				case 'total_errors':
					cmp = a.total_errors - b.total_errors
					break
				case 'success_rate':
					cmp = (a.success_rate ?? -1) - (b.success_rate ?? -1)
					break
				case 'is_exposed':
					cmp = Number(a.is_exposed) - Number(b.is_exposed)
					break
			}
			return sortDir === 'asc' ? cmp : -cmp
		})
		return copy
	}, [models, sortKey, sortDir])

	function toggleSort(key: SortKey) {
		if (sortKey === key) {
			setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
		} else {
			setSortKey(key)
			setSortDir(NUMERIC_SORT_KEYS.includes(key) ? 'desc' : 'asc')
		}
	}

	function sortIndicator(key: SortKey) {
		if (sortKey === key) return sortDir === 'asc' ? '↑' : '↓'
		return '↕'
	}

	async function toggleExposed(m: ModelRow) {
		try {
			await api.patchModel(m.id, { is_exposed: !m.is_exposed })
			setModels((prev) =>
				prev.map((x) => (x.id === m.id ? { ...x, is_exposed: !x.is_exposed } : x)),
			)
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Update failed')
		}
	}

	async function runTest(m: ModelRow, via: 'provider' | 'proxy') {
		setTestingId(`${m.id}:${via}`)
		setTestResult(null)
		setCopied(false)
		try {
			const res = await api.testModel(m.id, { via })
			setTestResult(res)
		} catch (e) {
			setTestResult({
				ok: false,
				via,
				public_model_id: m.channel_name ? `${m.channel_name}/${m.model_id}` : m.model_id,
				error: e instanceof Error ? e.message : 'Test failed',
			})
		} finally {
			setTestingId(null)
		}
	}

	async function copyTestResult() {
		if (!testResult) return
		const text = JSON.stringify(testResult, null, 2)
		await navigator.clipboard.writeText(text)
		setCopied(true)
		setTimeout(() => setCopied(false), 1500)
	}

	const publicBase = apiBaseUrl()

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-semibold text-white">Models</h1>
				<p className="text-sm text-zinc-400 mt-1">
					Users call the <span className="font-mono">Public ID</span> (
					<span className="font-mono">channel/model</span>). Use Test to hit the provider
					directly or simulate our proxy path.
				</p>
			</div>

			{error && (
				<div className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
					{error}
				</div>
			)}

			{testResult && (
				<div
					className={`rounded-xl border p-4 ${
						testResult.ok
							? 'border-emerald-900/50 bg-emerald-950/30'
							: 'border-red-900/50 bg-red-950/30'
					}`}
				>
					<div className="flex flex-wrap items-center justify-between gap-2 mb-2">
						<p className="text-sm font-medium text-white">
							Test result ({testResult.via}) —{' '}
							<span className={testResult.ok ? 'text-emerald-300' : 'text-red-300'}>
								{testResult.ok ? 'OK' : 'FAILED'}
							</span>
							{testResult.status != null && (
								<span className="text-zinc-400 font-normal"> · HTTP {testResult.status}</span>
							)}
							{testResult.duration_ms != null && (
								<span className="text-zinc-500 font-normal"> · {testResult.duration_ms}ms</span>
							)}
						</p>
						<div className="flex gap-2">
							<button
								type="button"
								onClick={() => void copyTestResult()}
								className="text-xs text-violet-400 hover:underline"
							>
								{copied ? 'Copied' : 'Copy full result'}
							</button>
							<button
								type="button"
								onClick={() => setTestResult(null)}
								className="text-xs text-zinc-400 hover:underline"
							>
								Dismiss
							</button>
						</div>
					</div>
					<p className="text-xs text-zinc-400 mb-2 font-mono">
						Public ID: {testResult.public_model_id}
						{testResult.request_url && (
							<>
								<br />
								Upstream: {testResult.request_url}
							</>
						)}
					</p>
					{testResult.looks_like_cloudflare_block && (
						<p className="text-sm text-amber-300 mb-2">
							Upstream returned a Cloudflare block page. The provider may be blocking Worker
							egress IPs or requiring different headers. Try a different base URL / provider, or
							ask the provider to allowlist Cloudflare Worker traffic.
						</p>
					)}
					{testResult.error && (
						<p className="text-sm text-red-300 mb-2">{testResult.error}</p>
					)}
					<pre className="max-h-64 overflow-auto rounded-lg bg-zinc-950 border border-zinc-800 p-3 text-[11px] text-zinc-300 whitespace-pre-wrap">
						{JSON.stringify(
							{
								request_body: testResult.request_body,
								body: testResult.body,
							},
							null,
							2,
						)}
					</pre>
					{(testResult.client_url || testResult.via === 'proxy') && (
						<p className="mt-2 text-xs text-zinc-500">
							Your public endpoint:{' '}
							<span className="font-mono text-zinc-400">
								POST {testResult.client_url ?? `${publicBase}/v1/chat/completions`} ·
								model=&quot;{testResult.public_model_id}&quot;
							</span>
						</p>
					)}
				</div>
			)}

			{loading ? (
				<p className="text-sm text-zinc-500">Loading…</p>
			) : models.length === 0 ? (
				<p className="text-sm text-zinc-500">No models yet. Add a channel first.</p>
			) : (
				<div className="overflow-x-auto rounded-xl border border-zinc-800">
					<table className="w-full text-sm text-left">
						<thead className="bg-zinc-900 text-zinc-400">
							<tr>
								<th className="px-3 py-2 font-medium">
									<button
										type="button"
										onClick={() => toggleSort('model_id')}
										className="inline-flex items-center gap-1 hover:text-zinc-200"
									>
										Model
										<span
											className={
												sortKey === 'model_id' ? 'text-zinc-200' : 'text-zinc-600'
											}
										>
											{sortIndicator('model_id')}
										</span>
									</button>
								</th>
								<th className="px-3 py-2 font-medium">
									<button
										type="button"
										onClick={() => toggleSort('channel_name')}
										className="inline-flex items-center gap-1 hover:text-zinc-200"
									>
										Channel
										<span
											className={
												sortKey === 'channel_name' ? 'text-zinc-200' : 'text-zinc-600'
											}
										>
											{sortIndicator('channel_name')}
										</span>
									</button>
								</th>
								<th className="px-3 py-2 font-medium">Public ID</th>
								<th className="px-3 py-2 font-medium">
									<button
										type="button"
										onClick={() => toggleSort('total_requests')}
										className="inline-flex items-center gap-1 hover:text-zinc-200"
									>
										Requests
										<span
											className={
												sortKey === 'total_requests' ? 'text-zinc-200' : 'text-zinc-600'
											}
										>
											{sortIndicator('total_requests')}
										</span>
									</button>
								</th>
								<th className="px-3 py-2 font-medium">
									<button
										type="button"
										onClick={() => toggleSort('total_errors')}
										className="inline-flex items-center gap-1 hover:text-zinc-200"
									>
										Errors
										<span
											className={
												sortKey === 'total_errors' ? 'text-zinc-200' : 'text-zinc-600'
											}
										>
											{sortIndicator('total_errors')}
										</span>
									</button>
								</th>
								<th className="px-3 py-2 font-medium">
									<button
										type="button"
										onClick={() => toggleSort('success_rate')}
										className="inline-flex items-center gap-1 hover:text-zinc-200"
									>
										Success %
										<span
											className={
												sortKey === 'success_rate' ? 'text-zinc-200' : 'text-zinc-600'
											}
										>
											{sortIndicator('success_rate')}
										</span>
									</button>
								</th>
								<th className="px-3 py-2 font-medium">
									<button
										type="button"
										onClick={() => toggleSort('is_exposed')}
										className="inline-flex items-center gap-1 hover:text-zinc-200"
									>
										Exposed
										<span
											className={
												sortKey === 'is_exposed' ? 'text-zinc-200' : 'text-zinc-600'
											}
										>
											{sortIndicator('is_exposed')}
										</span>
									</button>
								</th>
								<th className="px-3 py-2 font-medium">Test</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-zinc-800">
							{sorted.map((m) => {
								const publicId = m.channel_name
									? `${m.channel_name}/${m.model_id}`
									: m.model_id
								return (
									<tr key={m.id} className="bg-zinc-950/40">
										<td className="px-3 py-2 font-mono text-xs text-zinc-200">
											{m.model_id}
										</td>
										<td className="px-3 py-2 text-zinc-300">{m.channel_name ?? '—'}</td>
										<td className="px-3 py-2 font-mono text-xs text-zinc-400">
											{publicId}
										</td>
										<td className="px-3 py-2">{m.total_requests}</td>
										<td className="px-3 py-2">{m.total_errors}</td>
										<td className="px-3 py-2">
											{m.success_rate === null ? '—' : `${m.success_rate.toFixed(1)}%`}
										</td>
										<td className="px-3 py-2">
											<button
												type="button"
												onClick={() => void toggleExposed(m)}
												className={`rounded-full px-2 py-0.5 text-xs ${
													m.is_exposed
														? 'bg-violet-950 text-violet-300'
														: 'bg-zinc-800 text-zinc-400'
												}`}
											>
												{m.is_exposed ? 'Yes' : 'No'}
											</button>
										</td>
										<td className="px-3 py-2 whitespace-nowrap">
											<button
												type="button"
												disabled={testingId !== null}
												onClick={() => void runTest(m, 'provider')}
												className="text-xs text-violet-400 hover:underline disabled:opacity-40 mr-2"
												title="POST to provider base_url/v1/chat/completions"
											>
												{testingId === `${m.id}:provider` ? '…' : 'Provider'}
											</button>
											<button
												type="button"
												disabled={testingId !== null || !m.is_exposed}
												onClick={() => void runTest(m, 'proxy')}
												className="text-xs text-sky-400 hover:underline disabled:opacity-40"
												title="Simulate our proxy path (requires Exposed)"
											>
												{testingId === `${m.id}:proxy` ? '…' : 'Proxy'}
											</button>
										</td>
									</tr>
								)
							})}
						</tbody>
					</table>
				</div>
			)}
		</div>
	)
}

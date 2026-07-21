import { useState, type FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api, apiBaseUrl, getOwnerToken } from '../lib/api'

export default function AdminLogin() {
	const navigate = useNavigate()
	const location = useLocation()
	const redirected = Boolean((location.state as { reason?: string } | null)?.reason)

	const [username, setUsername] = useState('')
	const [password, setPassword] = useState('')
	const [error, setError] = useState<string | null>(
		redirected
			? 'Session missing or expired. Sign in again (token auth works in incognito / Yandex).'
			: null,
	)
	const [loading, setLoading] = useState(false)

	async function onSubmit(e: FormEvent) {
		e.preventDefault()
		setError(null)
		setLoading(true)
		try {
			await api.adminLogin(username, password)
			if (!getOwnerToken()) {
				setError('Login succeeded but token was not stored. Try another browser or disable strict tracking.')
				return
			}
			// Verify session with the token before entering the dashboard
			await api.adminMe()
			navigate('/admin', { replace: true })
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Login failed')
		} finally {
			setLoading(false)
		}
	}

	return (
		<div className="min-h-screen flex items-center justify-center px-4">
			<form
				onSubmit={onSubmit}
				className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-900/80 p-6 shadow-xl"
			>
				<h1 className="text-xl font-semibold text-white mb-1">Owner login</h1>
				<p className="text-sm text-zinc-400 mb-1">Admin dashboard access</p>
				<p className="text-[11px] text-zinc-600 mb-6 font-mono break-all">
					API: {apiBaseUrl() || '(same origin)'}
				</p>
				<label className="block text-sm text-zinc-300 mb-1">Username</label>
				<input
					className="w-full mb-3 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-white outline-none focus:border-violet-500"
					value={username}
					onChange={(e) => setUsername(e.target.value)}
					autoComplete="username"
					required
				/>
				<label className="block text-sm text-zinc-300 mb-1">Password</label>
				<input
					type="password"
					className="w-full mb-4 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-white outline-none focus:border-violet-500"
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					autoComplete="current-password"
					required
				/>
				{error && <p className="text-sm text-red-400 mb-3 whitespace-pre-wrap">{error}</p>}
				<button
					type="submit"
					disabled={loading}
					className="w-full rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 px-3 py-2 font-medium text-white"
				>
					{loading ? 'Signing in…' : 'Sign in'}
				</button>
			</form>
		</div>
	)
}

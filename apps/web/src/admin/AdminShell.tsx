import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { api, setOwnerToken } from '../lib/api'

const nav = [
	{ to: '/admin/channels', label: 'Channels' },
	{ to: '/admin/models', label: 'Models' },
	{ to: '/admin/users', label: 'Users' },
	{ to: '/admin/logs', label: 'Logs' },
	{ to: '/admin/settings', label: 'Settings' },
]

export default function AdminShell() {
	const navigate = useNavigate()
	const [ready, setReady] = useState(false)
	const [authError, setAuthError] = useState(false)

	useEffect(() => {
		let cancelled = false
		api
			.adminMe()
			.then(() => {
				if (!cancelled) setReady(true)
			})
			.catch(() => {
				if (!cancelled) {
					setOwnerToken(null)
					setAuthError(true)
					// Silent bounce back to login looked like "nothing happens" in
					// browsers that block third-party cookies after a "successful" login.
					navigate('/admin/login', { replace: true, state: { reason: 'session' } })
				}
			})
		return () => {
			cancelled = true
		}
	}, [navigate])

	async function logout() {
		await api.adminLogout().catch(() => undefined)
		navigate('/admin/login', { replace: true })
	}

	if (authError) return null
	if (!ready) {
		return (
			<div className="min-h-screen flex items-center justify-center text-zinc-400">
				Checking session…
			</div>
		)
	}

	return (
		<div className="min-h-screen flex flex-col">
			<header className="border-b border-zinc-800 bg-zinc-950/80 px-4 py-3 flex items-center gap-6">
				<Link to="/admin" className="font-semibold text-white tracking-tight">
					AI Proxy · Admin
				</Link>
				<nav className="flex flex-wrap gap-1 text-sm">
					{nav.map((item) => (
						<NavLink
							key={item.to}
							to={item.to}
							className={({ isActive }) =>
								`rounded-md px-3 py-1.5 ${
									isActive
										? 'bg-zinc-800 text-white'
										: 'text-zinc-400 hover:text-white hover:bg-zinc-900'
								}`
							}
						>
							{item.label}
						</NavLink>
					))}
				</nav>
				<button
					type="button"
					onClick={logout}
					className="ml-auto text-sm text-zinc-400 hover:text-white"
				>
					Log out
				</button>
			</header>
			<main className="flex-1 p-4 md:p-6 max-w-6xl w-full mx-auto">
				<Outlet />
			</main>
		</div>
	)
}

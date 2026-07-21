import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, type CsamAction, type Role, type Settings } from '../lib/api'

function limitInput(v: number | null | undefined): string {
	if (v === null || v === undefined) return ''
	return String(v)
}

function parseLimit(s: string): number | null {
	const t = s.trim()
	if (t === '') return null
	const n = Number(t)
	if (!Number.isFinite(n) || n < 0) throw new Error('Limits must be non-negative numbers or empty')
	return Math.floor(n)
}

export default function SettingsPage() {
	const [settings, setSettings] = useState<Settings | null>(null)
	const [countTokens, setCountTokens] = useState(false)
	const [logPrompt, setLogPrompt] = useState(false)
	const [csamEnabled, setCsamEnabled] = useState(true)
	const [csamAction, setCsamAction] = useState<CsamAction>('log')
	const [guildId, setGuildId] = useState('')
	const [inviteUrl, setInviteUrl] = useState('')
	const [discordCmdsEnabled, setDiscordCmdsEnabled] = useState(false)
	const [statsChannelId, setStatsChannelId] = useState('')
	const [statsRoleId, setStatsRoleId] = useState('')
	const [statsEphemeral, setStatsEphemeral] = useState(true)
	const [assignChannelId, setAssignChannelId] = useState('')
	const [assignRoleId, setAssignRoleId] = useState('')
	const [assignTargetRoleId, setAssignTargetRoleId] = useState('')
	const [assignEphemeral, setAssignEphemeral] = useState(true)
	const [registeringCmds, setRegisteringCmds] = useState(false)
	const [registerMsg, setRegisterMsg] = useState<string | null>(null)
	const [loading, setLoading] = useState(true)
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [saved, setSaved] = useState(false)

	const [roles, setRoles] = useState<Role[]>([])
	const [rolesLoading, setRolesLoading] = useState(true)
	const [roleError, setRoleError] = useState<string | null>(null)

	// Create form
	const [newName, setNewName] = useState('')
	const [newDay, setNewDay] = useState('')
	const [newMinute, setNewMinute] = useState('')
	const [newTokDay, setNewTokDay] = useState('')
	const [newTokMinute, setNewTokMinute] = useState('')
	const [creating, setCreating] = useState(false)

	// Inline edit
	const [editId, setEditId] = useState<string | null>(null)
	const [editName, setEditName] = useState('')
	const [editDay, setEditDay] = useState('')
	const [editMinute, setEditMinute] = useState('')
	const [editTokDay, setEditTokDay] = useState('')
	const [editTokMinute, setEditTokMinute] = useState('')
	const [editBusy, setEditBusy] = useState(false)

	const loadRoles = useCallback(async () => {
		setRoleError(null)
		try {
			const res = await api.listRoles()
			setRoles(res.roles)
		} catch (e) {
			setRoleError(e instanceof Error ? e.message : 'Failed to load roles')
		} finally {
			setRolesLoading(false)
		}
	}, [])

	useEffect(() => {
		void api
			.getSettings()
			.then((r) => {
				setSettings(r.settings)
				setCountTokens(r.settings.count_tokens)
				setLogPrompt(r.settings.log_user_prompt)
				setCsamEnabled(r.settings.csam_scan_enabled !== false)
				setCsamAction(r.settings.csam_action === 'log_and_block' ? 'log_and_block' : 'log')
				setGuildId(r.settings.required_discord_guild_id ?? '')
				setInviteUrl(r.settings.discord_invite_url ?? '')
				setDiscordCmdsEnabled(Boolean(r.settings.discord_commands_enabled))
				setStatsChannelId(r.settings.discord_cmd_stats_channel_id ?? '')
				setStatsRoleId(r.settings.discord_cmd_stats_role_id ?? '')
				setStatsEphemeral(r.settings.discord_cmd_stats_ephemeral !== false)
				setAssignChannelId(r.settings.discord_cmd_assignrole_channel_id ?? '')
				setAssignRoleId(r.settings.discord_cmd_assignrole_role_id ?? '')
				setAssignTargetRoleId(r.settings.discord_cmd_assignrole_target_role_id ?? '')
				setAssignEphemeral(r.settings.discord_cmd_assignrole_ephemeral !== false)
			})
			.catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
			.finally(() => setLoading(false))
		void loadRoles()
	}, [loadRoles])

	async function onSave(e: FormEvent) {
		e.preventDefault()
		setSaving(true)
		setError(null)
		setSaved(false)
		try {
			const res = await api.patchSettings({
				count_tokens: countTokens,
				log_user_prompt: logPrompt,
				csam_scan_enabled: csamEnabled,
				csam_action: csamAction,
				required_discord_guild_id: guildId.trim() === '' ? null : guildId.trim(),
				discord_invite_url: inviteUrl.trim() === '' ? null : inviteUrl.trim(),
				discord_commands_enabled: discordCmdsEnabled,
				discord_cmd_stats_channel_id: statsChannelId.trim() === '' ? null : statsChannelId.trim(),
				discord_cmd_stats_role_id: statsRoleId.trim() === '' ? null : statsRoleId.trim(),
				discord_cmd_stats_ephemeral: statsEphemeral,
				discord_cmd_assignrole_channel_id:
					assignChannelId.trim() === '' ? null : assignChannelId.trim(),
				discord_cmd_assignrole_role_id: assignRoleId.trim() === '' ? null : assignRoleId.trim(),
				discord_cmd_assignrole_target_role_id:
					assignTargetRoleId.trim() === '' ? null : assignTargetRoleId.trim(),
				discord_cmd_assignrole_ephemeral: assignEphemeral,
			})
			setSettings(res.settings)
			setCsamEnabled(res.settings.csam_scan_enabled !== false)
			setCsamAction(res.settings.csam_action === 'log_and_block' ? 'log_and_block' : 'log')
			setGuildId(res.settings.required_discord_guild_id ?? '')
			setInviteUrl(res.settings.discord_invite_url ?? '')
			setDiscordCmdsEnabled(Boolean(res.settings.discord_commands_enabled))
			setStatsChannelId(res.settings.discord_cmd_stats_channel_id ?? '')
			setStatsRoleId(res.settings.discord_cmd_stats_role_id ?? '')
			setStatsEphemeral(res.settings.discord_cmd_stats_ephemeral !== false)
			setAssignChannelId(res.settings.discord_cmd_assignrole_channel_id ?? '')
			setAssignRoleId(res.settings.discord_cmd_assignrole_role_id ?? '')
			setAssignTargetRoleId(res.settings.discord_cmd_assignrole_target_role_id ?? '')
			setAssignEphemeral(res.settings.discord_cmd_assignrole_ephemeral !== false)
			setSaved(true)
			setTimeout(() => setSaved(false), 2000)
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Save failed')
		} finally {
			setSaving(false)
		}
	}

	async function createRole(e: FormEvent) {
		e.preventDefault()
		setCreating(true)
		setRoleError(null)
		try {
			await api.createRole({
				name: newName.trim(),
				requests_per_day: parseLimit(newDay),
				requests_per_minute: parseLimit(newMinute),
				tokens_per_day: parseLimit(newTokDay),
				tokens_per_minute: parseLimit(newTokMinute),
			})
			setNewName('')
			setNewDay('')
			setNewMinute('')
			setNewTokDay('')
			setNewTokMinute('')
			await loadRoles()
		} catch (err) {
			setRoleError(err instanceof Error ? err.message : 'Create failed')
		} finally {
			setCreating(false)
		}
	}

	function startEdit(r: Role) {
		setEditId(r.id)
		setEditName(r.name)
		setEditDay(limitInput(r.requests_per_day))
		setEditMinute(limitInput(r.requests_per_minute))
		setEditTokDay(limitInput(r.tokens_per_day))
		setEditTokMinute(limitInput(r.tokens_per_minute))
		setRoleError(null)
	}

	async function saveEdit() {
		if (!editId) return
		setEditBusy(true)
		setRoleError(null)
		try {
			await api.patchRole(editId, {
				name: editName.trim(),
				requests_per_day: parseLimit(editDay),
				requests_per_minute: parseLimit(editMinute),
				tokens_per_day: parseLimit(editTokDay),
				tokens_per_minute: parseLimit(editTokMinute),
			})
			setEditId(null)
			await loadRoles()
		} catch (err) {
			setRoleError(err instanceof Error ? err.message : 'Update failed')
		} finally {
			setEditBusy(false)
		}
	}

	async function makeDefault(r: Role) {
		if (r.is_default) return
		setRoleError(null)
		try {
			await api.patchRole(r.id, { is_default: true })
			await loadRoles()
		} catch (err) {
			setRoleError(err instanceof Error ? err.message : 'Update failed')
		}
	}

	async function removeRole(r: Role) {
		if (r.is_default) {
			setRoleError('Cannot delete the default role')
			return
		}
		const ok = window.confirm(
			`Delete role "${r.name}"?\n\nUsers still on this role must be reassigned first.`,
		)
		if (!ok) return
		setRoleError(null)
		try {
			await api.deleteRole(r.id)
			await loadRoles()
		} catch (err) {
			setRoleError(err instanceof Error ? err.message : 'Delete failed')
		}
	}

	async function registerDiscordCommands() {
		setRegisteringCmds(true)
		setRegisterMsg(null)
		setError(null)
		try {
			const res = await api.registerDiscordCommands()
			setRegisterMsg(
				`Registered ${res.count} command(s) on guild ${res.guild_id}: ${res.commands.join(', ')}`,
			)
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Register commands failed')
		} finally {
			setRegisteringCmds(false)
		}
	}

	if (loading) {
		return <p className="text-sm text-zinc-500">Loading…</p>
	}

	return (
		<div className="space-y-8 max-w-2xl">
			<div>
				<h1 className="text-2xl font-semibold text-white">Settings</h1>
				<p className="text-sm text-zinc-400 mt-1">
					Proxy behavior and custom roles. Rate limits and channel access are per role.
				</p>
			</div>

			{error && (
				<div className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
					{error}
				</div>
			)}

			<form
				onSubmit={onSave}
				className="space-y-5 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5"
			>
				<h2 className="text-lg font-medium text-white">Proxy behavior</h2>
				<label className="flex items-center justify-between gap-4">
					<span>
						<span className="block text-sm text-white">Count tokens</span>
						<span className="text-xs text-zinc-500">
							When on, use gpt-tokenizer after the stream; when off, use provider usage.
						</span>
					</span>
					<input
						type="checkbox"
						checked={countTokens}
						onChange={(e) => setCountTokens(e.target.checked)}
						className="h-4 w-4"
					/>
				</label>

				<label className="flex items-center justify-between gap-4">
					<span>
						<span className="block text-sm text-white">Log user prompts</span>
						<span className="text-xs text-zinc-500">
							Store full prompt/response JSON on each log row (global). Per-user and CSAM
							force-log still apply when this is off.
						</span>
					</span>
					<input
						type="checkbox"
						checked={logPrompt}
						onChange={(e) => setLogPrompt(e.target.checked)}
						className="h-4 w-4"
					/>
				</label>

				<div className="border-t border-zinc-800 pt-5 space-y-4">
					<div>
						<h3 className="text-sm font-medium text-white">CSAM shield</h3>
						<p className="text-xs text-zinc-500 mt-1">
							CSAM Shield v6.0 — scans request content only (fast, no stream buffering).
							Hits are always logged with forced prompt capture. Blocking is optional.
						</p>
					</div>
					<label className="flex items-center justify-between gap-4">
						<span>
							<span className="block text-sm text-white">Enable CSAM shield</span>
							<span className="text-xs text-zinc-500">
								When off, no scan runs. When on, flags go to Logs → CSAM.
							</span>
						</span>
						<input
							type="checkbox"
							checked={csamEnabled}
							onChange={(e) => setCsamEnabled(e.target.checked)}
							className="h-4 w-4"
						/>
					</label>
					<div className={csamEnabled ? '' : 'opacity-50 pointer-events-none'}>
						<p className="text-sm text-white mb-2">On detection</p>
						<div className="space-y-2">
							<label className="flex items-start gap-3 cursor-pointer">
								<input
									type="radio"
									name="csam_action"
									className="mt-1"
									checked={csamAction === 'log'}
									onChange={() => setCsamAction('log')}
								/>
								<span>
									<span className="block text-sm text-zinc-200">Log only</span>
									<span className="text-xs text-zinc-500">
										Flag + force prompt log + sticky per-user logging. Request continues
										(recommended for RP-heavy use).
									</span>
								</span>
							</label>
							<label className="flex items-start gap-3 cursor-pointer">
								<input
									type="radio"
									name="csam_action"
									className="mt-1"
									checked={csamAction === 'log_and_block'}
									onChange={() => setCsamAction('log_and_block')}
								/>
								<span>
									<span className="block text-sm text-zinc-200">Log and block</span>
									<span className="text-xs text-zinc-500">
										Same logging, then HTTP 400 (code CSAM_SHIELD) before the upstream call.
									</span>
								</span>
							</label>
						</div>
					</div>
				</div>

				<div className="border-t border-zinc-800 pt-5 space-y-4">
					<div>
						<h3 className="text-sm font-medium text-white">Discord server gate (optional)</h3>
						<p className="text-xs text-zinc-500 mt-1">
							When a server ID is set, only members of that Discord server stay active.
							Non-members can still log in, but their account is disabled until they join.
							Requires Worker secret <span className="font-mono">DISCORD_BOT_TOKEN</span> (bot
							in the server + Server Members Intent). Leave empty to allow anyone.
						</p>
					</div>
					<div>
						<label className="block text-sm text-white mb-1">Required Discord server ID</label>
						<input
							className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white font-mono"
							placeholder="leave empty to allow anyone"
							value={guildId}
							onChange={(e) => setGuildId(e.target.value)}
						/>
						<p className="text-[11px] text-zinc-500 mt-1">
							Snowflake ID (Developer Mode → right-click server → Copy Server ID).
						</p>
					</div>
					<div>
						<label className="block text-sm text-white mb-1">Discord invite link</label>
						<input
							className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white"
							placeholder="https://discord.gg/…"
							value={inviteUrl}
							onChange={(e) => setInviteUrl(e.target.value)}
						/>
						<p className="text-[11px] text-zinc-500 mt-1">
							Shown on the disabled account screen so users can join.
						</p>
					</div>
				</div>

				<div className="border-t border-zinc-800 pt-5 space-y-5">
					<div>
						<h3 className="text-sm font-medium text-white">Discord commands</h3>
						<p className="text-xs text-zinc-500 mt-1">
							Slash commands handled by the Worker at{' '}
							<span className="font-mono">/api/discord/interactions</span>. Requires secrets{' '}
							<span className="font-mono">DISCORD_BOT_TOKEN</span>,{' '}
							<span className="font-mono">DISCORD_PUBLIC_KEY</span>,{' '}
							<span className="font-mono">DISCORD_APPLICATION_ID</span>, bot invited with{' '}
							<span className="font-mono">applications.commands</span> + Manage Roles, and
							Interactions Endpoint URL pointing at your site. Guild registration uses the
							server ID above.
						</p>
					</div>

					<label className="flex items-center justify-between gap-4">
						<span>
							<span className="block text-sm text-white">Enable Discord commands</span>
							<span className="text-xs text-zinc-500">
								When off, interactions reply that commands are disabled.
							</span>
						</span>
						<input
							type="checkbox"
							checked={discordCmdsEnabled}
							onChange={(e) => setDiscordCmdsEnabled(e.target.checked)}
							className="h-4 w-4"
						/>
					</label>

					<div
						className={`space-y-5 ${discordCmdsEnabled ? '' : 'opacity-50 pointer-events-none'}`}
					>
						<div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 space-y-3">
							<p className="text-sm font-medium text-white">/stats</p>
							<p className="text-xs text-zinc-500">
								Shows personal proxy usage. Optional user argument looks up that Discord
								user; unregistered users get a clear message.
							</p>
							<div className="grid gap-3 sm:grid-cols-2">
								<div>
									<label className="block text-xs text-zinc-400 mb-1">
										Channel ID (optional)
									</label>
									<input
										className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white font-mono"
										placeholder="any channel if empty"
										value={statsChannelId}
										onChange={(e) => setStatsChannelId(e.target.value)}
									/>
								</div>
								<div>
									<label className="block text-xs text-zinc-400 mb-1">
										Required role ID (optional)
									</label>
									<input
										className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white font-mono"
										placeholder="any role if empty"
										value={statsRoleId}
										onChange={(e) => setStatsRoleId(e.target.value)}
									/>
								</div>
							</div>
							<label className="flex items-center justify-between gap-4">
								<span className="text-sm text-zinc-200">Ephemeral reply</span>
								<input
									type="checkbox"
									checked={statsEphemeral}
									onChange={(e) => setStatsEphemeral(e.target.checked)}
									className="h-4 w-4"
								/>
							</label>
						</div>

						<div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 space-y-3">
							<p className="text-sm font-medium text-white">/assignrole</p>
							<p className="text-xs text-zinc-500">
								Admin tool: assign the target role to up to 5 users (user1…user5). Bot role
								must be above the target role and have Manage Roles.
							</p>
							<div className="grid gap-3 sm:grid-cols-2">
								<div>
									<label className="block text-xs text-zinc-400 mb-1">
										Channel ID (optional)
									</label>
									<input
										className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white font-mono"
										placeholder="any channel if empty"
										value={assignChannelId}
										onChange={(e) => setAssignChannelId(e.target.value)}
									/>
								</div>
								<div>
									<label className="block text-xs text-zinc-400 mb-1">
										Runner role ID (optional)
									</label>
									<input
										className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white font-mono"
										placeholder="who may run the command"
										value={assignRoleId}
										onChange={(e) => setAssignRoleId(e.target.value)}
									/>
								</div>
								<div className="sm:col-span-2">
									<label className="block text-xs text-zinc-400 mb-1">
										Target role ID (assigned)
									</label>
									<input
										className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white font-mono"
										placeholder="role the bot grants"
										value={assignTargetRoleId}
										onChange={(e) => setAssignTargetRoleId(e.target.value)}
									/>
								</div>
							</div>
							<label className="flex items-center justify-between gap-4">
								<span className="text-sm text-zinc-200">Ephemeral reply</span>
								<input
									type="checkbox"
									checked={assignEphemeral}
									onChange={(e) => setAssignEphemeral(e.target.checked)}
									className="h-4 w-4"
								/>
							</label>
						</div>

						<div className="flex flex-wrap items-center gap-3">
							<button
								type="button"
								disabled={registeringCmds}
								onClick={() => void registerDiscordCommands()}
								className="rounded-lg border border-zinc-600 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 px-3 py-2 text-sm text-white"
							>
								{registeringCmds ? 'Registering…' : 'Register slash commands'}
							</button>
							{registerMsg && (
								<span className="text-xs text-emerald-400">{registerMsg}</span>
							)}
						</div>
					</div>
				</div>

				<div className="flex items-center gap-3">
					<button
						type="submit"
						disabled={saving}
						className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 px-4 py-2 text-sm font-medium text-white"
					>
						{saving ? 'Saving…' : 'Save'}
					</button>
					{saved && <span className="text-sm text-emerald-400">Saved</span>}
					{settings?.updated_at && (
						<span className="text-xs text-zinc-500 ml-auto">
							Updated {new Date(settings.updated_at).toLocaleString()}
						</span>
					)}
				</div>
			</form>

			<section className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
				<div>
					<h2 className="text-lg font-medium text-white">Roles</h2>
					<p className="text-xs text-zinc-500 mt-1">
						Each role has requests and tokens per day / minute (leave empty for
						unlimited). Tokens = prompt + completion on successful calls. New and
						existing users without a role get the Default role. Assign roles on the Users
						page; restrict channels on the Channels page.
					</p>
				</div>

				{roleError && (
					<div className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
						{roleError}
					</div>
				)}

				<form onSubmit={createRole} className="grid gap-2 sm:grid-cols-6 items-end">
					<div className="sm:col-span-1">
						<label className="block text-xs text-zinc-400 mb-1">Name</label>
						<input
							className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white"
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
							placeholder="VIP"
							required
						/>
					</div>
					<div>
						<label className="block text-xs text-zinc-400 mb-1">Req/day</label>
						<input
							type="number"
							min={0}
							className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white"
							value={newDay}
							onChange={(e) => setNewDay(e.target.value)}
							placeholder="∞"
						/>
					</div>
					<div>
						<label className="block text-xs text-zinc-400 mb-1">Req/min</label>
						<input
							type="number"
							min={0}
							className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white"
							value={newMinute}
							onChange={(e) => setNewMinute(e.target.value)}
							placeholder="∞"
						/>
					</div>
					<div>
						<label className="block text-xs text-zinc-400 mb-1">Tok/day</label>
						<input
							type="number"
							min={0}
							className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white"
							value={newTokDay}
							onChange={(e) => setNewTokDay(e.target.value)}
							placeholder="∞"
						/>
					</div>
					<div>
						<label className="block text-xs text-zinc-400 mb-1">Tok/min</label>
						<input
							type="number"
							min={0}
							className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white"
							value={newTokMinute}
							onChange={(e) => setNewTokMinute(e.target.value)}
							placeholder="∞"
						/>
					</div>
					<button
						type="submit"
						disabled={creating || !newName.trim()}
						className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 px-3 py-2 text-sm font-medium text-white"
					>
						{creating ? 'Adding…' : 'Add role'}
					</button>
				</form>

				{rolesLoading ? (
					<p className="text-sm text-zinc-500">Loading roles…</p>
				) : roles.length === 0 ? (
					<p className="text-sm text-zinc-500">
						No roles yet. Run the 002_roles migration to seed Default.
					</p>
				) : (
					<div className="overflow-x-auto rounded-lg border border-zinc-800">
						<table className="w-full text-sm text-left">
							<thead className="bg-zinc-950 text-zinc-400">
								<tr>
									<th className="px-3 py-2 font-medium">Name</th>
									<th className="px-3 py-2 font-medium">Req/day</th>
									<th className="px-3 py-2 font-medium">Req/min</th>
									<th className="px-3 py-2 font-medium">Tok/day</th>
									<th className="px-3 py-2 font-medium">Tok/min</th>
									<th className="px-3 py-2 font-medium">Default</th>
									<th className="px-3 py-2 font-medium" />
								</tr>
							</thead>
							<tbody className="divide-y divide-zinc-800">
								{roles.map((r) =>
									editId === r.id ? (
										<tr key={r.id} className="bg-zinc-950/60">
											<td className="px-3 py-2">
												<input
													className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-white"
													value={editName}
													onChange={(e) => setEditName(e.target.value)}
												/>
											</td>
											<td className="px-3 py-2">
												<input
													type="number"
													min={0}
													className="w-20 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-white"
													value={editDay}
													onChange={(e) => setEditDay(e.target.value)}
													placeholder="∞"
												/>
											</td>
											<td className="px-3 py-2">
												<input
													type="number"
													min={0}
													className="w-20 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-white"
													value={editMinute}
													onChange={(e) => setEditMinute(e.target.value)}
													placeholder="∞"
												/>
											</td>
											<td className="px-3 py-2">
												<input
													type="number"
													min={0}
													className="w-24 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-white"
													value={editTokDay}
													onChange={(e) => setEditTokDay(e.target.value)}
													placeholder="∞"
												/>
											</td>
											<td className="px-3 py-2">
												<input
													type="number"
													min={0}
													className="w-24 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-white"
													value={editTokMinute}
													onChange={(e) => setEditTokMinute(e.target.value)}
													placeholder="∞"
												/>
											</td>
											<td className="px-3 py-2 text-zinc-400 text-xs">
												{r.is_default ? 'Yes' : '—'}
											</td>
											<td className="px-3 py-2 text-right space-x-2 whitespace-nowrap">
												<button
													type="button"
													disabled={editBusy}
													onClick={() => void saveEdit()}
													className="text-xs text-emerald-400 hover:underline disabled:opacity-50"
												>
													Save
												</button>
												<button
													type="button"
													disabled={editBusy}
													onClick={() => setEditId(null)}
													className="text-xs text-zinc-400 hover:underline"
												>
													Cancel
												</button>
											</td>
										</tr>
									) : (
										<tr key={r.id} className="bg-zinc-950/40">
											<td className="px-3 py-2 text-white font-medium">{r.name}</td>
											<td className="px-3 py-2 text-zinc-300 tabular-nums">
												{r.requests_per_day ?? '∞'}
											</td>
											<td className="px-3 py-2 text-zinc-300 tabular-nums">
												{r.requests_per_minute ?? '∞'}
											</td>
											<td className="px-3 py-2 text-zinc-300 tabular-nums">
												{r.tokens_per_day ?? '∞'}
											</td>
											<td className="px-3 py-2 text-zinc-300 tabular-nums">
												{r.tokens_per_minute ?? '∞'}
											</td>
											<td className="px-3 py-2">
												{r.is_default ? (
													<span className="rounded-full bg-violet-950 text-violet-300 px-2 py-0.5 text-xs">
														Default
													</span>
												) : (
													<button
														type="button"
														onClick={() => void makeDefault(r)}
														className="text-xs text-zinc-500 hover:text-violet-400"
													>
														Make default
													</button>
												)}
											</td>
											<td className="px-3 py-2 text-right space-x-3 whitespace-nowrap">
												<button
													type="button"
													onClick={() => startEdit(r)}
													className="text-xs text-violet-400 hover:underline"
												>
													Edit
												</button>
												{!r.is_default && (
													<button
														type="button"
														onClick={() => void removeRole(r)}
														className="text-xs text-red-400 hover:underline"
													>
														Delete
													</button>
												)}
											</td>
										</tr>
									),
								)}
							</tbody>
						</table>
					</div>
				)}
			</section>
		</div>
	)
}

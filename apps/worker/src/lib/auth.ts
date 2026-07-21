import type { Context } from 'hono'
import type { Env } from '../types'

const COOKIE_NAME = 'owner_session'
export const OWNER_SESSION_HEADER = 'X-Owner-Session'
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
	const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
	let binary = ''
	for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]!)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): Uint8Array {
	const normalized = s.replace(/-/g, '+').replace(/_/g, '/')
	const pad = (4 - (normalized.length % 4)) % 4
	const padded = normalized + '='.repeat(pad)
	const binary = atob(padded)
	const out = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
	return out
}

async function hmacSign(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
	return toBase64Url(sig)
}

async function hmacVerify(secret: string, message: string, signature: string): Promise<boolean> {
	const expected = await hmacSign(secret, message)
	if (expected.length !== signature.length) return false
	let ok = 0
	for (let i = 0; i < expected.length; i++) ok |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
	return ok === 0
}

export async function createOwnerSessionToken(env: Env, login: string): Promise<string> {
	const exp = Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS
	// Always sign with the canonical env login (trimmed) so verify matches.
	const canonical = (login || env.OWNER_LOGIN || '').trim()
	const payload = `${canonical}:${exp}`
	const sig = await hmacSign(env.SESSION_SECRET.trim(), payload)
	return `${toBase64Url(new TextEncoder().encode(payload))}.${sig}`
}

export async function verifyOwnerSessionToken(env: Env, token: string): Promise<boolean> {
	const parts = token.split('.')
	if (parts.length !== 2) return false
	const [payloadB64, sig] = parts
	if (!payloadB64 || !sig) return false
	let payload: string
	try {
		payload = new TextDecoder().decode(fromBase64Url(payloadB64))
	} catch {
		return false
	}
	const valid = await hmacVerify(env.SESSION_SECRET.trim(), payload, sig)
	if (!valid) return false
	// Payload is `login:exp` — split on last ':' so login can contain colons
	const colon = payload.lastIndexOf(':')
	if (colon <= 0) return false
	const login = payload.slice(0, colon)
	const expStr = payload.slice(colon + 1)
	if (!login || !expStr) return false
	if (login !== (env.OWNER_LOGIN ?? '').trim()) return false
	const exp = Number(expStr)
	if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false
	return true
}

export function setOwnerSessionCookie(c: Context<{ Bindings: Env }>, token: string): void {
	const secure = new URL(c.req.url).protocol === 'https:'
	// Prefer Lax when same-site (Pages reverse-proxy). None only needed for true
	// cross-site Worker URL; both work with Secure on HTTPS.
	const sameSite = secure ? 'None' : 'Lax'
	const parts = [
		`${COOKIE_NAME}=${token}`,
		'Path=/',
		'HttpOnly',
		`SameSite=${sameSite}`,
		`Max-Age=${MAX_AGE_SECONDS}`,
	]
	if (secure) parts.push('Secure')
	c.header('Set-Cookie', parts.join('; '), { append: true })
}

export function clearOwnerSessionCookie(c: Context<{ Bindings: Env }>): void {
	const secure = new URL(c.req.url).protocol === 'https:'
	const parts = [
		`${COOKIE_NAME}=`,
		'Path=/',
		'HttpOnly',
		`SameSite=${secure ? 'None' : 'Lax'}`,
		'Max-Age=0',
	]
	if (secure) parts.push('Secure')
	c.header('Set-Cookie', parts.join('; '), { append: true })
}

export function getOwnerSessionCookie(c: Context<{ Bindings: Env }>): string | null {
	const header = c.req.header('Cookie')
	if (!header) return null
	for (const part of header.split(';')) {
		const [k, ...rest] = part.trim().split('=')
		if (k === COOKIE_NAME) return rest.join('=') || null
	}
	return null
}

/**
 * Owner session from (in order):
 * 1. `X-Owner-Session` header (preferred — not blocked by third-party cookie policy)
 * 2. `Authorization: Bearer <token>`
 * 3. HttpOnly cookie `owner_session`
 */
export function getOwnerSessionToken(c: Context<{ Bindings: Env }>): string | null {
	const custom = c.req.header(OWNER_SESSION_HEADER)?.trim()
	if (custom) return custom

	const auth = c.req.header('Authorization')
	if (auth?.startsWith('Bearer ')) {
		const bearer = auth.slice(7).trim()
		if (bearer) return bearer
	}
	return getOwnerSessionCookie(c)
}

export type OwnerAuthFailReason = 'no_token' | 'invalid_token'

export async function requireOwnerSession(c: Context<{ Bindings: Env }>): Promise<boolean> {
	const token = getOwnerSessionToken(c)
	if (!token) return false
	return verifyOwnerSessionToken(c.env, token)
}

export async function ownerAuthStatus(
	c: Context<{ Bindings: Env }>,
): Promise<{ ok: true } | { ok: false; reason: OwnerAuthFailReason }> {
	const token = getOwnerSessionToken(c)
	if (!token) return { ok: false, reason: 'no_token' }
	const valid = await verifyOwnerSessionToken(c.env, token)
	if (!valid) return { ok: false, reason: 'invalid_token' }
	return { ok: true }
}

export function generateApiKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(24))
	return `sk-${toBase64Url(bytes).slice(0, 32)}`
}

export async function verifyUserJwt(
	env: Env,
	authHeader: string | undefined,
): Promise<{ id: string; email?: string; user_metadata?: Record<string, unknown> } | null> {
	if (!authHeader?.startsWith('Bearer ')) return null
	const jwt = authHeader.slice(7)
	const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
		headers: {
			Authorization: `Bearer ${jwt}`,
			apikey: env.SUPABASE_SERVICE_ROLE_KEY,
		},
	})
	if (!res.ok) return null
	const data = (await res.json()) as {
		id?: string
		email?: string
		user_metadata?: Record<string, unknown>
	}
	if (!data.id) return null
	return { id: data.id, email: data.email, user_metadata: data.user_metadata }
}

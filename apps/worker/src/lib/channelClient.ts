export function normalizeBaseUrl(url: string): string {
	// Strip trailing slashes, then a trailing `/v1` — we always append `/v1/...`
	// ourselves, so accepting either `https://host` or `https://host/v1` avoids a
	// double `/v1/v1/...` that 404s.
	return url
		.trim()
		.replace(/\/+$/, '')
		.replace(/\/v1$/, '')
}

/** Default headers many OpenAI-compatible gateways / CF-protected hosts expect. */
function defaultUpstreamHeaders(baseUrl: string): Headers {
	const headers = new Headers()
	headers.set('Content-Type', 'application/json')
	headers.set('Accept', 'application/json')
	// Some resellers sit behind Cloudflare bot protection; a browser-like UA
	// + referer from the provider host reduces false 403s on Worker egress IPs.
	headers.set(
		'User-Agent',
		'Mozilla/5.0 (compatible; AI-Proxy-Platform/1.0; +https://github.com/ai-proxy-platform)',
	)
	try {
		const origin = new URL(normalizeBaseUrl(baseUrl)).origin
		headers.set('Referer', `${origin}/`)
		headers.set('Origin', origin)
	} catch {
		// ignore invalid base URL — caller will fail on fetch
	}
	return headers
}

export async function forwardToChannel(
	baseUrl: string,
	apiKey: string,
	path: string,
	init: {
		method?: string
		body?: string
		headers?: HeadersInit
	},
): Promise<Response> {
	const url = `${normalizeBaseUrl(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`
	const headers = defaultUpstreamHeaders(baseUrl)
	if (init.headers) {
		const extra = new Headers(init.headers)
		extra.forEach((v, k) => headers.set(k, v))
	}
	headers.set('Authorization', `Bearer ${apiKey}`)
	if (!init.body) {
		headers.delete('Content-Type')
	}
	// Do not forward hop-by-hop / host headers from client
	headers.delete('host')
	headers.delete('content-length')
	headers.delete('connection')

	return fetch(url, {
		method: init.method ?? 'POST',
		headers,
		body: init.body,
	})
}

/** Pass-through response headers safe for clients */
export function passthroughHeaders(upstream: Response): Headers {
	const out = new Headers()
	const allow = [
		'content-type',
		'cache-control',
		'x-request-id',
		'openai-processing-ms',
		'openai-version',
		'x-ratelimit-limit-requests',
		'x-ratelimit-remaining-requests',
		'x-ratelimit-limit-tokens',
		'x-ratelimit-remaining-tokens',
	]
	for (const key of allow) {
		const v = upstream.headers.get(key)
		if (v) out.set(key, v)
	}
	return out
}

export type CapturedUsage = {
	prompt_tokens: number | null
	completion_tokens: number | null
	responseText: string
	responseJson: unknown | null
}

/** Consume a tee'd stream branch; extract usage from JSON or SSE. */
export async function consumeForLogging(
	stream: ReadableStream<Uint8Array> | null,
	isStreaming: boolean,
): Promise<CapturedUsage> {
	const empty: CapturedUsage = {
		prompt_tokens: null,
		completion_tokens: null,
		responseText: '',
		responseJson: null,
	}
	if (!stream) return empty

	const reader = stream.getReader()
	const decoder = new TextDecoder()
	let text = ''
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			if (value) text += decoder.decode(value, { stream: true })
		}
		text += decoder.decode()
	} catch {
		return { ...empty, responseText: text }
	}

	if (!isStreaming) {
		try {
			const json = JSON.parse(text) as {
				usage?: { prompt_tokens?: number; completion_tokens?: number }
			}
			return {
				prompt_tokens: json.usage?.prompt_tokens ?? null,
				completion_tokens: json.usage?.completion_tokens ?? null,
				responseText: text,
				responseJson: json,
			}
		} catch {
			return { ...empty, responseText: text }
		}
	}

	// SSE: scan data: lines for usage (often in final chunk)
	let prompt_tokens: number | null = null
	let completion_tokens: number | null = null
	let lastJson: unknown = null
	const contentParts: string[] = []

	for (const line of text.split('\n')) {
		const trimmed = line.trim()
		if (!trimmed.startsWith('data:')) continue
		const data = trimmed.slice(5).trim()
		if (!data || data === '[DONE]') continue
		try {
			const json = JSON.parse(data) as {
				usage?: { prompt_tokens?: number; completion_tokens?: number }
				choices?: { delta?: { content?: string }; message?: { content?: string } }[]
			}
			lastJson = json
			if (json.usage) {
				if (typeof json.usage.prompt_tokens === 'number') prompt_tokens = json.usage.prompt_tokens
				if (typeof json.usage.completion_tokens === 'number') {
					completion_tokens = json.usage.completion_tokens
				}
			}
			const delta = json.choices?.[0]?.delta?.content
			if (typeof delta === 'string') contentParts.push(delta)
		} catch {
			// ignore malformed SSE lines
		}
	}

	return {
		prompt_tokens,
		completion_tokens,
		responseText: contentParts.join(''),
		responseJson: lastJson,
	}
}

/** Truncate large upstream bodies for log storage / admin UI. */
export function truncateForLog(value: unknown, max = 8000): unknown {
	if (value === null || value === undefined) return value
	if (typeof value === 'string') {
		return value.length > max ? `${value.slice(0, max)}…[truncated]` : value
	}
	try {
		const s = JSON.stringify(value)
		if (s.length <= max) return value
		return { _truncated: true, preview: s.slice(0, max) }
	} catch {
		return String(value).slice(0, max)
	}
}

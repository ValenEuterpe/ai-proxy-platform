/**
 * Reverse-proxy a Pages request to the Cloudflare Worker so the SPA and API
 * share one origin (e.g. brunway.pages.dev).
 */

const DEFAULT_WORKER = 'https://ai-proxy-worker.brunwayproxy.workers.dev'

type PagesEnv = {
	WORKER_URL?: string
}

export async function proxyToWorker(context: {
	request: Request
	env: PagesEnv
}): Promise<Response> {
	const workerOrigin = (context.env.WORKER_URL || DEFAULT_WORKER).replace(/\/+$/, '')
	const incoming = new URL(context.request.url)
	const targetUrl = `${workerOrigin}${incoming.pathname}${incoming.search}`

	const headers = new Headers(context.request.headers)
	headers.delete('host')
	headers.delete('cf-connecting-ip')
	headers.delete('content-length')

	const method = context.request.method
	const init: RequestInit = {
		method,
		headers,
		redirect: 'manual',
	}

	if (method !== 'GET' && method !== 'HEAD') {
		init.body = context.request.body
		;(init as RequestInit & { duplex?: string }).duplex = 'half'
	}

	let upstream: Response
	try {
		upstream = await fetch(targetUrl, init)
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e)
		return new Response(JSON.stringify({ error: `Proxy failed: ${msg}`, target: targetUrl }), {
			status: 502,
			headers: { 'Content-Type': 'application/json' },
		})
	}

	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers: new Headers(upstream.headers),
	})
}

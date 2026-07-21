import { proxyToWorker } from '../_lib/proxy'

/** Proxy /v1/* → Worker (OpenAI-compatible public API). */
export const onRequest = (context: {
	request: Request
	env: { WORKER_URL?: string }
}) => proxyToWorker(context)

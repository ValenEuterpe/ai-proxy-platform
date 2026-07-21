import { proxyToWorker } from '../_lib/proxy'

/** Proxy /api/* → Worker (admin + user APIs). */
export const onRequest = (context: {
	request: Request
	env: { WORKER_URL?: string }
}) => proxyToWorker(context)

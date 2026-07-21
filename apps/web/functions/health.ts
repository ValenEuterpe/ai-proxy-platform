import { proxyToWorker } from './_lib/proxy'

/** Proxy /health → Worker. */
export const onRequest = (context: {
	request: Request
	env: { WORKER_URL?: string }
}) => proxyToWorker(context)

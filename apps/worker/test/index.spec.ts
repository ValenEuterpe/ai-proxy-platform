import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import worker from '../src/index'

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>

describe('worker', () => {
	it('health (unit)', async () => {
		const request = new IncomingRequest('http://example.com/health')
		const ctx = createExecutionContext()
		const response = await worker.fetch(request, env as never, ctx)
		await waitOnExecutionContext(ctx)
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ ok: true })
	})

	it('health (integration)', async () => {
		const response = await SELF.fetch('https://example.com/health')
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ ok: true })
	})
})

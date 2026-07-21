import { Hono } from 'hono'
import { createServiceClient } from '../lib/db'
import { listExposedModelsWithStats } from '../lib/exposedModels'
import type { Env } from '../types'

/** Unauthenticated public read APIs — mounted at /api/public */
const publicRoutes = new Hono<{ Bindings: Env }>()

/**
 * Exposed models + success rates for the landing page.
 * Read-only aggregates only — no keys, channel secrets, or user data.
 */
publicRoutes.get('/models', async (c) => {
	const db = createServiceClient(c.env)
	const { models, error } = await listExposedModelsWithStats(db)
	if (error) return c.json({ error }, 500)
	return c.json({ models })
})

export default publicRoutes

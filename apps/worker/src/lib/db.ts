import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../types'

export function createServiceClient(env: Env): SupabaseClient {
	return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
		auth: {
			autoRefreshToken: false,
			persistSession: false,
		},
	})
}

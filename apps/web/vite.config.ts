import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		// Local dev: SPA on :5173, API on Worker :8787 — same-origin relative /api works.
		proxy: {
			'/api': 'http://localhost:8787',
			'/v1': 'http://localhost:8787',
			'/health': 'http://localhost:8787',
		},
	},
})

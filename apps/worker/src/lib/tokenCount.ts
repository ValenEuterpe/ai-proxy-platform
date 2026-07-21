import { encode } from 'gpt-tokenizer'

/** Optional exact counting; when count_tokens is off, use provider usage instead. */

export function countTokens(text: string): number {
	if (!text) return 0
	try {
		return encode(text).length
	} catch {
		return Math.ceil(text.length / 4)
	}
}

/** @deprecated use countTokens */
export function estimateTokensFromText(text: string): number {
	return countTokens(text)
}

export function extractTextFromMessages(messages: unknown): string {
	if (!Array.isArray(messages)) return ''
	const parts: string[] = []
	for (const m of messages) {
		if (!m || typeof m !== 'object') continue
		const content = (m as { content?: unknown }).content
		if (typeof content === 'string') parts.push(content)
		else if (Array.isArray(content)) {
			for (const part of content) {
				if (typeof part === 'string') parts.push(part)
				else if (part && typeof part === 'object' && 'text' in part) {
					const t = (part as { text?: unknown }).text
					if (typeof t === 'string') parts.push(t)
				}
			}
		}
	}
	return parts.join('\n')
}

export function extractTextFromCompletion(body: unknown): string {
	if (!body || typeof body !== 'object') return ''
	const choices = (body as { choices?: unknown }).choices
	if (!Array.isArray(choices)) return ''
	const parts: string[] = []
	for (const ch of choices) {
		if (!ch || typeof ch !== 'object') continue
		const message = (ch as { message?: { content?: unknown }; text?: unknown }).message
		const text = (ch as { text?: unknown }).text
		if (typeof text === 'string') parts.push(text)
		if (message && typeof message.content === 'string') parts.push(message.content)
	}
	return parts.join('\n')
}

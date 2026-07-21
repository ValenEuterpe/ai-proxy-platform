/**
 * Public model ids are namespaced by channel: `<channelName>/<rawModelId>`.
 * A raw model id may itself contain slashes (e.g. OpenRouter's `openai/gpt-4o`
 * becomes public `bil/openai/gpt-4o`), so we split on the FIRST slash only:
 * the prefix is the channel name, the remainder is the raw upstream model id.
 */

export type ParsedModelId = {
	channelName: string
	rawModelId: string
}

/** Split a public model id into channel name + raw model id. Returns null if not namespaced. */
export function parsePublicModelId(publicModel: string): ParsedModelId | null {
	const idx = publicModel.indexOf('/')
	if (idx <= 0) return null
	const channelName = publicModel.slice(0, idx)
	const rawModelId = publicModel.slice(idx + 1)
	if (!channelName || !rawModelId) return null
	return { channelName, rawModelId }
}

/** Build the public model id from a channel name and raw model id. */
export function buildPublicModelId(channelName: string, rawModelId: string): string {
	return `${channelName}/${rawModelId}`
}

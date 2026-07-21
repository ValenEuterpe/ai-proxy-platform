/** Discord interaction Ed25519 signature verification (Web Crypto). */

function hexToBytes(hex: string): Uint8Array {
	const clean = hex.trim().toLowerCase()
	if (clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) {
		throw new Error('Invalid hex string')
	}
	const out = new Uint8Array(clean.length / 2)
	for (let i = 0; i < out.length; i++) {
		out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
	}
	return out
}

/**
 * Verify Discord request signature.
 * message = timestamp + raw body; signature and public key are hex.
 */
export async function verifyDiscordInteraction(
	publicKeyHex: string,
	signatureHex: string,
	timestamp: string,
	rawBody: string,
): Promise<boolean> {
	const pk = publicKeyHex?.trim()
	const sig = signatureHex?.trim()
	const ts = timestamp?.trim()
	if (!pk || !sig || !ts) return false

	try {
		const keyData = hexToBytes(pk)
		const signature = hexToBytes(sig)
		const message = new TextEncoder().encode(ts + rawBody)

		const key = await crypto.subtle.importKey('raw', keyData, { name: 'Ed25519' }, false, [
			'verify',
		])
		return await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, message)
	} catch {
		return false
	}
}

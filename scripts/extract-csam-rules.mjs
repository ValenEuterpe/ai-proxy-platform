import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = fs.readFileSync(path.join(root, 'message.txt'), 'utf8')

function extractList(name) {
	const re = new RegExp(name + String.raw`\s*=\s*\[([\s\S]*?)\n\]`)
	const m = src.match(re)
	if (!m) throw new Error('no ' + name)
	return m[1]
}

/** Extract string literals from a Python list body (handles r"..." and normal quotes). */
function extractStrings(body) {
	const out = []
	// strip comments
	const cleaned = body.replace(/#.*$/gm, '')
	const re = /r?(["'])((?:\\.|(?!\1).)*)\1/g
	let m
	while ((m = re.exec(cleaned)) !== null) {
		let s = m[2]
		// unescape common sequences
		s = s
			.replace(/\\n/g, '\n')
			.replace(/\\t/g, '\t')
			.replace(/\\r/g, '\r')
			.replace(/\\"/g, '"')
			.replace(/\\'/g, "'")
			.replace(/\\\\/g, '\\')
		out.push(s)
	}
	return out
}

const names = [
	'ALWAYS_BLOCKED',
	'JAILBREAK_PATTERNS',
	'AGE_PATTERNS',
	'SEXUAL_TERMS',
	'OOC_MINOR_PATTERNS',
	'MINOR_PERSONA_DESCRIPTORS',
	'SYSTEM_JAILBREAK_TERMS',
]

const out = {}
for (const name of names) {
	const arr = extractStrings(extractList(name))
	out[name] = arr
	console.log(name, arr.length)
}

const dest = path.join(root, 'apps/worker/src/lib/csamRules.json')
fs.writeFileSync(dest, JSON.stringify(out, null, 2))
console.log('wrote', dest)

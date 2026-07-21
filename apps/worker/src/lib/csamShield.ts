/**
 * CSAM Shield v6.0 — port of message(csam).txt detection (content only).
 * Pure classify: never throws. Proxy decides log vs log_and_block.
 *
 * Performance: pure string/regex ops, precompiled patterns, early-exit,
 * input length capped for huge SillyTavern histories.
 */

export const CSAM_SHIELD_VERSION = '6.0'

/** Cap combined scan text (chars). Keeps CPU bounded on huge ST payloads. */
export const CSAM_MAX_SCAN_CHARS = 80_000

export type CsamDetectResult = {
	flagged: true
	reason: string
	snippet: string
}

export type CsamMessage = {
	role?: string
	content?: unknown
}

// ── DEFINITE BLOCKS (always flag, no context) ──
const DEFINITE_CSAM = [
	'child porn',
	'child pornography',
	'cp',
	'childporn',
	'kiddie porn',
	'child sex',
	'child rape',
	'child abuse',
	'pthc',
	'ptsc',
	'r@ygold',
	'raygold',
	'jailbait',
	'preteen sex',
	'pedo',
	'pedophile',
	'child predator',
	'child molest',
	'cunny',
	'loli porn',
	'lolicon',
	'lolita complex',
	'shota',
	'shotacon',
	'groom a child',
	'groom the child',
	'groom a minor',
	"don't tell your parents",
	'this is our secret',
	"you're mature for your age",
]

// Ageplay terms — only flag when sexual terms also present (layer 4)
const AGEPLAY_TERMS = [
	'ageplay',
	'age play',
	'age-play',
	'ddlg',
	'ddlb',
	'mdlg',
	'mdlb',
	'cgl',
	'little space',
	'littlespace',
	// Python: "age regression" + " sex" → single phrase
	'age regression sex',
]

const BODILY_FUNCTIONS = [
	'pee',
	'peeing',
	'peed',
	'urinate',
	'urinating',
	'poop',
	'pooping',
	'defecate',
	'diaper',
	'potty training',
]

const CHILD_AGE_PATTERNS = [
	String.raw`\b([1-9]|1[0-7])\s*year[\s\-]?old\b`,
	String.raw`\b([1-9]|1[0-7])[\s\-]?y[\./]?o\b`,
	String.raw`\bage\s+([1-9]|1[0-7])\b`,
	String.raw`\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)[\s\-]year[\s\-]old\b`,
	String.raw`\bunder[\s\-]?(18|sixteen|seventeen|15|fourteen|thirteen)\b`,
	String.raw`\bminor\b`,
	String.raw`\bchild\b`,
	String.raw`\bkid\b`,
	String.raw`\bchildren\b`,
	String.raw`\bpreteen\b`,
	String.raw`\bpre[\s\-]teen\b`,
	String.raw`\btoddler\b`,
	String.raw`\binfant\b`,
	String.raw`\bbaby\b`,
	String.raw`\byoung (girl|boy|child)\b`,
	String.raw`\blittle (girl|boy|one)\b`,
]

const CHILD_DESCRIPTORS = [
	'childlike',
	'child-like',
	'youthful appearance',
	'petite child',
	'small child',
	'innocent looking',
	'pure and innocent',
]

const SEXUAL_TERMS = [
	'sex',
	'fuck',
	'rape',
	'molest',
	'abuse',
	'penetrat',
	'intercourse',
	'naked',
	'nude',
	'undress',
	'strip',
	'penis',
	'vagina',
	'breast',
	'nipple',
	'cock',
	'dick',
	'pussy',
	'cunt',
	'genitals',
	'privates',
	'masturbat',
	'oral',
	'anal',
	'touch',
	'fondle',
	'caress',
	'grope',
	'lick',
	'suck',
	'finger',
]

const NUDITY_TERMS = [
	'naked',
	'nude',
	'undressed',
	'bare',
	'without clothes',
	'no clothes',
	'exposed',
	'revealing',
]

const EVASION_PHRASES = [
	'parts hidden',
	'parts are hidden',
	'parts obscured',
	'covered by',
	'concealed',
	'censored',
	'nothing visible',
	'strategically placed',
	'camera angle hid',
	'narrator hid',
]

const SAFE_SHOW_NAMES = [
	'naruto',
	'avatar',
	'aang',
	'korra',
	'pokemon',
	'digimon',
	'yugioh',
	'dragon ball',
	'one piece',
	'luffy',
	'zoro',
	'sailor moon',
	'cardcaptor sakura',
	'my hero academia',
	'attack on titan',
]

const SAFE_PHRASES = [
	'character is',
	'character was',
	'character named',
	'in the show',
	'in the series',
	'in the anime',
	'canon age',
	'officially',
	'according to',
	'time skip',
	'flash forward',
]

const EDUCATIONAL_CONTEXTS = [
	'sex education',
	'puberty education',
	'child development',
	'developmental psychology',
	'pediatric',
	'medical',
]

const COMPILED_CHILD_AGE = CHILD_AGE_PATTERNS.map((p) => new RegExp(p, 'i'))
const COMPILED_DEFINITE = DEFINITE_CSAM.map(
	(term) => new RegExp(escapeRegExp(term), 'i'),
)

const ZW_RE = /[\u200b\u200c\u200d\ufeff]/g
const LEET_SEP_RE = /[0_.\-]/g
const WHITESPACE_RE = /\s+/g

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Normalize: strip zero-width, collapse leet separators, lowercase. */
export function normalizeCsamText(text: string): string {
	return text
		.replace(ZW_RE, '')
		.replace(LEET_SEP_RE, '')
		.replace(WHITESPACE_RE, ' ')
		.toLowerCase()
		.trim()
}

function windowSnippet(text: string, start: number, end: number, radius = 50): string {
	const s = Math.max(0, start - radius)
	const e = Math.min(text.length, end + radius)
	let snippet = text.slice(s, e)
	if (s > 0) snippet = '...' + snippet
	if (e < text.length) snippet = snippet + '...'
	return snippet
}

function contentToText(content: unknown): string {
	if (typeof content === 'string') return content
	if (Array.isArray(content)) {
		const parts: string[] = []
		for (const block of content) {
			if (
				block &&
				typeof block === 'object' &&
				(block as { type?: string }).type === 'text'
			) {
				const t = (block as { text?: string }).text
				if (typeof t === 'string') parts.push(t)
			}
		}
		return parts.join(' ')
	}
	return ''
}

/**
 * Extract all message text from an OpenAI-style body.
 * Caps total length (prefer recent content) for CPU safety.
 */
export function extractAllText(data: {
	messages?: CsamMessage[] | null
	prompt?: unknown
}): string {
	const messages = data.messages ?? []
	const parts: string[] = []

	if (Array.isArray(messages)) {
		for (const msg of messages) {
			if (!msg || typeof msg !== 'object') continue
			const text = contentToText(msg.content)
			if (text) parts.push(text)
		}
	}

	if (parts.length === 0 && typeof data.prompt === 'string') {
		parts.push(data.prompt)
	}

	let full = parts.join(' ')
	if (full.length > CSAM_MAX_SCAN_CHARS) {
		full = full.slice(-CSAM_MAX_SCAN_CHARS)
	}
	return full
}

function isSafeShowContext(text: string): boolean {
	const lower = text.toLowerCase()
	if (!SAFE_SHOW_NAMES.some((show) => lower.includes(show))) return false
	if (!SAFE_PHRASES.some((phrase) => lower.includes(phrase))) return false
	if (SEXUAL_TERMS.some((t) => lower.includes(t))) return false
	if (BODILY_FUNCTIONS.some((t) => lower.includes(t))) return false
	if (NUDITY_TERMS.some((t) => lower.includes(t))) return false
	return true
}

function isEducationalContext(text: string): boolean {
	const lower = text.toLowerCase()
	return EDUCATIONAL_CONTEXTS.some((ctx) => lower.includes(ctx))
}

function hasChildIndicator(text: string): string | null {
	const lower = text.toLowerCase()
	for (const pattern of COMPILED_CHILD_AGE) {
		const m = pattern.exec(lower)
		if (m) return `age:${m[0]}`
	}
	for (const desc of CHILD_DESCRIPTORS) {
		if (lower.includes(desc)) return `descriptor:${desc}`
	}
	return null
}

function hasSexualContent(text: string): string | null {
	const lower = text.toLowerCase()
	for (const term of SEXUAL_TERMS) {
		if (lower.includes(term)) return term
	}
	return null
}

function hasBodilyFunction(text: string): string | null {
	const lower = text.toLowerCase()
	for (const term of BODILY_FUNCTIONS) {
		if (lower.includes(term)) return term
	}
	return null
}

function hasEvasionPhrase(text: string): string | null {
	const lower = text.toLowerCase()
	for (const phrase of EVASION_PHRASES) {
		if (lower.includes(phrase)) return phrase
	}
	return null
}

/**
 * Run CSAM detection on request body (or any object with messages).
 * Returns null if clean; otherwise { flagged, reason, snippet }.
 * Content only — never inspects model names.
 */
export function detectCsam(data: {
	messages?: CsamMessage[] | null
	prompt?: unknown
}): CsamDetectResult | null {
	const fullText = extractAllText(data)
	if (!fullText.trim()) return null

	const lower = fullText.toLowerCase()
	// Keep normalize for possible leet hits on definite terms after strip
	const normalized = normalizeCsamText(fullText)

	// ── LAYER 1: DEFINITE BLOCKS ──
	for (const pattern of COMPILED_DEFINITE) {
		pattern.lastIndex = 0
		const m = pattern.exec(fullText)
		if (m) {
			return {
				flagged: true,
				reason: `definite_csam:${m[0]}`,
				snippet: windowSnippet(fullText, m.index, m.index + m[0].length),
			}
		}
	}
	// Leet / separator evasions of high-confidence terms (v6 normalize)
	const leetPriority = [
		'lolicon',
		'shotacon',
		'cunny',
		'jailbait',
		'childporn',
		'pedophile',
		'pthc',
	]
	for (const term of leetPriority) {
		if (normalized.includes(term.replace(/[0_.\-]/g, ''))) {
			// only if original didn't already match via raw (handled above)
			if (!lower.includes(term)) {
				return {
					flagged: true,
					reason: `definite_csam:leet:${term}`,
					snippet: `<normalized match: ${term}>`,
				}
			}
		}
	}

	// ── LAYER 2: SAFE CONTEXT EXEMPTIONS ──
	if (isSafeShowContext(fullText)) return null
	if (isEducationalContext(fullText)) return null

	// ── LAYER 3: CHILD + SEXUAL / BODILY / EVASION ──
	const childIndicator = hasChildIndicator(fullText)
	if (childIndicator) {
		const sexualTerm = hasSexualContent(fullText)
		const bodilyTerm = hasBodilyFunction(fullText)
		const evasion = hasEvasionPhrase(fullText)
		const snip = fullText.slice(0, 200)

		if (sexualTerm) {
			return {
				flagged: true,
				reason: `child+sexual:${childIndicator}+${sexualTerm}`,
				snippet: snip,
			}
		}
		if (bodilyTerm) {
			return {
				flagged: true,
				reason: `child+bodily:${childIndicator}+${bodilyTerm}`,
				snippet: snip,
			}
		}
		if (evasion) {
			return {
				flagged: true,
				reason: `child+evasion:${childIndicator}+${evasion}`,
				snippet: snip,
			}
		}
	}

	// ── LAYER 4: AGEPLAY + sexual ──
	for (const term of AGEPLAY_TERMS) {
		if (lower.includes(term) && SEXUAL_TERMS.some((s) => lower.includes(s))) {
			return {
				flagged: true,
				reason: `ageplay:${term}`,
				snippet: fullText.slice(0, 200),
			}
		}
	}

	return null
}

/** Rule count for diagnostics. */
export function csamRuleCount(): number {
	return (
		DEFINITE_CSAM.length +
		AGEPLAY_TERMS.length +
		BODILY_FUNCTIONS.length +
		CHILD_AGE_PATTERNS.length +
		CHILD_DESCRIPTORS.length +
		SEXUAL_TERMS.length +
		NUDITY_TERMS.length +
		EVASION_PHRASES.length +
		SAFE_SHOW_NAMES.length +
		SAFE_PHRASES.length +
		EDUCATIONAL_CONTEXTS.length
	)
}

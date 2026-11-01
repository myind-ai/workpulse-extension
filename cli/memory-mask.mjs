// Every string of session text goes through maskSecrets before it is stored. A leak here is the worst failure of
// the capture, so when in doubt it masks. Every pattern is linear: anchored on a literal or a run start, bounded by
// a count, or walked by hand (a 2.3 MB line of near-matches is a test).
//
// Order: PEM blocks (and the tail or bare body of one), name-value pairs and headers, command-line flags, query
// strings, passwords in URLs, JWTs, then the shapes the Brain already knows (SECRET_SHAPES from bridge.ts, loaded the
// way library.mjs loads it, and FILE_SECRET_SHAPES from library.mjs; copies here, the shared lists are untouched).
// The bare word service_role is kept (it is a word in many rules files); sbp_ tokens and JWTs are masked.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { FILE_SECRET_SHAPES } from './library.mjs'
const { SECRET_SHAPES } = await import(join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'src', 'core', 'bridge.ts'))

const mark = (name) => `[masked:${name}]`

// ── PEM ─────────────────────────────────────────────────────────────────────

const LABEL = String.raw`[^\n-]{0,300}?PRIVATE[ \t]+KEY[^\n-]{0,60}`
const PEM = new RegExp(String.raw`(?<!-)-{2,}[ \t]*BEGIN${LABEL}-{2,}[\s\S]*?(?:-{2,}[ \t]*END${LABEL}-{2,}|$)`, 'gi')
const PEM_END = new RegExp(String.raw`(?<!-)-{2,}[ \t]*END${LABEL}-{2,}`, 'gi')
// A key body with no header: PKCS#8 / X.509 DER (MII…) or OpenSSH (b3BlbnNzaC1rZXk…), and the base64 lines under it.
const PEM_BODY = /(?<![A-Za-z0-9+/=])(?:MII[A-Za-z0-9+/]{3}|b3BlbnNzaC1rZXk)[A-Za-z0-9+/=]{16,}(?:[ \t]*\r?\n[ \t>]*[A-Za-z0-9+/=]{8,})*/g

/** An END line whose BEGIN is not in this text: mask it and the base64 lines above it. */
function maskOrphanEnds(text, hit) {
	let out = ''
	let done = 0
	for (const m of text.matchAll(PEM_END)) {
		let p = m.index
		const before = text.slice(Math.max(done, p - 200), p)
		const nl = before.lastIndexOf('\n')
		if ((nl !== -1 || p - 200 <= done) && /^[>\t ]*$/.test(before.slice(nl + 1))) {
			p -= before.length - (nl + 1)
			while (p > done) {
				const upto = text.slice(Math.max(done, p - 201), p - 1)
				const at = upto.lastIndexOf('\n')
				if (at === -1 && p - 201 > done) break
				const line = upto.slice(at + 1)
				if (p - 1 < done || !/^[>\t ]*[A-Za-z0-9+/=]{4,}[ \t\r]*$/.test(line)) break
				p -= line.length + 1
			}
		}
		out += text.slice(done, p) + hit('Private key')
		done = m.index + m[0].length
	}
	return out + text.slice(done)
}

// ── name-value pairs ────────────────────────────────────────────────────────

// authorization and cookie always take the rest of the line; a line that is itself NAME=value takes the rest of the line.
const SEP = String.raw`(?:=>|:=|==|[:=：])`
const KEYS = String.raw`(authorization|cookie|secret|token|passphrase|passw(?:or)?d|pass(?!ed|ing|age|ive|es|through)|pwd|salt|auth(?!or)|credential|api[_-]?key|apikey|private[_-]?key|access[_-]?key|signing[_-]?key|पासवर्ड)`
const AFTER = String.raw`([A-Za-z0-9_.-]{0,40})(\\*["']?[ \t]{0,20}${SEP}[ \t]{0,20})`
const PAIR = new RegExp(KEYS + AFTER, 'gi')
const PAIR_ENV_KEY = new RegExp(String.raw`(_KEY)` + AFTER, 'g') // OPENAI_KEY=, ENCRYPTION_KEY=; case-sensitive so primary_key stays

const MASKED = String.raw`\[masked:[^\]\n]{0,60}\]` // a mask already there; its name may hold a space
const Q_MASKED = new RegExp(MASKED, 'y')
const Q_ESCAPED = /\\+(["'])[^\n]*?\\+\1/y
const Q_PLAIN = /"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'/y
const Q_OPEN = /["'][\s\S]*/y
const BARE = /\S+/y
const EOL = /[^\r\n]*/y
const FALLBACK = /[ \t]*(?:\|\||\?\?|\bor\b)[ \t]*/y
const LINE_NAME = /^[ \t>#*-]*(?:export[ \t]+|set[ \t]+)?[A-Za-z0-9_.-]*$/i

// A value that only reads the secret from somewhere else, is already masked, or is not a value. Whole value only:
// a literal after a reference (${X}V, process.env-V) is a literal. $NAME in capitals is a known trade-off.
const HARMLESS = /^(?:(?:process\.env|import\.meta\.env)\.[\w.]+|Deno\.env\.get\([^)]*\)|os\.environ(?:\[[^\]]*\]|\.get\([^)]*\))|os\.getenv\([^)]*\)|getenv\([^)]*\)|\$\{[A-Za-z_]\w*\}|true|false|null|undefined|none|\[masked:[^\]\n]{0,60}\])[,;)]*$/i
const HARMLESS_VAR = /^\$[A-Z_][A-Z0-9_]*[,;)]*$/

function unquoted(v) {
	const t = v.trim()
	return t.length > 1 && /^["'`]/.test(t) && t.at(-1) === t[0] ? t.slice(1, -1) : t
}
const harmless = (v) => {
	const t = unquoted(v)
	return t === '' || HARMLESS.test(t) || HARMLESS_VAR.test(t)
}
function at(re, text, i) {
	re.lastIndex = i
	const m = re.exec(text)
	return m ? i + m[0].length : -1
}
/** Where the value that starts at s ends; whole is true when it was taken as the rest of the line. */
function valueEnd(text, s, restOfLine) {
	const c = text[s]
	if (c === '[' && !restOfLine) {
		const e = at(Q_MASKED, text, s)
		if (e !== -1) return e
	}
	if (c === '\\') {
		const e = at(Q_ESCAPED, text, s)
		if (e !== -1) return e
	} else if (c === '"' || c === "'") {
		const e = at(Q_PLAIN, text, s)
		if (e === -1) return at(Q_OPEN, text, s) // never closed: to the end
		return restOfLine ? at(EOL, text, e) : e
	}
	return at(restOfLine ? EOL : BARE, text, s)
}

const BLOCK_INDICATOR = /^[|>][+-]?\d?[ \t\r]*$/
const BLANK = /^[ \t\r]*$/
/** The lines under a YAML key (nlIdx is the newline ending the key's line) that are blank or indented deeper than it. */
function blockBody(text, nlIdx, indent) {
	let i = nlIdx + 1
	const start = i
	let last = -1
	while (i <= text.length) {
		const eol = text.indexOf('\n', i)
		const end = eol === -1 ? text.length : eol
		const line = text.slice(i, end)
		if (!BLANK.test(line)) {
			if (/^[ \t]*/.exec(line)[0].length <= indent) break
			last = end
		}
		if (eol === -1) break
		i = eol + 1
	}
	return last === -1 ? null : { start, end: last }
}

function maskPairs(text, re, hit) {
	re.lastIndex = 0
	let out = ''
	let done = 0
	let m
	while ((m = re.exec(text))) {
		const key = m[1].toLowerCase()
		const s = re.lastIndex
		const head = text.slice(Math.max(0, m.index - 200), m.index)
		const nl = head.lastIndexOf('\n')
		const lineMode = (nl !== -1 || m.index <= 200) && LINE_NAME.test(head.slice(nl + 1))
		const always = key === 'authorization' || key === 'cookie'
		let e = valueEnd(text, s, lineMode || always)
		const name = key === 'authorization' ? 'Authorization header' : key === 'cookie' ? 'Cookie' : 'Named secret'
		if (lineMode) {
			// YAML: `key: |` / `key: >` or `key:` alone; the secret is the indented lines below.
			const rest = e <= s ? '' : text.slice(s, e)
			if (e <= s || BLOCK_INDICATOR.test(rest)) {
				const lineEnd = e <= s ? text.indexOf('\n', s) : text.indexOf('\n', e)
				const onlyBlank = e <= s && lineEnd !== -1 && !BLANK.test(text.slice(s, lineEnd))
				const body = lineEnd === -1 || onlyBlank ? null : blockBody(text, lineEnd, /^[ \t]*/.exec(head.slice(nl + 1))[0].length)
				if (body) {
					out += text.slice(done, body.start) + hit(name)
					done = body.end
					re.lastIndex = body.end
				}
				if (body || e <= s || BLOCK_INDICATOR.test(rest)) continue // a bare | or > is not a value
			}
		}
		if (e <= s) continue
		const value = text.slice(s, e)
		// max_tokens: 4096, temp: 1 — a plural tokens followed by a number keeps it (the first word, trailing , ; ) dropped)
		if (key === 'token' && m[2] === 's' && /^\d+$/.test(unquoted(value).trim().split(/\s+/)[0].replace(/[,;)]+$/, ''))) continue
		let from = s
		if (harmless(value)) {
			// process.env.X || "literal": the literal after a reference is the secret.
			const f = at(FALLBACK, text, e)
			if (f === -1 || /^\s*$/.test(value)) { re.lastIndex = e; continue }
			const e2 = valueEnd(text, f, false)
			if (e2 <= f || harmless(text.slice(f, e2))) { re.lastIndex = e; continue }
			from = f
			e = e2
		}
		out += text.slice(done, from) + hit(name)
		done = e
		re.lastIndex = e
	}
	return out + text.slice(done)
}

// ── command lines, query strings, URLs ──────────────────────────────────────

const QV = String.raw`(?!-)(?:${MASKED}|"(?:[^"\\\n]|\\.){0,2000}"|'[^'\n]{0,2000}'|\S{1,2000})`
const FLAG = new RegExp(String.raw`(--(?:[a-z0-9]+-){0,3}(?:password|passwd|passphrase|token|secret|api-key|apikey|access-key|private-key|auth)[ \t]+)(${QV})`, 'gi')
const SSHPASS = new RegExp(String.raw`(\bsshpass[ \t]+-p[ \t]*)(${QV})`, 'g')
const MYSQL_P = /(\bmysql(?:dump|admin)?\b[^\n]{0,300}?[ \t]-p)(\[masked:[^\]\n]{0,60}\]|[^\s-]\S{0,500})/g
const USER_PASS = /((?:^|[ \t])(?:-u|--user)[ \t]+["']?[^\s:'"]{1,200}:)(\[masked:[^\]\n]{0,60}\]|[^\s'"]{1,500})/gm
const QUERY = /([?&][A-Za-z0-9_.-]{0,30}(?:key|sig|signature|auth|pass|sas|secret|token|credential|code)[A-Za-z0-9_.-]{0,20}=)(\[masked:[^\]\n]{0,60}\]|[^\s&#"'<>]{1,2000})/gi

function maskUrls(text, hit) {
	let out = ''
	let done = 0
	let from = 0
	const RUN = /[^\s?#]{0,2000}/y
	for (let i = text.indexOf('://', from); i !== -1; i = text.indexOf('://', from)) {
		from = i + 3
		let a = i
		while (a > 0 && i - a < 41 && /[A-Za-z0-9+.-]/.test(text[a - 1])) a--
		if (a === i || a < done) continue
		const end = at(RUN, text, from)
		from = end
		const run = text.slice(i + 3, end)
		const atSign = run.lastIndexOf('@')
		if (atSign < 1) continue
		const info = run.slice(0, atSign)
		const colon = info.indexOf(':')
		let start, stop
		if (colon === -1) {
			if (info.includes('/') || info === 'git') continue
			start = 0
		} else {
			const user = info.slice(0, colon)
			const pw = info.slice(colon + 1)
			if (user.includes('/') || pw === '' || (user.includes('.') && /^\d+\//.test(pw))) continue
			start = colon + 1
		}
		stop = atSign
		if (harmless(info.slice(start))) continue
		out += text.slice(done, i + 3 + start) + hit('URL password')
		done = i + 3 + stop
	}
	return out + text.slice(done)
}

// ── JWT ─────────────────────────────────────────────────────────────────────

// The shared JWT pattern starts again after every hyphen of a long dotless run (eyJ-eyJ-eyJ-…), which is quadratic.
// This walks the dots instead: each ".eyJ" is looked at once, backwards to the start of its run and forwards to its end.
// A signature may be short or empty; a fifth part (JWE) and anything after it is part of the token.
const B64 = /[A-Za-z0-9_-]/
function maskJwts(text, hit) {
	let out = ''
	let done = 0
	let from = 0
	for (let d = text.indexOf('.eyJ', from); d !== -1; d = text.indexOf('.eyJ', from)) {
		from = d + 1
		let a = d
		while (a > done && B64.test(text[a - 1])) a--
		const start = text.indexOf('eyJ', a)
		if (start === -1 || start >= d || d - start < 13) continue
		let b = d + 4
		while (b < text.length && B64.test(text[b])) b++
		if (b - (d + 1) < 13 || text[b] !== '.') continue
		let e = b
		while (text[e] === '.' && (e + 1 >= text.length || B64.test(text[e + 1]) || e === b)) {
			e++
			while (e < text.length && B64.test(text[e])) e++
		}
		out += text.slice(done, start) + hit('JWT')
		done = e
		from = e
	}
	return out + text.slice(done)
}

// ── shapes ──────────────────────────────────────────────────────────────────

// \b stops a token after a word character (/tmp/backup_ghp_…, /tmp/xghp_…, %2Fghp_…, AKIA…_old). Here a token with its
// own prefix needs no boundary; sk- and sk_ need a non-alphanumeric before them (so task-… is not sk-…) or a %XX escape.
// Resend keeps its own \b: its look-aheads would make a loosened start quadratic.
const START = String.raw`(?:(?<![A-Za-z0-9])|(?<=%[0-9A-Fa-f]{2}))`
const SHAPES = [...SECRET_SHAPES, ...FILE_SECRET_SHAPES].filter(([name]) => name !== 'JWT').map(([name, re]) => {
	// Supabase: the word service_role is not a secret on its own, so only the sbp_ part is masked.
	let source = name === 'Supabase token' ? String.raw`\bsbp_[A-Za-z0-9]{20,}` : re.source
	// Resend keeps \b. sk- and sk_ are generic enough to need a start. The rest begin with their own prefix: no boundary.
	if (name === 'API key' || name === 'Secret key (sk_)') source = source.replace(/(^|\|)\\b/g, `$1${START}`)
	else if (name !== 'Resend key') source = source.replace(/(^|\|)\\b/g, '$1').replace(/\\b$/, '')
	return [name, new RegExp(source, re.flags.replace('g', '') + 'g')]
})

// Vendor tokens the shared lists lack. Kept here so the Brain's own check is not changed by this task.
// sb_publishable_ is a public key and stays.
export const VENDOR_SHAPES = [
	['GitLab token', /glpat-[A-Za-z0-9_-]{20,}/],
	['npm token', /npm_[A-Za-z0-9]{30,}/],
	['Hugging Face token', /hf_[A-Za-z0-9]{30,}/],
	['SendGrid key', /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/],
	['Webhook secret', /whsec_[A-Za-z0-9]{20,}/],
	['Stripe restricted key', /rk_(?:live|test)_[A-Za-z0-9]{16,}/],
	['Slack app token', /xapp-[A-Za-z0-9-]{20,}/],
	['AWS session key', /ASIA[0-9A-Z]{16}/],
	['Groq key', /gsk_[A-Za-z0-9]{30,}/],
	['Supabase secret key', /sb_secret_[A-Za-z0-9_-]{20,}/],
	['DigitalOcean refresh token', /dor_v1_[a-f0-9]{20,}/],
	['PyPI token', /pypi-[A-Za-z0-9_-]{20,}/],
]
const VENDOR = VENDOR_SHAPES.map(([name, re]) => [name, new RegExp(`${START}${re.source}`, 'g')])

/** Replaces every credential-looking part of text with [masked:<shape name>]. hits holds shape names, never values. */
export function maskSecrets(text) {
	if (typeof text !== 'string' || !text) return { text: typeof text === 'string' ? text : '', hits: [] }
	const hits = new Set()
	const hit = (name) => (hits.add(name), mark(name))
	let out = text.replace(PEM, () => hit('Private key'))
	out = maskOrphanEnds(out, hit)
	out = out.replace(PEM_BODY, () => hit('Private key'))
	out = maskPairs(out, PAIR, hit)
	out = maskPairs(out, PAIR_ENV_KEY, hit)
	const secret = (all, head, value) => (harmless(value) ? all : head + hit('Command-line secret'))
	out = out.replace(FLAG, secret).replace(SSHPASS, secret).replace(MYSQL_P, secret).replace(USER_PASS, secret)
	out = out.replace(QUERY, (all, head, value) => (harmless(value) ? all : head + hit('Named secret')))
	out = maskUrls(out, hit)
	out = maskJwts(out, hit)
	for (const [name, re] of [...SHAPES, ...VENDOR]) out = out.replace(re, () => hit(name))
	return { text: out, hits: [...hits] }
}

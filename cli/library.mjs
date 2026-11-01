// wp-brain library — the opt-in text backup of what was learned from a video or article.
//
// Notes, transcripts and descriptions go to bridge/library/<type>/<folder>/ in the user's own private
// Brain repository, so a second machine can restore them. Off unless brain.json holds "library": true.
// Only text files are taken (never media) and the caller checks every file for secrets first.
// A folder has one writer: the device named in its `.owner` file.

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SENSITIVE_FILE } from './sensitive.mjs'
const { secretsIn, LIBRARY_FILES } = await import(join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'src', 'core', 'bridge.ts'))

export { LIBRARY_FILES }
export const MAX_BYTES = 2 * 1024 * 1024
export const OWNER_FILE = '.owner'

export const libraryEnabled = (cfg) => cfg?.library === true
export const libraryPath = (type, folderName) => `bridge/library/${type}/${folderName}`

/** The files of a folder worth backing up, and the reason for each one left out. */
export function pickFiles(folderAbs) {
	const keep = []
	const skipped = []
	for (const name of readdirSync(folderAbs).sort()) {
		const st = lstatSync(join(folderAbs, name)) // lstat: a link to a file elsewhere is never followed
		if (st.isSymbolicLink()) {
			skipped.push({ name, why: 'symlink' })
			continue
		}
		if (!st.isFile()) continue
		if (!LIBRARY_FILES.includes(name)) skipped.push({ name, why: 'not allowed' })
		else if (st.size > MAX_BYTES) skipped.push({ name, why: 'over 2 MB' })
		else keep.push(name)
	}
	return { keep, skipped }
}

const isDir = (p) => {
	try {
		return lstatSync(p).isDirectory()
	} catch {
		return false
	}
}
export const isLinkSafe = (p) => {
	try {
		return lstatSync(p).isSymbolicLink()
	} catch {
		return false
	}
}

/** True when none of `parts` below `cloneAbs`, taken one level at a time from the top, is a symlink. */
export function linkFree(cloneAbs, ...parts) {
	let p = cloneAbs
	for (const part of parts.join('/').split('/').filter(Boolean)) {
		p = join(p, part)
		if (isLinkSafe(p)) return false
	}
	return true
}

/** Throws when `rel` or any folder above it in the clone is a symlink: a write or delete there would leave the clone. */
export function assertNoLinks(cloneAbs, rel) {
	if (!linkFree(cloneAbs, rel)) throw new Error(`Refusing to write ${rel}: it, or a folder above it in the Brain clone, is a symlink. Nothing was changed.`)
}

/** Every <type>/<folder> in the clone's library, with its owner. */
export function listLibrary(cloneAbs, readOwner) {
	const base = join(cloneAbs, 'bridge', 'library')
	const out = []
	if (!linkFree(cloneAbs, 'bridge', 'library') || !isDir(base)) return out // lstat each level: a linked folder is not followed
	for (const type of readdirSync(base).sort()) {
		const t = join(base, type)
		if (!isDir(t)) continue // lstat: a link is not a folder
		for (const folder of readdirSync(t).sort()) {
			if (isDir(join(t, folder))) out.push({ type, folder, owner: readOwner(join(t, folder, OWNER_FILE)) })
		}
	}
	return out
}

/** Writes one restored file unless it is there (or something unusable is in the way); true when it wrote. */
function putFile(from, target, force) {
	const linked = isLinkSafe(target)
	if ((existsSync(target) || linked) && !force) return false
	try {
		mkdirSync(dirname(target), { recursive: true })
		if (linked) rmSync(target) // replace the link itself, never write through it
		copyFileSync(from, target)
		return true
	} catch (e) {
		if (['ENOTDIR', 'EISDIR', 'EEXIST'].includes(e.code)) return false // a file where a folder belongs, or the reverse: kept as it is
		throw e
	}
}

/** Copies library folders back under `root`. An existing file stays unless `force`. */
export function restoreInto(cloneAbs, root, force) {
	const copied = []
	const kept = []
	for (const { type, folder } of listLibrary(cloneAbs, () => '')) {
		const src = join(cloneAbs, 'bridge', 'library', type, folder)
		const dest = join(root, folder)
		if (isLinkSafe(dest)) {
			kept.push(`${folder}/ (a symlink)`)
			continue
		}
		for (const name of readdirSync(src)) {
			if (!LIBRARY_FILES.includes(name) || lstatSync(join(src, name)).isSymbolicLink()) continue
			if (putFile(join(src, name), join(dest, name), force)) copied.push(`${folder}/${name}`)
			else kept.push(`${folder}/${name}`)
		}
	}
	return { copied, kept }
}

// ── what must never be backed up ────────────────────────────────────────────

/** Shapes that whole files are checked for beyond the entry check (SECRET_SHAPES). Shared with the session-text masker. */
export const FILE_SECRET_SHAPES = [
	['Google API key', /AIza[0-9A-Za-z_-]{30,}/],
	['Google OAuth token', /ya29\.[\w-]{20,}/],
	['Resend key', /\bre_(?=[A-Za-z0-9_]*[0-9])(?=[A-Za-z0-9_]*[A-Z])[A-Za-z0-9_]{20,}/], // real keys hold a digit and a capital; re_generate_all_the_things_v2 is a name
	['NVIDIA key', /nvapi-[\w-]{20,}/],
	['Stripe live key', /sk_live_\w{16,}/],
	['age secret key', /AGE-SECRET-KEY-1[0-9A-Z]{20,}/],
	['Secret key (sk_)', /\bsk_[A-Za-z0-9]{24,}/], // ElevenLabs and others
	['Razorpay key', /\brzp_(?:live|test)_[A-Za-z0-9]{10,}/],
	['DigitalOcean token', /\bdop_v1_[a-f0-9]{20,}/],
	['Cashfree key', /\bcfsk_[\w-]{10,}/],
]

/**
 * Like the entry check (secretsIn), for whole files. Differences: "service_role" alone is a word in many
 * rules files, so it counts only beside a JWT-like value; and shapes that entries never needed are added.
 * Returns shape names, never values.
 */
export function fileSecretsIn(raw) {
	// A run of X or x that is the whole variable part of a value (sk_XXXXXXXX, not abcXXXXXXXX) is a placeholder.
	// Blanked with spaces of the same length, so no other rule sees a shorter or longer gap than before.
	const text = raw.replace(/(?<![A-Za-z0-9])[Xx]{8,}(?![A-Za-z0-9])/g, (m) => ' '.repeat(m.length))
	const hits = secretsIn(text).filter((n) => n !== 'Supabase token')
	if (/\bsbp_[A-Za-z0-9]{20,}/.test(text) || /service_role[\s\S]{0,40}eyJ[\w-]{20,}|eyJ[\w-]{20,}[\s\S]{0,40}service_role/.test(text)) hits.push('Supabase token')
	for (const [name, re] of FILE_SECRET_SHAPES) if (re.test(text) && !hits.includes(name)) hits.push(name)
	const placeholder = /your|example|xxx|changeme|placeholder|password/i
	// The whole value is a template or a redaction: ${x}, $NAME, {{x}}, {x}, <x>, %(x)s, #{x}, ****, [REDACTED]. Anything that only starts like one is a literal.
	const template = /^(?:\$\{[^}]*\}|\$[A-Z_][A-Z0-9_]*|\{\{.*\}\}|\{[^{}]*\}|<[^<>]*>|%\([^)]*\)s|#\{[^}]*\}|\*+)$/
	const redaction = /^[[(](?:redacted|hidden|masked|removed|filtered|omitted|secret|sensitive)[\])]$/i
	const literal = (v) => !template.test(v) && !redaction.test(v) && !placeholder.test(v)
	// A password counts when it is a quoted literal (also as a quoted key: "password": "x"; passwd and pwd too), or the
	// bare value of an env-style NAME_PASSWORD=value. A path is a likely value of pwd only (the working directory).
	const codeRef = /^(?:process\.env|import\.meta\.env|Deno\.env|os\.environ|os\.getenv|getenv)(?:\.|$)/ // reads the value from elsewhere
	let pw = false
	for (const m of text.matchAll(/(password|passwd|\bpwd)['"]?\s*[:=]\s*(['"])([^'"\r\n]{6,})\2/gi)) pw ||= literal(m[3]) && !(/^pwd$/i.test(m[1]) && /^(?:\/|\.\.?\/|~\/)/.test(m[3]))
	for (const m of text.matchAll(/\b[A-Z0-9_]*(?:PASSWORD|PASSWD)=([A-Za-z0-9_@#%^&*+=!.\/-]{8,})(?![\w(])/g)) pw ||= literal(m[1]) && !codeRef.test(m[1])
	if (pw) hits.push('password')
	// A URL with a password in it; a redis one has no user. $pass and %s are that password coming from somewhere else.
	// Only the password part is judged, and as a whole value: MyPassword123 is a password, `password` and PASS are not.
	// An image reference (docker://alpine:3.19@sha256:…) has a tag where a password would be.
	const variable = /^\$\w+$|^%[a-z]$/i
	const urlPlaceholder = /^(?:PASS|PWD|SECRET|PASSWD|PASSWORD)$|^(?:password|passwd|your[\w-]*|changeme|example|placeholder|x{3,})$|^\[[^\[\]]*\]$/i
	const upperOnly = /^(?:PASS|PWD|SECRET)$/i
	let url = false
	for (const m of text.matchAll(/\w+:\/\/([^/\s:@]*):([^/\s:@]+)@(?!sha\d+:)/g)) {
		const pw = m[2]
		const holder = upperOnly.test(pw) ? pw === pw.toUpperCase() : urlPlaceholder.test(pw)
		url ||= !template.test(pw) && !redaction.test(pw) && !holder && !variable.test(pw)
	}
	if (url) hits.push('URL with a password')
	// NAME_API_KEY=literal, NAME_SECRET=, NAME_TOKEN=, on one line. The lookahead leaves no way to stop short of a call or a longer value.
	const dotted = /^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$/ // config.value reads it from elsewhere; a JWT (eyJ…) only looks like one
	const isPath = /^(?:\/|\.\.?\/|~\/)|^[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z]{1,5}$/ // a relative file path too: config/secrets/app.json
	const varName = /^[A-Z]+(?:_[A-Z0-9]+)+$/ // GITHUB_PERSONAL_ACCESS_TOKEN names a variable; a secret does not look like this
	let env = false
	// `=` or a YAML `:` after an upper-case name, and a lower-case api_key (settings files and code).
	for (const m of text.matchAll(/(?:API_KEY|SECRET|TOKEN|api_key)[ \t]*(?:=(?!=)|:(?!:))[ \t]*['"]?([A-Za-z0-9_+/.=~-]{16,})(?![\w+/.=~(-])/g)) env ||= literal(m[1]) && !codeRef.test(m[1]) && !isPath.test(m[1]) && !varName.test(m[1]) && !(dotted.test(m[1]) && !m[1].startsWith('eyJ'))
	if (env) hits.push('env secret')
	return hits
}

/** Checks every file; one message naming all that look like secrets (file and shape, never the value), or null. */
export function secretReport(files, read) {
	const lines = []
	for (const f of files) {
		const hits = fileSecretsIn(read(f))
		if (hits.length) lines.push(`  ${f.rel} (${hits.join(', ')})`)
	}
	return lines.length ? `These look like they hold a secret:\n${lines.join('\n')}\nNothing was backed up. Take the secret out of each file (or remove the file) and run again.` : null
}

/** 'public' | 'private' | 'unknown' for a GitHub repository. WP_BRAIN_REPO_VISIBILITY overrides it (tests). */
export function repoVisibility(repo) {
	const forced = process.env.WP_BRAIN_REPO_VISIBILITY
	if (['public', 'private', 'unknown'].includes(forced)) return forced
	try {
		const out = execFileSync('gh', ['repo', 'view', repo, '--json', 'isPrivate', '--jq', '.isPrivate'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).trim()
		return out === 'true' ? 'private' : out === 'false' ? 'public' : 'unknown'
	} catch {
		return 'unknown'
	}
}

/** Device names are folder names: no separators, never "." or "..". */
export const validDevice = (d) => typeof d === 'string' && /^[\w.-]+$/.test(d) && d !== '.' && d !== '..'

// ── config backup: ~/.claude/CLAUDE.md, RTK.md and the skills ───────────────
//
// `wp-brain config backup` keeps the text of the user's rules and skills at bridge/config/<device>/,
// so a new machine gets them back. Same switch as the library ("library": true), same secret check.

/** A text type is decided by extension alone; the content is never sniffed. */
export const TEXT_EXT = ['.md', '.txt', '.json', '.yaml', '.yml', '.mjs', '.js', '.ts', '.py', '.sh', '.toml']
const IGNORED_DIRS = ['node_modules', '.git', 'venv', '__pycache__'] // plus every hidden folder (.venv, .secrets, …)
// A file whose NAME says credentials is left out, whatever it holds. Case-insensitive, checked before the extension.
// It also catches harmless names (token-bucket.md); they are reported as skipped, which is the safe side.
export { SENSITIVE_FILE }
// A skill's own top-level folder is skipped only on these exact names; a skill that is itself called
// tokens or api-keys is kept (a known limit, so that token-economy-setup and its kind survive).
const SENSITIVE_DIR = /^(secrets?|credentials?)$/i
const SENSITIVE_SUBDIR = /^(keys|auth)$/i // exact names below a skill, on top of the word list
const extOf = (name) => (name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '')
const isTextName = (name) => TEXT_EXT.includes(extOf(name))
export const configPath = (device) => `bridge/config/${device}`
const TOP_FILES = ['CLAUDE.md', 'RTK.md'] // all that a restore puts at the top of .claude (never settings.json, where hooks live)
const FOLDERS = ['skills', 'rules', 'rule-files'] // the folders of text that a backup keeps and a restore puts back

export const SKIPPED_BY_CONFIG = 'left out by configSkip'

/** The usable prefixes of brain.json's configSkip: non-empty strings without `.`/`..` segments, slashes trimmed. Anything else matches nothing. */
export function skipPrefixes(list) {
	if (!Array.isArray(list)) return []
	return list.filter((p) => typeof p === 'string').map((p) => p.split('/').filter(Boolean).join('/')).filter((p) => p && !p.split('/').some((seg) => seg === '.' || seg === '..'))
}
/** True when `rel` is a prefix or below it, counted in whole path segments: skills/foo never matches skills/foobar. */
const skippedByConfig = (rel, prefixes) => prefixes.some((p) => rel === p || rel.startsWith(`${p}/`))

/** Every file below `abs` that a configSkip prefix covers, listed as left out (nothing in there is read). */
function listLeftOut(abs, rel, skipped) {
	for (const name of readdirSync(abs).sort()) {
		const here = `${rel}/${name}`
		const st = lstatSync(join(abs, name))
		if (st.isDirectory()) listLeftOut(join(abs, name), here, skipped)
		else skipped.push({ rel: here, why: SKIPPED_BY_CONFIG })
	}
}

/**
 * Where a link directly under skills/ really points, when it is a skill to store: a folder with a SKILL.md, inside the folder that holds .claude.
 * Many skills are installed as links (~/.agents/skills, a skills repository), and a new computer has neither. Any other link stays out.
 */
function linkedSkill(link, base) {
	try {
		const real = realpathSync(link)
		return real.startsWith(`${realpathSync(base)}${sep}`) && statSync(real).isDirectory() && existsSync(join(real, 'SKILL.md')) ? real : null
	} catch {
		return null
	}
}

/** Files under `abs` (relative paths with `/`), minus symlinks (but for a linked skill), ignored or hidden folders, sensitive names, non-text and big files. */
function walkText(abs, rel, keep, skipped, skip = [], base = abs) {
	const topLevel = rel === 'skills' // folders directly under skills/ are the skills themselves (token-economy-setup is one)
	for (const name of readdirSync(abs).sort()) {
		const here = `${rel}/${name}`
		const st = lstatSync(join(abs, name))
		if (skippedByConfig(here, skip)) {
			if (st.isDirectory() && !st.isSymbolicLink()) listLeftOut(join(abs, name), here, skipped)
			else skipped.push({ rel: here, why: SKIPPED_BY_CONFIG })
		} else if (st.isSymbolicLink()) {
			const real = topLevel ? linkedSkill(join(abs, name), base) : null
			if (!real) skipped.push({ rel: here, why: 'symlink' })
			else if (SENSITIVE_DIR.test(name)) skipped.push({ rel: here, why: 'sensitive name' })
			else walkText(real, here, keep, skipped, skip, base)
		} else if (st.isDirectory()) {
			if (IGNORED_DIRS.includes(name) || name.startsWith('.')) skipped.push({ rel: here, why: IGNORED_DIRS.includes(name) ? name : 'hidden folder' })
			else if (topLevel ? SENSITIVE_DIR.test(name) : SENSITIVE_FILE.test(name) || SENSITIVE_SUBDIR.test(name)) skipped.push({ rel: here, why: 'sensitive name' })
			else walkText(join(abs, name), here, keep, skipped, skip, base)
		} else if (st.isFile()) {
			if (SENSITIVE_FILE.test(name)) skipped.push({ rel: here, why: 'sensitive name' })
			else if (!isTextName(name)) skipped.push({ rel: here, why: 'not text' })
			else if (st.size > MAX_BYTES) skipped.push({ rel: here, why: 'over 2 MB' })
			else keep.push({ rel: here, abs: join(abs, name) })
		}
	}
}

/** What `config backup` keeps from the Claude folder `claude`: CLAUDE.md, RTK.md, and the text of the skills (linked ones too), rules and rule-files, minus brain.json's configSkip prefixes. */
export function configFilesIn(claude, skipList = []) {
	const keep = []
	const skipped = []
	const skip = skipPrefixes(skipList)
	for (const name of TOP_FILES) {
		if (!existsSync(join(claude, name)) && !isLinkSafe(join(claude, name))) continue
		const st = lstatSync(join(claude, name))
		if (skippedByConfig(name, skip)) skipped.push({ rel: name, why: SKIPPED_BY_CONFIG })
		else if (st.isSymbolicLink()) skipped.push({ rel: name, why: 'symlink' })
		else if (st.size > MAX_BYTES) skipped.push({ rel: name, why: 'over 2 MB' })
		else keep.push({ rel: name, abs: join(claude, name) })
	}
	for (const folder of FOLDERS) {
		const abs = join(claude, folder)
		if (skippedByConfig(folder, skip)) skipped.push({ rel: folder, why: SKIPPED_BY_CONFIG })
		else if (isLinkSafe(abs)) skipped.push({ rel: folder, why: 'symlink' }) // the whole folder is someone else's
		else if (isDir(abs)) walkText(abs, folder, keep, skipped, skip, dirname(claude))
	}
	return { keep, skipped }
}

/** `configFilesIn` for a home folder: `<home>/.claude`. `rel` is the path inside .claude, e.g. `skills/graphify/SKILL.md`. */
export const configFiles = (home, skip = []) => configFilesIn(join(home, '.claude'), skip)

/** { reason: count } for a list of skipped files. */
export const countWhy = (skipped) => skipped.reduce((m, s) => ((m[s.why] = (m[s.why] ?? 0) + 1), m), {})

/** Every device that has a config backup in the clone (a link is not a folder). */
export function configDevices(cloneAbs) {
	const base = join(cloneAbs, 'bridge', 'config')
	return linkFree(cloneAbs, 'bridge', 'config') && isDir(base) ? readdirSync(base).filter((d) => isDir(join(base, d))).sort() : []
}

/** Copies one device's config backup into the Claude folder `claude`. An existing file stays unless `force`, or it is in `replace`. */
export function restoreConfig(cloneAbs, device, claude, force, replace = []) {
	const copied = []
	const kept = []
	const src = join(cloneAbs, configPath(device))
	if (!linkFree(cloneAbs, configPath(device))) return { copied, kept }
	const walk = (dir, rel) => {
		for (const name of readdirSync(dir).sort()) {
			if (!rel && !FOLDERS.includes(name) && !TOP_FILES.includes(name)) continue
			const here = rel ? `${rel}/${name}` : name
			const st = lstatSync(join(dir, name))
			if (st.isSymbolicLink()) continue
			if (st.isDirectory()) {
				const dest = join(claude, here)
				if (isLinkSafe(dest)) kept.push(`${here}/ (a symlink)`)
				else if (existsSync(dest) && !isDir(dest)) kept.push(`${here}/ (a file is there)`)
				else walk(join(dir, name), here)
			} else if (st.isFile() && isTextName(name) && (rel || TOP_FILES.includes(name))) {
				if (putFile(join(dir, name), join(claude, here), force || replace.includes(here))) copied.push(here)
				else kept.push(here)
			}
		}
	}
	walk(src, '')
	return { copied, kept }
}

// What instructions and the Brain cost per Claude Code session, in tokens (`wp-brain budget`).
// Node built-ins only. Reads the Claude folder, never writes to it.
//
//   tokensOf(text)              a cheap estimate: UTF-8 bytes / 4, so Devanagari (3 bytes a letter) is not undercounted
//   CAPS                        the targets the capped rows are held to
//   instructionFiles(dir, cwd)  every file Claude loads as instructions at the start, and why
//   measure({ ... })            the rows, and the names of the capped rows that are over target
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export const CAPS = { claudeMd: 6000, brief: 400, recall: 300, lastSession: 300, memorySummary: 200 }

const MAX_IMPORT_DEPTH = 4
const SKILL_FIELD_CHARS = 1536
/** A few prompts of the kinds people really type; the recall row reports the largest output over them. */
export const PROMPTS = [
	'fix the failing webhook retry on the payment ticket',
	'write the reel script hook for the ad',
	'how do I deploy the supabase edge function',
	'the flutter build fails on testflight upload',
	'add a changelog entry and commit the docs',
]

export const tokensOf = (text) => Math.ceil(Buffer.byteLength(text ?? '', 'utf8') / 4)

/**
 * Whole lines of `lines` within `maxTokens`, dropping from the end. When any are dropped the result ends with
 * `moreLine(dropped)` (counted in the cap). A single line that is over the cap on its own is cut at a code point with `…`.
 * Returns `{ lines, dropped }`.
 */
export function capLines(lines, maxTokens, moreLine) {
	const cost = (ls) => tokensOf(ls.join('\n'))
	if (cost(lines) <= maxTokens) return { lines: [...lines], dropped: 0 }
	for (let k = lines.length - 1; k >= 1; k--) {
		const out = moreLine ? [...lines.slice(0, k), moreLine(lines.length - k)] : lines.slice(0, k)
		if (cost(out) <= maxTokens) return { lines: out, dropped: lines.length - k }
	}
	// Not even the first line fits with what must follow it: cut that one.
	const dropped = lines.length - 1
	const tail = dropped && moreLine ? [moreLine(dropped)] : []
	const chars = Array.from(lines[0])
	let lo = 0
	let hi = chars.length
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2)
		if (cost([chars.slice(0, mid).join('') + '…', ...tail]) <= maxTokens) lo = mid
		else hi = mid - 1
	}
	return { lines: [chars.slice(0, lo).join('') + '…', ...tail], dropped }
}

const read = (p) => {
	try {
		return statSync(p).isFile() ? readFileSync(p, 'utf8') : null
	} catch {
		return null
	}
}

/** `---` frontmatter of a markdown file: its lines, or `broken` when it opens and never closes or has a line that is not YAML. */
function frontmatter(text) {
	if (!/^---\r?\n/.test(text)) return { lines: [] }
	const rest = text.replace(/^---\r?\n/, '').split(/\r?\n/)
	const end = rest.indexOf('---')
	if (end < 0) return { lines: [], broken: true }
	const lines = rest.slice(0, end)
	const broken = lines.some((l) => {
		if (!l.trim() || /^\s*#/.test(l)) return false
		if (/^\t/.test(l)) return true
		if (/^\s/.test(l) || /^-\s/.test(l)) return false // continuation or list item
		const m = l.match(/^[\w-]+:\s*(.*)$/)
		if (!m) return true
		const v = m[1]
		return (v.startsWith('"') && !/^"(?:[^"\\]|\\.)*"\s*$/.test(v)) || (v.startsWith("'") && !/^'(?:[^']|'')*'\s*$/.test(v))
	})
	return { lines, broken }
}

/** The value of a top-level key, with indented continuation lines joined; `undefined` when the key is absent. */
function fieldOf(lines, key) {
	const i = lines.findIndex((l) => l.startsWith(`${key}:`))
	if (i < 0) return undefined
	const parts = [lines[i].slice(key.length + 1)]
	for (let j = i + 1; j < lines.length && /^\s/.test(lines[j]); j++) parts.push(lines[j])
	return parts.join(' ').replace(/^\s*[>|][+-]?\s*/, '').replace(/\s+/g, ' ').trim().replace(/^(["'])(.*)\1$/, '$2')
}

/** `@path` imports in a CLAUDE.md, ignoring fenced blocks and anything in backticks. */
function importsOf(text) {
	const found = []
	let fence = null
	for (const raw of text.split(/\r?\n/)) {
		const f = raw.match(/^\s*(`{3,}|~{3,})/)
		if (f) {
			if (!fence) fence = f[1][0]
			else if (f[1][0] === fence) fence = null
			continue
		}
		if (fence) continue
		const line = raw.replace(/`[^`]*`/g, '')
		for (const m of line.matchAll(/(?:^|\s)@([^\s]+)/g)) found.push(m[1].replace(/[.,;:)\]]+$/, ''))
	}
	return found
}

/** A file and everything it imports, to four hops, each file once. */
function withImports(file, why, home, seen = new Set(), depth = 0) {
	const key = resolve(file)
	if (seen.has(key)) return []
	const text = read(file)
	if (text === null) return []
	seen.add(key)
	const out = [{ path: file, tokens: tokensOf(text), why }]
	if (depth >= MAX_IMPORT_DEPTH) return out
	for (const ref of importsOf(text)) {
		const target = ref.startsWith('~/') ? join(home, ref.slice(2)) : resolve(dirname(file), ref)
		out.push(...withImports(target, 'import', home, seen, depth + 1))
	}
	return out
}

function mdFiles(dir) {
	let names
	try {
		names = readdirSync(dir, { withFileTypes: true })
	} catch {
		return []
	}
	return names.flatMap((d) => (d.isDirectory() ? mdFiles(join(dir, d.name)) : d.name.endsWith('.md') ? [join(dir, d.name)] : []))
}

/**
 * Everything loaded as instructions before the first prompt: the global CLAUDE.md and what it imports, every rule
 * without a `paths` scope, and the project CLAUDE.md in `cwd`. A rule whose frontmatter can't be read is counted
 * (Claude can't tell it is scoped) and carries `broken: true`.
 */
export function instructionFiles(claudeDir, cwd) {
	const home = homedir() // `~/` in an import is the real home, also when CLAUDE_HOME points somewhere else
	const seen = new Set()
	const out = withImports(join(claudeDir, 'CLAUDE.md'), 'always', home, seen)
	for (const file of mdFiles(join(claudeDir, 'rules')).sort()) {
		const text = read(file)
		if (text === null) continue
		const fm = frontmatter(text)
		const paths = fm.broken ? undefined : fieldOf(fm.lines, 'paths') || (fm.lines.some((l) => /^paths:\s*$/.test(l)) && fm.lines.some((l) => /^\s*-\s/.test(l)))
		if (paths) continue
		out.push({ path: file, tokens: tokensOf(text), why: 'unscoped rule', ...(fm.broken ? { broken: true } : {}) })
	}
	if (cwd && resolve(cwd, 'CLAUDE.md') !== resolve(claudeDir, 'CLAUDE.md')) out.push(...withImports(join(cwd, 'CLAUDE.md'), 'always', home, seen).map((f) => ({ ...f, project: true })))
	return out
}

/** Skills: the name and description of each is always listed, each cut at 1,536 characters. */
function skillTokens(claudeDir) {
	let dirs
	try {
		dirs = readdirSync(join(claudeDir, 'skills'))
	} catch {
		return { count: 0, tokens: 0 }
	}
	let count = 0
	let tokens = 0
	for (const d of dirs) {
		const text = read(join(claudeDir, 'skills', d, 'SKILL.md'))
		if (text === null) continue
		const { lines } = frontmatter(text)
		const listed = `${fieldOf(lines, 'name') ?? d} ${fieldOf(lines, 'description') ?? ''}`.slice(0, SKILL_FIELD_CHARS)
		count++
		tokens += tokensOf(listed)
	}
	return { count, tokens }
}

/** The newest session transcript of this folder, if Claude Code keeps one under claudeDir/projects. */
function lastTranscript(claudeDir, cwd) {
	const dir = join(claudeDir, 'projects', resolve(cwd).replace(/[^A-Za-z0-9]/g, '-'))
	let files
	try {
		files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => ({ f: join(dir, f), t: statSync(join(dir, f)).mtimeMs }))
	} catch {
		return null
	}
	return files.sort((a, b) => b.t - a.t)[0]?.f ?? null
}

/**
 * What claude-mem's SessionStart hook put in front of Claude the last time, from the transcript: Claude Code records
 * each hook's stdout (`attachment.hook_success`, with `hookEvent` and `command`). The text is only counted, never kept.
 * Returns null when there is no transcript or no such hook in it.
 */
function claudeMemStart(claudeDir, cwd) {
	const file = lastTranscript(claudeDir, cwd)
	const text = file && read(file)
	if (!text) return null
	let total = 0
	let seenHook = false
	for (const line of text.split('\n')) {
		if (!line.includes('"hook_success"') || !line.includes('SessionStart') || !line.includes('claude-mem')) continue
		try {
			const a = JSON.parse(line).attachment
			if (a?.type !== 'hook_success' || a.hookEvent !== 'SessionStart' || !/claude-mem/.test(String(a.command))) continue
			seenHook = true
			total += tokensOf(String(a.stdout ?? ''))
		} catch {
			/* a partial line */
		}
	}
	return seenHook ? total : null
}

const NOT_SET_UP = 'not set up'

/**
 * `brief()` returns the text the SessionStart hook would print here (or null when it stays silent); `recall(prompt)`
 * returns what the UserPromptSubmit hook would print. Leave either out, or `cfg` null, when there is no Brain.
 * `memory` is left out while capture is off: { note, summaryTokens }, { empty: true } before anything is captured, or { unreadable: true } when its database won't open.
 */
export function measure({ claudeDir, cwd, cfg, brief, recall, memory, prompts = PROMPTS }) {
	const files = instructionFiles(claudeDir, cwd)
	const sum = (list) => list.reduce((n, f) => n + f.tokens, 0)
	const mine = files.filter((f) => !f.project)
	const global = mine.filter((f) => f.why !== 'unscoped rule')
	const rules = mine.filter((f) => f.why === 'unscoped rule')
	const project = files.filter((f) => f.project)
	const imports = global.filter((f) => f.why === 'import').length
	const rows = [{ name: 'CLAUDE.md', tokens: sum(global), target: CAPS.claudeMd, capped: true, note: imports ? `includes ${imports} import${imports > 1 ? 's' : ''}` : undefined }]
	if (rules.length) {
		const broken = rules.filter((f) => f.broken).map((f) => basename(f.path))
		rows.push({ name: 'Unscoped rules', tokens: sum(rules), capped: false, note: `${rules.length} file${rules.length > 1 ? 's' : ''} with no paths${broken.length ? `; unreadable frontmatter, counted: ${broken.join(', ')}` : ''}` })
	}
	if (project.length) rows.push({ name: 'Project CLAUDE.md', tokens: sum(project), capped: false })

	if (cfg && brief) {
		const text = brief()
		rows.push({ name: 'Brain brief', tokens: tokensOf(text ?? ''), target: CAPS.brief, capped: true, note: text ? undefined : 'silent here: no branch, or nothing recorded for it' })
	} else rows.push({ name: 'Brain brief', tokens: null, target: CAPS.brief, capped: true, note: NOT_SET_UP })

	if (cfg && recall) {
		const largest = Math.max(0, ...prompts.map((p) => tokensOf(recall(p) ?? '')))
		rows.push({ name: 'Brain recall', tokens: largest, target: CAPS.recall, capped: true, note: `largest of ${prompts.length} sample prompts` })
	} else rows.push({ name: 'Brain recall', tokens: null, target: CAPS.recall, capped: true, note: NOT_SET_UP })

	const memoryRow = (name, target, tokens, note) => {
		if (!memory) return { name, tokens: null, target, capped: true, note: 'off' }
		if (memory.empty) return { name, tokens: null, target, capped: true, note: 'nothing captured yet' }
		if (memory.unreadable) return { name, tokens: null, target, capped: true, note: 'its database did not open; run: wp-brain memory status' }
		return { name, tokens, target, capped: true, note }
	}
	rows.push(memoryRow('Last-session note', CAPS.lastSession, tokensOf(memory?.note ?? ''), memory?.note ? 'what the next session here would be shown' : 'nothing to show in this folder'))
	rows.push(memoryRow('Session summary', CAPS.memorySummary, memory?.summaryTokens, 'largest stored, next step included'))

	const skills = skillTokens(claudeDir)
	rows.push({ name: 'Skills', tokens: skills.tokens, capped: false, note: `${skills.count} skills, name + description at ${SKILL_FIELD_CHARS} chars each; plugin skills and the live total: /doctor and /context` })

	const mem = claudeMemStart(claudeDir, cwd)
	rows.push(mem === null ? { name: 'claude-mem SessionStart', tokens: null, capped: false, note: 'not measured, see /context' } : { name: 'claude-mem SessionStart', tokens: mem, capped: false, note: 'from the last session in this folder' })

	const over = rows.filter((r) => r.capped && r.tokens !== null && r.tokens > r.target).map((r) => r.name)
	// A rule whose frontmatter can't be read loads on every session without telling anyone: that fails the check, naming the files.
	const broken = rules.filter((f) => f.broken).map((f) => basename(f.path))
	if (broken.length) over.push(`Unscoped rules (unreadable frontmatter: ${broken.join(', ')})`)
	return { rows, over }
}

/** The rows as a table of text. */
export function render({ rows, over }) {
	const fmt = (n) => n.toLocaleString('en-US')
	const w = Math.max(...rows.map((r) => r.name.length))
	const lines = rows.map((r) => {
		const used = r.tokens === null ? '-' : fmt(r.tokens)
		const target = r.target ? `/ ${fmt(r.target)}` : ''
		const flag = r.capped && r.tokens !== null ? (r.tokens > r.target ? '  OVER' : '  ok') : ''
		return `${r.name.padEnd(w)}  ${used.padStart(7)} ${target.padEnd(8)}${flag}${r.note ? `  (${r.note})` : ''}`
	})
	return [...lines, '', over.length ? `Over target: ${over.join(', ')}` : 'Every capped row is within its target.'].join('\n')
}

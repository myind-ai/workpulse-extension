// How one line of a session file is read: roles, what is dropped, edited paths, and commit calls and results. Pure, and
// imports only built-ins and claude-files.mjs for stripWorktree: no file, database, git or mask here. memory-capture.mjs reads the files and re-exports parseLine.

import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'

import { stripWorktree } from './claude-files.mjs'

export { stripWorktree }

/** Row kinds seen in real files and left alone on purpose. Anything else counts towards format drift. */
export const BOOKKEEPING = /^(?:system|attachment|last-prompt|mode|permission-mode|atis-latch|ai-title|custom-title|queue-operation|cost-state|summary|progress|file-history-.*|api-request.*)$/
const PROMPT_SOURCES = new Set(['typed', 'suggestion_accepted', 'queued'])
const KNOWN_ASSISTANT_BLOCK = /^(?:tool_use|thinking|redacted_thinking|server_tool_use|mcp_tool_use|.*_tool_result)$/
const KNOWN_USER_BLOCK = /^(?:tool_result|image|document)$/
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

function roleOf(row) {
	if (row.isCompactSummary) return 'note'
	if (row.isMeta || row.isVisibleInTranscriptOnly) return 'injected'
	const kind = row.origin?.kind
	if (kind !== undefined && kind !== null && kind !== 'human') return 'injected'
	const source = row.promptSource
	if (source !== undefined && source !== null && !PROMPT_SOURCES.has(source)) return 'injected'
	return 'prompt'
}

const OPEN = '<system-reminder>'
const CLOSE = '</system-reminder>'
/** Removes whole reminder blocks by walking the text (a regex is quadratic on many openers). An opener with no closer is text. */
function withoutReminders(text) {
	let open = text.indexOf(OPEN)
	if (open === -1) return text
	let out = ''
	let done = 0
	while (open !== -1) {
		const close = text.indexOf(CLOSE, open)
		if (close === -1) break
		out += text.slice(done, open)
		done = close + CLOSE.length
		open = text.indexOf(OPEN, done)
	}
	return out + text.slice(done)
}

const clip = (text) => withoutReminders(text).trim()
const unquote = (s) => s.replace(/^(["'])(.*)\1$/, '$2')

const COMMIT = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:rtk\s+(?:proxy\s+)?)?git\s+((?:-C\s+(?:"[^"]*"|'[^']*'|\S+)\s+|-c\s+\S+\s+|--[\w-]+(?:=\S+)?\s+)*)commit(?=\s|$)/
const DASH_C = /-C\s+("[^"]*"|'[^']*'|\S+)/
const CD = /^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*$/

/** The folders to look for a commit in, if this command runs `git commit` (optional rtk, -C; not --dry-run). Otherwise null. */
function commitDirs(command, cwd) {
	if (typeof command !== 'string' || !command.includes('commit')) return null
	const at = (base, path) => (isAbsolute(path) ? path : base ? resolve(base, path) : null)
	let here = typeof cwd === 'string' ? cwd : null
	for (const segment of command.split(/&&|\|\||[;|\n]/)) {
		const cd = segment.match(CD)
		if (cd) {
			here = at(here, unquote(cd[1])) ?? here
			continue
		}
		const commit = segment.match(COMMIT)
		if (!commit || /\s--dry-run(?=\s|$)/.test(segment)) continue
		const dashC = commit[1].match(DASH_C)
		const dirs = [dashC ? at(here, unquote(dashC[1])) : null, here, typeof cwd === 'string' ? cwd : null]
		for (const d of [...dirs]) if (d) dirs.push(stripWorktree(d))
		return [...new Set(dirs.filter(Boolean))]
	}
	return null
}

const textOf = (value) => (typeof value === 'string' && value ? value : undefined)
const resultText = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n') : '')

/** One parsed row of a session file. Pure. Null when the row holds nothing kept.
 * Returns { session?, messages[], files[], commitCandidates[], assistantShape?, userShape? }; a shape is text, known or unknown,
 * for format drift, and a text block counts as known only if its text is a string. A field of the wrong type is left out. Tool input and output go no further than
 * commitCandidates, whose `content` is only read to look for a commit. */
export function parseLine(row) {
	if (!row || typeof row !== 'object') return null
	const out = { messages: [], files: [], commitCandidates: [] }
	if (typeof row.aiTitle === 'string' && row.aiTitle) {
		out.session = { title: row.aiTitle }
		return out
	}
	const at = Date.parse(row.timestamp)
	const when = Number.isFinite(at) ? at : null
	const uuid = () => textOf(row.uuid) || `line-${createHash('sha1').update(JSON.stringify(row)).digest('hex')}`
	const add = (block, role, text, subtype) => {
		const kept = typeof text === 'string' ? clip(text) : ''
		if (kept) out.messages.push({ uuid: uuid(), block, role, at: when, text: kept, ...(subtype ? { subtype } : {}) })
		return Boolean(kept)
	}
	const facts = { at: when, cwd: textOf(row.cwd), branch: textOf(row.gitBranch), entrypoint: textOf(row.entrypoint) }

	if (row.type === 'system') {
		if (row.subtype !== 'away_summary') return null
		add(0, 'note', row.content, 'away_summary')
		out.session = { ...facts, activity: false }
		return out
	}
	if (row.type !== 'user' && row.type !== 'assistant') return null

	out.session = { ...facts, activity: true }
	const content = row.message?.content
	if (row.type === 'user') {
		const role = roleOf(row)
		const subtype = role === 'note' ? 'compact' : undefined
		let hasText = false
		let known = false
		if (typeof content === 'string') {
			known = true
			hasText = add(0, role, content, subtype)
		} else if (Array.isArray(content)) {
			content.forEach((block, i) => {
				if (block?.type === 'text' ? typeof block.text === 'string' : KNOWN_USER_BLOCK.test(block?.type ?? '')) known = true
				if (block?.type === 'text') hasText = add(i, role, block.text, subtype) || hasText
				else if (block?.type === 'tool_result' && textOf(block.tool_use_id)) out.commitCandidates.push({ kind: 'result', id: block.tool_use_id, isError: Boolean(block.is_error), content: block.content, at: when })
			})
		}
		out.userShape = hasText ? 'text' : known ? 'known' : 'unknown'
		return out
	}

	let hasText = false
	let known = false
	if (typeof content === 'string') {
		known = true
		hasText = add(0, 'answer', content)
	} else if (Array.isArray(content)) {
		content.forEach((block, i) => {
			if (block?.type === 'text' ? typeof block.text === 'string' : KNOWN_ASSISTANT_BLOCK.test(block?.type ?? '')) known = true
			if (block?.type === 'text') hasText = add(i, 'answer', block.text) || hasText
			else if (block?.type === 'tool_use') {
				if (EDIT_TOOLS.has(block.name)) {
					const path = block.input?.file_path ?? block.input?.notebook_path
					if (typeof path === 'string' && path) out.files.push(path)
				} else if (block.name === 'Bash' && textOf(block.id)) {
					const dirs = commitDirs(block.input?.command, row.cwd)
					if (dirs) out.commitCandidates.push({ kind: 'call', id: block.id, dirs, at: when })
				}
			}
		})
	}
	out.assistantShape = hasText ? 'text' : known ? 'known' : 'unknown'
	return out
}

/** Hex tokens in a commit's result, likeliest first. They prove nothing until git has seen them. */
export function commitTokens(content) {
	const text = resultText(content).slice(0, 64 * 1024)
	const tokens = new Set()
	for (const m of text.matchAll(/\[[^\]\n]{0,200}?\b([0-9a-f]{7,40})\]/g)) tokens.add(m[1])
	for (const m of text.matchAll(/\b[0-9a-f]{7,40}\b/g)) {
		if (tokens.size >= 64) break
		tokens.add(m[0])
	}
	return [...tokens]
}

// Builds synthetic session files line by line, for the capture's tests, using only the fields measured in real ones
// (the plan's "Session file fields used"). Nothing here comes from a real session.

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

let serial = 0 // uuids are unique across builders, as real ones are

/** One session's line builder. Every row gets a fresh uuid and the current clock; `advance` moves the clock. */
export function transcript({ sessionId = 'session-1', cwd = '/tmp/fixture', branch = 'main', entrypoint = 'cli', start = Date.UTC(2026, 9, 1, 9) } = {}) {
	let now = start
	const base = (extra) => ({ sessionId, uuid: `${sessionId}-${++serial}`, timestamp: new Date(now).toISOString(), cwd, gitBranch: branch, entrypoint, ...extra })
	const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input })
	return {
		advance(ms) { now += ms; return this },
		/** A `user` row holding text: extra sets promptSource, origin, isMeta and the like. */
		user: (text, extra = {}) => base({ type: 'user', message: { role: 'user', content: text }, ...extra }),
		/** An `assistant` row with one text block. */
		answer: (text) => base({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }),
		/** An `assistant` row with the given blocks. */
		assistant: (...blocks) => base({ type: 'assistant', message: { role: 'assistant', content: blocks } }),
		thinking: (text) => base({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }] } }),
		tool: (id, name, input) => base({ type: 'assistant', message: { role: 'assistant', content: [toolUse(id, name, input)] } }),
		bash: (id, command) => base({ type: 'assistant', message: { role: 'assistant', content: [toolUse(id, 'Bash', { command })] } }),
		result: (id, content, is_error = false) => base({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } }),
		title: (aiTitle) => ({ type: 'ai-title', sessionId, aiTitle }),
		/** The system row that closes a turn: `turn_duration` or `stop_hook_summary`. */
		turnEnd: (subtype = 'turn_duration') => base({ type: 'system', subtype }),
		away: (content) => base({ type: 'system', subtype: 'away_summary', content }),
		compact: (text) => base({ type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: text } }),
		bookkeeping: (type = 'last-prompt') => ({ type, sessionId }),
	}
}

/** Rows as JSONL text. */
export const lines = (...rows) => rows.map((row) => `${JSON.stringify(row)}\n`).join('')

/** Writes rows to a new session file, making its folder. */
export function writeSession(path, ...rows) {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, lines(...rows))
	return path
}

/** Adds rows to a session file. */
export const appendSession = (path, ...rows) => appendFileSync(path, lines(...rows))

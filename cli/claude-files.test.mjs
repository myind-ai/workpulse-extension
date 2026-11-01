// node --test cli/claude-files.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { brainSandbox } from './sandbox.mjs'
import { claudeDir, isExcludedProject, mainTranscripts, memoryDbPath, projectsRoot, subagentFiles, ticketOf } from './claude-files.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'wp-claude-files-'))

test('mainTranscripts lists session files, skips the worker folder, and does not enter subagents/', () => {
	const root = tmp()
	try {
		for (const p of ['-Users-x-GitHub-app', '-Users-x--claude-mem-observer-sessions', '-Users-x-GitHub-claude-mem']) mkdirSync(join(root, p, 'abc', 'subagents'), { recursive: true })
		writeFileSync(join(root, '-Users-x-GitHub-app', 'abc.jsonl'), '{}\n')
		writeFileSync(join(root, '-Users-x-GitHub-app', 'abc', 'subagents', 'agent-1.jsonl'), '{}\n')
		writeFileSync(join(root, '-Users-x-GitHub-app', 'notes.txt'), 'x')
		writeFileSync(join(root, '-Users-x--claude-mem-observer-sessions', 'w.jsonl'), '{}\n')
		writeFileSync(join(root, '-Users-x-GitHub-claude-mem', 'keep.jsonl'), '{}\n')
		const found = mainTranscripts(root)
		assert.deepEqual(found.map((f) => f.sessionId).sort(), ['abc', 'keep'])
		const abc = found.find((f) => f.sessionId === 'abc')
		assert.equal(abc.size, 3)
		assert.equal(abc.inode, statSync(abc.path).ino)
		assert.ok(abc.mtimeMs > 0)
		assert.deepEqual(subagentFiles(abc.path).map((p) => p.split('/').pop()), ['agent-1.jsonl'])
		assert.deepEqual(subagentFiles(join(root, 'nope.jsonl')), [])
		assert.deepEqual(mainTranscripts(join(root, 'missing')), [])
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('helpers: exclusion, ticket key, and the folders the environment points at', () => {
	assert.equal(isExcludedProject('-Users-x--claude-mem-observer-sessions'), true)
	assert.equal(isExcludedProject('-Users-x-GitHub-claude-mem'), false)
	assert.equal(ticketOf('fix/pay-2433-thing'), 'PAY-2433')
	assert.equal(ticketOf('main'), undefined)
	const keep = { ...process.env }
	try {
		delete process.env.CLAUDE_HOME
		process.env.CLAUDE_CONFIG_DIR = '/c'
		assert.equal(projectsRoot(), '/c/projects')
		process.env.CLAUDE_HOME = '/h'
		assert.equal(claudeDir(), '/h')
		process.env.WP_MEMORY_DB = '/m.db'
		assert.equal(memoryDbPath(), '/m.db')
		delete process.env.WP_MEMORY_DB
		assert.match(memoryDbPath(), /\.workpulse\/memory\/memory\.db$/)
	} finally {
		for (const k of ['CLAUDE_HOME', 'CLAUDE_CONFIG_DIR', 'WP_MEMORY_DB']) keep[k] === undefined ? delete process.env[k] : (process.env[k] = keep[k])
	}
})

test('scan-claude keeps its timestamps-only promise', () => {
	const sentinel = 'SENTINEL-prompt-9f3a1c'
	const answer = 'SENTINEL-answer-4b7d2e'
	const run = (memory) => {
		const sb = brainSandbox({ config: memory ? { memory: true } : {} })
		try {
			const configDir = join(sb.root, 'claude-config')
			const dir = join(configDir, 'projects', '-Users-x-GitHub-app')
			mkdirSync(dir, { recursive: true })
			const now = Date.now()
			const rows = [
				{ type: 'user', timestamp: new Date(now - 600_000).toISOString(), message: { content: `please do ${sentinel}` } },
				{ type: 'assistant', timestamp: new Date(now - 300_000).toISOString(), message: { content: [{ type: 'text', text: answer }] } },
			]
			writeFileSync(join(dir, 'sess1.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
			const memoryDb = join(sb.root, 'mem', 'memory.db')
			const r = sb.runWith({ CLAUDE_HOME: configDir, WP_MEMORY_DB: memoryDb }, 'scan-claude', '--no-push')
			assert.equal(r.status, 0, r.err)
			const hits = []
			const walk = (d) => {
				for (const e of readdirSync(d, { withFileTypes: true })) {
					if (e.name === '.git') continue
					const p = join(d, e.name)
					if (e.isDirectory()) walk(p)
					else {
						const text = readFileSync(p, 'utf8')
						if (text.includes('SENTINEL')) hits.push(p)
					}
				}
			}
			walk(sb.clone)
			assert.deepEqual(hits, [])
			assert.equal(existsSync(memoryDb), false)
			assert.equal(existsSync(join(sb.root, 'mem')), false)
			return r.out.replace(/\d+ Claude Code interval/, 'N interval')
		} finally {
			rmSync(sb.root, { recursive: true, force: true })
		}
	}
	const off = run(false)
	const on = run(true)
	assert.equal(on, off)
	assert.match(on, /interval/)
})

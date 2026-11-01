// node --test cli/budget.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

import { CAPS, instructionFiles, measure, render, tokensOf } from './budget.mjs'
import { loadMask, openMemory, writeBatch } from './memory-db.mjs'
import { brainSandbox, CLI } from './sandbox.mjs'

/** A temp Claude folder (`dir`) and a temp project folder (`cwd`). `put` writes a file under a base. */
function folders() {
	const root = mkdtempSync(join(tmpdir(), 'wp-budget-'))
	const dir = join(root, '.claude')
	const cwd = join(root, 'project')
	mkdirSync(dir)
	mkdirSync(cwd)
	const put = (base, rel, text) => {
		mkdirSync(join(base, rel, '..'), { recursive: true })
		writeFileSync(join(base, rel), text)
	}
	return { root, dir, cwd, put }
}

const find = (files, name) => files.find((f) => f.path.endsWith(name))

test('tokensOf is bytes over four, so Devanagari costs its bytes, not its letters', () => {
	assert.equal(tokensOf('abcd'), 1)
	assert.equal(tokensOf(''), 0)
	assert.equal(tokensOf('मराठी'), Math.ceil(15 / 4)) // 5 letters, 15 bytes
	assert.ok(tokensOf('मराठी') > tokensOf('abcde'))
})

test('an @import is followed and counted; one in backticks or a fence is not', () => {
	const { dir, cwd, put } = folders()
	put(dir, 'CLAUDE.md', 'rules\n@RTK.md\nuse `@Inline.md` here\n```\n@Fenced.md\n```\n')
	put(dir, 'RTK.md', 'x'.repeat(400))
	put(dir, 'Inline.md', 'y'.repeat(400))
	put(dir, 'Fenced.md', 'z'.repeat(400))
	const files = instructionFiles(dir, cwd)
	assert.equal(find(files, 'RTK.md').why, 'import')
	assert.equal(find(files, 'CLAUDE.md').why, 'always')
	assert.equal(find(files, 'Inline.md'), undefined)
	assert.equal(find(files, 'Fenced.md'), undefined)
})

test('imports stop after four hops, and a circular import does not hang', () => {
	const { dir, cwd, put } = folders()
	put(dir, 'CLAUDE.md', '@a1.md\n')
	for (let i = 1; i <= 6; i++) put(dir, `a${i}.md`, `@a${i + 1}.md\n`)
	put(dir, 'a7.md', 'end\n')
	const names = instructionFiles(dir, cwd).map((f) => f.path.split('/').pop())
	assert.deepEqual(names, ['CLAUDE.md', 'a1.md', 'a2.md', 'a3.md', 'a4.md'])

	put(dir, 'CLAUDE.md', '@loop.md\n')
	put(dir, 'loop.md', '@CLAUDE.md\n@loop.md\n')
	assert.deepEqual(instructionFiles(dir, cwd).map((f) => f.path.split('/').pop()), ['CLAUDE.md', 'loop.md'])
})

test('rules: a file with paths is not counted, one without is, and broken frontmatter is counted and named', () => {
	const { dir, cwd, put } = folders()
	put(dir, 'rules/scoped.md', '---\npaths:\n  - "src/**"\n---\nonly for src\n')
	put(dir, 'rules/inline-scoped.md', '---\npaths: "src/**"\n---\nonly for src\n')
	put(dir, 'rules/plain.md', 'always loaded\n')
	put(dir, 'rules/nested/other.md', '---\ndescription: no scope\n---\nalways loaded\n')
	put(dir, 'rules/broken.md', '---\npaths: "src/**\nnot yaml at all\n---\ntext\n')
	put(dir, 'rules/unclosed.md', '---\npaths:\n  - x\n')
	const files = instructionFiles(dir, cwd)
	const rules = files.filter((f) => f.why === 'unscoped rule').map((f) => f.path.split('/').pop()).sort()
	assert.deepEqual(rules, ['broken.md', 'other.md', 'plain.md', 'unclosed.md'])
	assert.equal(find(files, 'broken.md').broken, true)
	assert.equal(find(files, 'plain.md').broken, undefined)

	const { rows } = measure({ claudeDir: dir, cwd, cfg: null })
	const row = rows.find((r) => r.name === 'Unscoped rules')
	assert.match(row.note, /broken\.md/)
	assert.match(row.note, /unclosed\.md/)
	assert.doesNotMatch(row.note, /plain\.md/)
})

test('a project CLAUDE.md in cwd is its own row, apart from the global one', () => {
	const { dir, cwd, put } = folders()
	put(dir, 'CLAUDE.md', 'g'.repeat(400))
	put(cwd, 'CLAUDE.md', 'p'.repeat(800))
	const { rows } = measure({ claudeDir: dir, cwd, cfg: null })
	assert.equal(rows.find((r) => r.name === 'CLAUDE.md').tokens, 100)
	assert.equal(rows.find((r) => r.name === 'Project CLAUDE.md').tokens, 200)
})

test('CLAUDE.md row counts its imports, is held to the cap, and over lists it', () => {
	const { dir, cwd, put } = folders()
	put(dir, 'CLAUDE.md', 'a'.repeat(4 * 4000) + '\n@RTK.md\n')
	put(dir, 'RTK.md', 'b'.repeat(4 * 3000))
	const r = measure({ claudeDir: dir, cwd, cfg: null })
	const row = r.rows.find((x) => x.name === 'CLAUDE.md')
	assert.ok(row.tokens >= 7000)
	assert.equal(row.target, CAPS.claudeMd)
	assert.equal(row.capped, true)
	assert.match(row.note, /1 import/)
	assert.deepEqual(r.over, ['CLAUDE.md'])
})

test('the brief row is the real output, and no Brain is "not set up", not 0', () => {
	const { dir, cwd } = folders()
	const none = measure({ claudeDir: dir, cwd, cfg: null }).rows
	assert.deepEqual([none.find((r) => r.name === 'Brain brief').tokens, none.find((r) => r.name === 'Brain brief').note], [null, 'not set up'])
	assert.equal(none.find((r) => r.name === 'Brain recall').note, 'not set up')

	const text = 'x'.repeat(4 * 500)
	const set = measure({ claudeDir: dir, cwd, cfg: {}, brief: () => text, recall: () => '' })
	const row = set.rows.find((r) => r.name === 'Brain brief')
	assert.equal(row.tokens, 500)
	assert.equal(row.target, CAPS.brief)
	assert.ok(set.over.includes('Brain brief'))

	const quiet = measure({ claudeDir: dir, cwd, cfg: {}, brief: () => null, recall: () => '' }).rows.find((r) => r.name === 'Brain brief')
	assert.equal(quiet.tokens, 0)
	assert.match(quiet.note, /silent/)
})

test('the recall row is the cap and the largest output over the sample prompts', () => {
	const { dir, cwd } = folders()
	const prompts = ['short', 'the long one', 'mid']
	const out = { short: 'a'.repeat(40), 'the long one': 'b'.repeat(4 * 350), mid: 'c'.repeat(200) }
	const r = measure({ claudeDir: dir, cwd, cfg: {}, brief: () => null, recall: (p) => out[p], prompts })
	const row = r.rows.find((x) => x.name === 'Brain recall')
	assert.equal(row.tokens, 350)
	assert.equal(row.target, CAPS.recall)
	assert.match(row.note, /largest of 3/)
	assert.ok(r.over.includes('Brain recall'))
	const ok = measure({ claudeDir: dir, cwd, cfg: {}, brief: () => null, recall: () => 'a'.repeat(40), prompts })
	assert.deepEqual(ok.over, [])
})

test('skills: name plus description at 1,536 chars each, not capped, and the note points at /doctor and /context', () => {
	const { dir, cwd, put } = folders()
	put(dir, 'skills/small/SKILL.md', '---\nname: small\ndescription: four\n---\nbody that is never counted '.concat('q'.repeat(5000)))
	put(dir, 'skills/long/SKILL.md', `---\nname: long\ndescription: ${'d'.repeat(5000)}\n---\nbody\n`)
	put(dir, 'skills/folded/SKILL.md', '---\nname: folded\ndescription: >\n  first line\n  second line\n---\nbody\n')
	const row = measure({ claudeDir: dir, cwd, cfg: null }).rows.find((r) => r.name === 'Skills')
	const expected = tokensOf('small four') + tokensOf(`long ${'d'.repeat(5000)}`.slice(0, 1536)) + tokensOf('folded first line second line')
	assert.equal(row.tokens, expected)
	assert.equal(row.capped, false)
	assert.match(row.note, /\/doctor/)
	assert.match(row.note, /\/context/)
})

test('claude-mem: counted from the last transcript when it is there, otherwise "not measured"', () => {
	const { dir, cwd, put } = folders()
	let row = measure({ claudeDir: dir, cwd, cfg: null }).rows.find((r) => r.name === 'claude-mem SessionStart')
	assert.equal(row.tokens, null)
	assert.equal(row.note, 'not measured, see /context')

	const folder = cwd.replace(/[^A-Za-z0-9]/g, '-')
	const hook = (command, stdout, hookEvent = 'SessionStart') => JSON.stringify({ type: 'attachment', attachment: { type: 'hook_success', hookEvent, command, stdout } })
	put(dir, `projects/${folder}/s1.jsonl`, [hook('node /x/claude-mem/start.js', 'm'.repeat(4 * 120)), hook('node /x/other.js', 'o'.repeat(4000)), hook('node /x/claude-mem/pre.js', 'p'.repeat(4000), 'PreToolUse'), 'not json at all SessionStart claude-mem hook_success'].join('\n'))
	row = measure({ claudeDir: dir, cwd, cfg: null }).rows.find((r) => r.name === 'claude-mem SessionStart')
	assert.equal(row.tokens, 120)
	assert.equal(row.capped, false)
})

test('render shows OVER and "-" for an unmeasured row', () => {
	const text = render({ rows: [{ name: 'CLAUDE.md', tokens: 7000, target: 6000, capped: true }, { name: 'Brain brief', tokens: null, target: 400, capped: true, note: 'not set up' }], over: ['CLAUDE.md'] })
	assert.match(text, /CLAUDE\.md\s+7,000 \/ 6,000\s+OVER/)
	assert.match(text, /Brain brief\s+-\s+\/ 400\s+\(not set up\)/)
	assert.match(text, /Over target: CLAUDE\.md/)
})

test('wp-brain budget --check exits 1 over target and 0 under; --json is the rows', () => {
	const { root, dir, put } = folders()
	const sb = brainSandbox()
	const env = { CLAUDE_HOME: dir, HOME: root }
	const run = (...args) => spawnSync('node', [CLI, 'budget', ...args], { encoding: 'utf8', cwd: root, env: { ...process.env, ...env, WP_BRAIN_CONFIG: join(root, 'no-brain.json'), WP_BRAIN_SESSIONS: sb.sessions, WP_BRAIN_DB: sb.dbFile } })

	put(dir, 'CLAUDE.md', 'a'.repeat(4 * 7000))
	let r = run('--check')
	assert.equal(r.status, 1)
	assert.match(r.stdout, /Over target: CLAUDE\.md/)

	put(dir, 'CLAUDE.md', 'a'.repeat(4 * 100))
	r = run('--check')
	assert.equal(r.status, 0, r.stdout + r.stderr)

	const json = JSON.parse(run('--json').stdout)
	assert.equal(json.rows.find((x) => x.name === 'CLAUDE.md').tokens, 100)
	assert.deepEqual(json.over, [])
	assert.equal(json.rows.find((x) => x.name === 'Brain brief').note, 'not set up')
})

/** `wp-brain budget --json` on a sandbox Brain, run from `cwd`, with a temp Claude folder. */
function budgetOn(sb, cwd, { args = ['--json'], env = {}, status = 0 } = {}) {
	const { root, dir } = folders()
	const r = spawnSync('node', [CLI, 'budget', ...args], { encoding: 'utf8', cwd, env: { ...process.env, CLAUDE_HOME: dir, HOME: root, WP_BRAIN_CONFIG: sb.configPath, WP_BRAIN_SESSIONS: sb.sessions, WP_BRAIN_DB: sb.dbFile, ...env } })
	assert.equal(r.status, status, r.stdout + r.stderr)
	if (!args.includes('--json')) return r.stdout
	return Object.fromEntries(JSON.parse(r.stdout).rows.map((x) => [x.name, x]))
}

function ticketFolder(sb) {
	const repo = mkdtempSync(join(tmpdir(), 'wp-budget-repo-'))
	const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
	git('init', '-q', '-b', 'fix/pay-9-retry-webhook')
	const entries = Array.from({ length: 40 }, (_, i) => ({ kind: 'debug', title: `PAY-9 step ${i}: the webhook retry handled event ${i} in a way that needed a closer look`, ticket: 'PAY-9', rootCause: `root cause ${i}: the payload was read twice` }))
	for (const [i, word] of ['webhook retry', 'reel script', 'supabase edge function', 'flutter testflight upload', 'changelog commit docs'].entries()) {
		entries.push({ kind: 'learning', title: `${word} lesson ${i}: ${'a long title that goes on about the same thing '.repeat(6)}`, body: 'B'.repeat(900), source: { type: 'site', url: `https://example.com/${'long-path/'.repeat(30)}${i}` } })
	}
	const r = sb.runWith({ input: JSON.stringify(entries) }, 'add', '--json', '-', '--no-push')
	assert.equal(r.status, 0, r.err)
	return repo
}

test('budget on a configured Brain measures the capped brief and recall end to end', () => {
	const sb = brainSandbox()
	const repo = ticketFolder(sb)
	sb.run('db', 'rebuild')
	const rows = budgetOn(sb, repo)
	assert.ok(rows['Brain brief'].tokens > 0, 'a brief is printed for this branch')
	assert.ok(rows['Brain brief'].tokens <= CAPS.brief, `${rows['Brain brief'].tokens} tokens`)
	assert.ok(rows['Brain recall'].tokens > 0, 'at least one sample prompt recalls a lesson')
	assert.ok(rows['Brain recall'].tokens <= CAPS.recall, `${rows['Brain recall'].tokens} tokens`)
})

test('budget reports a brief only where the hook would print one: not in a folder with no branch', () => {
	const sb = brainSandbox()
	ticketFolder(sb)
	// A waiting request is the one thing that made the old measure print a brief where the hook stays silent.
	const inbox = join(sb.clone, 'bridge', 'inbox', 'to-cli')
	mkdirSync(inbox, { recursive: true })
	writeFileSync(join(inbox, 'r1.json'), JSON.stringify({ id: 'r1', at: 1, text: 'Please look at the retry' }))
	const nowhere = mkdtempSync(join(tmpdir(), 'wp-budget-nogit-'))
	const row = budgetOn(sb, nowhere)['Brain brief']
	assert.equal(row.tokens, 0)
	assert.match(row.note, /silent here/)
})

test('budget with a config whose clone folder is gone says not set up, and does not crash', () => {
	const sb = brainSandbox()
	const repo = ticketFolder(sb)
	rmSync(sb.clone, { recursive: true, force: true })
	const rows = budgetOn(sb, repo)
	for (const name of ['Brain brief', 'Brain recall']) {
		assert.equal(rows[name].tokens, null)
		assert.equal(rows[name].note, 'not set up')
	}
})

test('final review 2: a rule with broken frontmatter fails --check, and a parseable unscoped rule only reports', () => {
	const { root, dir, put } = folders()
	const sb = brainSandbox()
	const run = (...args) =>
		spawnSync('node', [CLI, 'budget', ...args], { encoding: 'utf8', cwd: root, env: { ...process.env, CLAUDE_HOME: dir, HOME: root, WP_BRAIN_CONFIG: join(root, 'no-brain.json'), WP_BRAIN_SESSIONS: sb.sessions, WP_BRAIN_DB: sb.dbFile } })
	put(dir, 'CLAUDE.md', 'a'.repeat(400))
	put(dir, 'rules/plain.md', 'always loaded\n')
	assert.equal(run('--check').status, 0, 'an unscoped rule that parses is allowed')
	put(dir, 'rules/broken.md', '---\npaths: "src/**\nnot yaml at all\n---\ntext\n')
	const r = run('--check')
	assert.equal(r.status, 1, r.stdout)
	assert.match(r.stdout, /Over target: .*Unscoped rules.*broken\.md/)
	assert.deepEqual(JSON.parse(run('--json').stdout).over.length, 1)
})

test('final review: a ~/ import resolves against the home folder, not the folder above a custom CLAUDE_HOME', () => {
	const root = mkdtempSync(join(tmpdir(), 'wp-budget-home-'))
	const claude = join(root, 'elsewhere', 'claude-config')
	mkdirSync(claude, { recursive: true })
	mkdirSync(join(root, 'h'))
	writeFileSync(join(claude, 'CLAUDE.md'), 'core\n@~/notes.md\n')
	writeFileSync(join(root, 'h', 'notes.md'), 'n'.repeat(400))
	const was = process.env.HOME
	process.env.HOME = join(root, 'h')
	try {
		assert.equal(instructionFiles(claude, undefined).filter((f) => f.why === 'import').length, 1)
	} finally {
		process.env.HOME = was
	}
})

// ---- session memory ----------------------------------------------------------------------------------------

test('CAPS holds the note and the summary', () => {
	assert.equal(CAPS.lastSession, 300)
	assert.equal(CAPS.memorySummary, 200)
})

test('measure: off, both memory rows read off and are not counted', () => {
	const { dir, cwd } = folders()
	const { rows, over } = measure({ claudeDir: dir, cwd, cfg: null })
	for (const name of ['Last-session note', 'Session summary']) {
		const row = rows.find((r) => r.name === name)
		assert.equal(row.tokens, null)
		assert.equal(row.note, 'off')
	}
	assert.deepEqual(over, [])
	assert.match(render({ rows, over }), /Last-session note +- \/ 300 +\(off\)/)
})

test('measure: on, an oversized note or summary fails the check', () => {
	const { dir, cwd } = folders()
	const ok = measure({ claudeDir: dir, cwd, cfg: null, memory: { note: 'short', summaryTokens: 150 } })
	assert.equal(ok.rows.find((r) => r.name === 'Last-session note').tokens, tokensOf('short'))
	assert.equal(ok.rows.find((r) => r.name === 'Session summary').tokens, 150)
	assert.deepEqual(ok.over, [])
	const big = measure({ claudeDir: dir, cwd, cfg: null, memory: { note: 'x'.repeat(1300), summaryTokens: 201 } })
	assert.deepEqual(big.over, ['Last-session note', 'Session summary'])
})

/** Temp folders for one test, removed after it. */
function tempFolders(t, ...names) {
	return names.map((name) => {
		const path = realpathSync(mkdtempSync(join(tmpdir(), `wp-budget-${name}-`)))
		t.after(() => rmSync(path, { recursive: true, force: true }))
		return path
	})
}

test('budget with memory on shows the real note for this folder and the largest summary; --check still works', async (t) => {
	const [memoryFolder, repo] = tempFolders(t, 'mem', 'norepo')
	const dbPath = join(memoryFolder, 'memory.db')
	const sb = brainSandbox({ config: { memory: true, capture_since: 1 } })
	t.after(() => rmSync(sb.root, { recursive: true, force: true }))
	const env = { WP_MEMORY_DB: dbPath }
	const empty = budgetOn(sb, repo, { env })
	assert.equal(empty['Last-session note'].tokens, null, 'no database yet')
	for (const name of ['Last-session note', 'Session summary']) assert.equal(empty[name].note, 'nothing captured yet')
	writeFileSync(dbPath, 'not a database, '.repeat(500))
	assert.match(budgetOn(sb, repo, { env })['Last-session note'].note, /did not open/, 'a broken file still says so')
	rmSync(dbPath)

	const db = openMemory(dbPath)
	const mask = await loadMask()
	writeBatch(db, { session: { id: 'earlier', repo, cwd: repo, entrypoint: 'cli', lastEventAt: Date.now() - 60_000 }, messages: [{ uuid: 'u', block: 0, role: 'prompt', at: Date.now(), text: 'typed' }] }, { mask })
	writeBatch(db, { summary: { session: 'earlier', at: Date.now(), text: 'A short summary.', next: 'next' } }, { mask })
	db.close()
	const rows = budgetOn(sb, repo, { env })
	assert.ok(rows['Last-session note'].tokens > 0)
	assert.ok(rows['Last-session note'].tokens <= CAPS.lastSession)
	assert.equal(rows['Session summary'].tokens, tokensOf('A short summary.') + tokensOf('next'))
	const table = budgetOn(sb, repo, { args: ['--check'], env })
	assert.match(table, /Last-session note/)
})

test('budget with memory off reads off and opens no database', (t) => {
	const [memoryFolder, repo] = tempFolders(t, 'mem', 'norepo')
	const dbPath = join(memoryFolder, 'gone', 'memory.db')
	const sb = brainSandbox()
	t.after(() => rmSync(sb.root, { recursive: true, force: true }))
	const rows = budgetOn(sb, repo, { env: { WP_MEMORY_DB: dbPath } })
	assert.equal(rows['Last-session note'].note, 'off')
	assert.equal(rows['Session summary'].note, 'off')
	assert.equal(existsSync(join(dbPath, '..')), false)
})

// node --test cli/memory-hook.test.mjs
// Every test runs in a temp HOME with temp CLAUDE_HOME, WP_BRAIN_CONFIG and WP_MEMORY_DB. Session files are synthetic.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { captureLowerBound, settingsRunHook } from './claude-files.mjs'
import { openMemory } from './memory-db.mjs'
import { transcript, writeSession } from './memory-fixture.mjs'
import { brainSandbox, withinBudget } from './sandbox.mjs'
import { placeMemoryHooks } from './setup.mjs'

const CLI_DIR = dirname(fileURLToPath(import.meta.url))
const HOOK = join(CLI_DIR, 'memory-hook.mjs')
const EVENTS = ['session-start', 'stop', 'session-end']
const SID = 'aaaaaaaa-1111-2222-3333-444444444444'

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// Leaves one marker file holding the arguments it got, after WP_FAKE_DELAY ms.
const FAKE_WORKER = `
import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
await new Promise((done) => setTimeout(done, Number(process.env.WP_FAKE_DELAY || 0)))
const tmp = process.env.WP_FAKE_MARKS + '.' + process.pid
writeFileSync(tmp, JSON.stringify(process.argv.slice(2)))
renameSync(tmp, join(process.env.WP_FAKE_MARKS, process.pid + '.json')) // whole or not there: the test polls this folder
`

/** A temp HOME with a fake worker. `config`: an object is written as JSON, a string as is, null means no brain.json. */
function hookBox(t, config = { repo: 'me/brain', memory: true, capture_since: 1234 }, extra = {}) {
	const root = mkdtempSync(join(tmpdir(), 'wp-memhook-'))
	t.after(() => rmSync(root, { recursive: true, force: true }))
	const marks = join(root, 'marks')
	mkdirSync(marks)
	const worker = join(root, 'fake-worker.mjs')
	writeFileSync(worker, FAKE_WORKER)
	const claude = join(root, 'claude')
	mkdirSync(claude)
	const configPath = join(root, 'brain.json')
	if (config !== null) writeFileSync(configPath, typeof config === 'string' ? config : JSON.stringify(config))
	const db = join(root, 'memory', 'memory.db')
	if (config && config.memory === true) openMemory(db).close() // as `memory on` leaves it: a missing database warns
	const env = { ...process.env, HOME: root, WP_BRAIN_CONFIG: configPath, WP_MEMORY_DB: db, WP_MEMORY_WORKER: worker, WP_BRAIN_SESSIONS: join(root, 'sessions'), WP_FAKE_MARKS: marks, CLAUDE_HOME: claude, CLAUDE_CONFIG_DIR: claude, ...extra }
	const hook = (args, input = JSON.stringify({ session_id: SID, transcript_path: join(claude, 'projects', '-p', `${SID}.jsonl`) }), more = {}, node = process.execPath) =>
		spawnSync(node, [HOOK, ...args], { input, encoding: 'utf8', timeout: 30_000, env: { ...env, ...more } })
	const seen = () => readdirSync(marks).map((f) => JSON.parse(readFileSync(join(marks, f), 'utf8')))
	const waitFor = (n, ms = 20_000) => {
		const end = Date.now() + ms
		while (seen().length < n && Date.now() < end) pause(25)
		return seen()
	}
	return { root, claude, db, configPath, hook, seen, waitFor, env }
}

const silent = (r, why = '') => {
	assert.equal(r.status, 0, `${why} exit: ${r.stderr}`)
	assert.equal(r.stdout, '', `${why} stdout`)
	assert.equal(r.stderr, '', `${why} stderr`)
}

function assertNothingHappened(box, why) {
	for (const event of EVENTS) {
		silent(box.hook([event]), `${why} ${event}`)
		silent(box.hook([event, '--plugin']), `${why} ${event} --plugin`)
	}
	pause(700) // long enough for a started process to write its marker on this machine
	assert.deepEqual(box.seen(), [], `${why}: no process started`)
	assert.equal(existsSync(dirname(box.db)), false, `${why}: no database folder`)
	assert.equal(existsSync(box.env.WP_BRAIN_SESSIONS), false, `${why}: no sessions folder`)
}

// ---- off by default ------------------------------------------------------------------------------------

test('off by default: no "memory" key means no output, no database, no process, exit 0', (t) => {
	assertNothingHappened(hookBox(t, { repo: 'me/brain' }), 'no key')
})

test('off: any value but true behaves the same', (t) => {
	for (const raw of ['{"memory":"true"}', '{"memory":1}', '{"memory":false,"capture_since":5}']) assertNothingHappened(hookBox(t, raw), raw)
})

const CANNOT_READ = 'WARNING: session memory cannot read brain.json, so nothing is being captured.'

/** Only the settings copy `memory on` installed runs without --plugin, so that person opted in: session start says so, once, and still nothing starts. */
function assertUnreadable(box, why) {
	const start = box.hook(['session-start'])
	assert.equal(start.status, 0, `${why}: ${start.stderr}`)
	assert.equal(start.stderr, '', why)
	assert.deepEqual(JSON.parse(start.stdout), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: CANNOT_READ } }, why)
	for (const event of EVENTS) {
		if (event !== 'session-start') silent(box.hook([event]), `${why} ${event}`)
		silent(box.hook([event, '--plugin']), `${why} ${event} --plugin`)
	}
	pause(700)
	assert.deepEqual(box.seen(), [], `${why}: no process started`)
	assert.equal(existsSync(dirname(box.db)), false, `${why}: no database folder`)
	assert.equal(existsSync(box.env.WP_BRAIN_SESSIONS), false, `${why}: no sessions folder`)
}

test('a missing or broken brain.json: the settings copy warns at session start; the plugin stays silent; nothing starts', (t) => {
	assertUnreadable(hookBox(t, null), 'missing')
	for (const raw of ['{not json', '', 'null', '[]', '"memory"', '{"memory": true,}']) assertUnreadable(hookBox(t, raw), raw)
})

test('off: a session file is never opened', (t) => {
	const box = hookBox(t, { repo: 'me/brain' })
	const dir = join(box.claude, 'projects', '-p')
	mkdirSync(dir, { recursive: true })
	// Opening a FIFO with no writer blocks for good, so a hook that touches it would hit spawnSync's timeout.
	const fifo = join(dir, `${SID}.jsonl`)
	execFileSync('mkfifo', [fifo])
	for (const event of EVENTS) {
		silent(box.hook([event]), event)
		silent(box.hook([event], JSON.stringify({ session_id: SID })), `${event}, path found by name`)
	}
})

test('setup --defaults leaves it off and installs none of its hooks', (t) => {
	const { b, read } = cliBox(t)
	const r = b.run('setup', '--defaults', '--repo', 'test/brain', '--no-push', '--clone', b.clone)
	assert.equal(r.status, 0, r.err)
	assert.equal(JSON.parse(readFileSync(b.configPath, 'utf8')).memory, undefined)
	assert.ok(!JSON.stringify(read()).includes('memory-hook.mjs'))
	assert.equal(existsSync(join(b.root, 'memory')), false)
})

// ---- what it passes on ---------------------------------------------------------------------------------

test('stop and session-end pass the session id and path to the worker', (t) => {
	for (const event of ['stop', 'session-end']) {
		const box = hookBox(t)
		const path = join(box.claude, 'projects', '-p', `${SID}.jsonl`)
		silent(box.hook([event], JSON.stringify({ session_id: SID, transcript_path: path })), event)
		assert.deepEqual(box.waitFor(1), [['--session', SID, '--transcript', path]])
	}
})

test('session-start starts a sweep from capture_since; without a usable one, none', (t) => {
	const box = hookBox(t)
	silent(box.hook(['session-start'], ''))
	assert.deepEqual(box.waitFor(1), [['--since', '1234']])
	for (const capture_since of [undefined, 'yesterday', null, -1, 0]) {
		const none = hookBox(t, { memory: true, capture_since })
		silent(none.hook(['session-start'], ''))
		pause(500)
		assert.deepEqual(none.seen(), [], 'a hand-edited flag never sweeps the whole backlog')
	}
})

test('with no transcript_path the session file is found by name, outside excluded folders', (t) => {
	const box = hookBox(t)
	const path = writeSession(join(box.claude, 'projects', '-p', `${SID}.jsonl`), transcript({ sessionId: SID }).user('synthetic'))
	silent(box.hook(['stop'], JSON.stringify({ session_id: SID })))
	assert.deepEqual(box.waitFor(1), [['--session', SID, '--transcript', path]])

	const excluded = hookBox(t)
	writeSession(join(excluded.claude, 'projects', '-x--claude-mem-observer-sessions', `${SID}.jsonl`), transcript({ sessionId: SID }).user('synthetic'))
	silent(excluded.hook(['stop'], JSON.stringify({ session_id: SID })), 'found only in an excluded folder')
	silent(excluded.hook(['stop'], JSON.stringify({ session_id: 'nowhere' })), 'found nowhere')
	pause(500)
	assert.deepEqual(excluded.seen(), [])
})

test("another tool's worker session starts no process, on any event", (t) => {
	const box = hookBox(t)
	const input = JSON.stringify({ session_id: SID, transcript_path: join(box.claude, 'projects', '-x--claude-mem-observer-sessions', `${SID}.jsonl`) })
	for (const event of EVENTS) silent(box.hook([event], input), event)
	pause(500)
	assert.deepEqual(box.seen(), [])
})

test('malformed stdin, an unset or unsafe session id, and an unknown event: exit 0, silent, nothing started', (t) => {
	const box = hookBox(t)
	const bad = ['', '{not json', 'null', '[]', '"text"', '{}', '{"session_id":null}', '{"session_id":7}', '{"session_id":""}', '{"session_id":"../../etc/x"}', '{"session_id":"a b"}']
	for (const input of bad) silent(box.hook(['stop'], input), input)
	silent(box.hook(['session-end'], '{not json'))
	silent(box.hook(['no-such-event']))
	silent(box.hook([]))
	pause(700)
	assert.deepEqual(box.seen(), [])
})

test('a worker that cannot start: exit 0 and silent', (t) => {
	const box = hookBox(t, undefined, { WP_MEMORY_WORKER: join(tmpdir(), 'wp-no-such-worker.mjs') })
	for (const event of EVENTS) silent(box.hook([event]), event)
	// spawn itself throws on a NUL in an argument.
	silent(box.hook(['stop'], JSON.stringify({ session_id: SID, transcript_path: 'bad\u0000path' })), 'spawn throws')
})

test('a transcript that is a FIFO is not opened by the hook: it only passes the path on', (t) => {
	const box = hookBox(t)
	const dir = join(box.claude, 'projects', '-p')
	mkdirSync(dir, { recursive: true })
	const fifo = join(dir, `${SID}.jsonl`)
	execFileSync('mkfifo', [fifo])
	silent(box.hook(['stop'], JSON.stringify({ session_id: SID, transcript_path: fifo })))
	assert.equal(box.waitFor(1).length, 1)
})

// ---- never waits ---------------------------------------------------------------------------------------

test('never waits: with a worker that sleeps 5 s, stop returns in under 1 s and the marker appears later', (t) => {
	const box = hookBox(t, undefined, { WP_FAKE_DELAY: '5000' })
	const started = Date.now()
	const r = box.hook(['stop'])
	const took = Date.now() - started
	silent(r)
	assert.ok(took < 1000, `stop took ${took} ms`)
	assert.deepEqual(box.seen(), [], 'the worker is still sleeping')
	assert.equal(box.waitFor(1, 30_000).length, 1, 'the worker outlives the hook')
})

test('a real run takes under 500 ms (best of 3, the machine is loaded)', (t) => {
	const box = hookBox(t)
	let best = Infinity
	for (let i = 0; i < 3; i++) {
		const started = performance.now()
		silent(box.hook(['stop']))
		best = Math.min(best, performance.now() - started)
	}
	withinBudget(t, best, 500, 'a real hook run')
	box.waitFor(3)
})

test('a time budget fails on a quiet machine, and over budget under load is reported rather than judged', (t) => {
	const said = []
	const report = { diagnostic: (line) => said.push(line) }
	assert.throws(() => withinBudget(report, 900, 500, 'a run', { load: 0 }), /a run took 900 ms/)
	withinBudget(report, 100, 500, 'a run', { load: 0 })
	withinBudget(report, 100, 500, 'a run', { load: 99 })
	assert.deepEqual(said, [], 'nothing to say when it is within budget')
	withinBudget(report, 900, 500, 'a run', { load: 99 })
	assert.match(said[0], /a run took 900 ms against 500 ms, not judged at load 99/)
})

// ---- what it loads -------------------------------------------------------------------------------------

/** Every file the hook can load, following static and dynamic relative imports. */
function importGraph(start) {
	const seen = new Set()
	const walk = (file) => {
		if (seen.has(file)) return
		seen.add(file)
		if (file.endsWith('memory-db.mjs')) return // reads only here: its mask loads on loadMask(), which only writers call. memory-note.test.mjs proves that at run time
		const text = readFileSync(file, 'utf8')
		for (const m of text.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*(.+?)\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm)) {
			const spec = (m[1] ?? m[2] ?? m[3]).replace(/^['"]|['"]$/g, '')
			if (spec.startsWith('.')) walk(resolve(dirname(file), spec))
			else if (m[2]) assert.fail(`${file} has a dynamic import that cannot be followed: ${m[2]}`)
		}
	}
	walk(start)
	return [...seen].map((f) => f.slice(CLI_DIR.length + 1))
}

test('the hook loads neither wp-brain.mjs nor bridge.ts', () => {
	const graph = importGraph(HOOK)
	assert.deepEqual(graph.sort(), ['backup-status.mjs', 'budget.mjs', 'claude-files.mjs', 'memory-db.mjs', 'memory-hook.mjs', 'memory-note.mjs'])
	const source = readFileSync(HOOK, 'utf8').replace(/^\s*\/\/.*$/gm, '')
	assert.ok(!/wp-brain\.mjs|bridge\.ts|node:sqlite/.test(source))
})

test('the hook parses on an old Node: no syntax newer than its version check can report', () => {
	const code = readFileSync(HOOK, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
	assert.ok(!/\?\.|\?\?/.test(code), 'no optional chaining or nullish operators')
	assert.ok(!/^(?:const .*=\s*)?await\b/m.test(code), 'no top-level await')
	assert.ok(!/from\s+['"]node:/.test(code), 'no node: imports, which fail at link time on the oldest versions')
})

// ---- too old a Node ------------------------------------------------------------------------------------

test('a Node too old for capture warns at session-start, with capture on only', (t) => {
	const box = hookBox(t)
	const old = { WP_MEMORY_NODE_VERSION: '18.20.0' }
	const r = box.hook(['session-start'], '', old)
	assert.equal(r.status, 0)
	const said = JSON.parse(r.stdout).hookSpecificOutput
	assert.equal(said.hookEventName, 'SessionStart')
	assert.match(said.additionalContext, /^WARNING: session memory has not captured 1 session\(s\) since .* \(Node too old\)/)
	silent(box.hook(['stop'], undefined, old), 'stop')
	silent(box.hook(['session-end'], undefined, old), 'session-end')
	pause(500)
	assert.deepEqual(box.seen(), [], 'no worker on a Node that cannot run it')
	const off = hookBox(t, { repo: 'me/brain' })
	silent(off.hook(['session-start'], '', old), 'off stays silent')
})

test('a real old Node, when this machine has one, reaches the warning', (t) => {
	const versions = join(process.env.NVM_DIR || join(homedir(), '.nvm'), 'versions', 'node')
	const old = existsSync(versions) ? readdirSync(versions).filter((v) => /^v(16|18|20)\./.test(v)).map((v) => join(versions, v, 'bin', 'node')).filter(existsSync) : []
	if (!old.length) return t.skip('no Node older than 22 installed')
	for (const node of [old[0], old.at(-1)]) {
		const box = hookBox(t)
		const r = box.hook(['session-start'], '', {}, node)
		assert.equal(r.status, 0, r.stderr)
		assert.equal(r.stderr, '')
		assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /^WARNING: session memory/, node)
		silent(box.hook(['stop'], undefined, {}, node), node)
		silent(hookBox(t, { repo: 'me/brain' }).hook(['stop'], undefined, {}, node), `${node}, off`)
	}
})

// ---- the plugin's copy ---------------------------------------------------------------------------------

test('--plugin is quiet when settings.json holds its own copy, and runs otherwise', (t) => {
	const box = hookBox(t)
	silent(box.hook(['stop', '--plugin']))
	assert.equal(box.waitFor(1).length, 1, 'no own copy: the plugin runs it')
	const twin = hookBox(t)
	writeFileSync(join(twin.claude, 'settings.json'), JSON.stringify(placeMemoryHooks({}, HOOK)))
	for (const event of EVENTS) silent(twin.hook([event, '--plugin']), event)
	pause(500)
	assert.deepEqual(twin.seen(), [], 'nothing runs twice')
	silent(twin.hook(['stop']))
	assert.equal(twin.waitFor(1).length, 1, 'settings.json’s own copy still runs')
})

test('--plugin does the work when the settings copy points at a moved file, or lacks this event', (t) => {
	const moved = hookBox(t)
	writeFileSync(join(moved.claude, 'settings.json'), JSON.stringify(placeMemoryHooks({}, '/no/such/cli/memory-hook.mjs')))
	silent(moved.hook(['stop', '--plugin']))
	assert.equal(moved.waitFor(1).length, 1, 'a copy that cannot run does not silence the plugin')
	const part = hookBox(t)
	const settings = placeMemoryHooks({}, HOOK)
	delete settings.hooks.SessionEnd
	writeFileSync(join(part.claude, 'settings.json'), JSON.stringify(settings))
	silent(part.hook(['stop', '--plugin']))
	pause(500)
	assert.deepEqual(part.seen(), [], 'its own event is covered')
	silent(part.hook(['session-end', '--plugin']))
	assert.equal(part.waitFor(1).length, 1, 'the missing event is not')
	const broken = hookBox(t)
	writeFileSync(join(broken.claude, 'settings.json'), '{not json')
	silent(broken.hook(['stop', '--plugin']))
	assert.equal(broken.waitFor(1).length, 1, 'unreadable settings: the plugin runs')
})

test('hooks.json runs it on three events, swallowing a missing node, and UserPromptSubmit is unchanged', () => {
	const { hooks } = JSON.parse(readFileSync(join(CLI_DIR, '..', 'hooks', 'hooks.json'), 'utf8'))
	const commands = (event) => hooks[event].flatMap((g) => g.hooks.map((h) => h.command))
	for (const [event, arg] of [['SessionStart', 'session-start'], ['Stop', 'stop'], ['SessionEnd', 'session-end']]) {
		const ours = commands(event).filter((c) => c.includes('memory-hook.mjs'))
		assert.deepEqual(ours, [`node "\${CLAUDE_PLUGIN_ROOT}/cli/memory-hook.mjs" ${arg} --plugin 2>/dev/null || true`], event)
	}
	assert.deepEqual(commands('UserPromptSubmit'), ['node "${CLAUDE_PLUGIN_ROOT}/cli/wp-brain.mjs" recall --plugin 2>/dev/null || true'])
	assert.equal(commands('SessionStart').filter((c) => c.includes('wp-brain.mjs')).length, 1, 'the brief stays')
	assert.equal(commands('Stop').filter((c) => c.includes('wp-brain.mjs')).length, 1, 'the stop check stays')
})

test('settings hooks are quoted, replaced on a re-run, and leave the others alone', () => {
	const other = { type: 'command', command: 'other-stop' }
	const s = placeMemoryHooks({ hooks: { Stop: [{ hooks: [other] }] } }, '/a b/cli/memory-hook.mjs')
	placeMemoryHooks(s, '/c d/cli/memory-hook.mjs')
	const stops = s.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command))
	assert.deepEqual(stops, ['other-stop', 'node "/c d/cli/memory-hook.mjs" stop'])
	assert.equal(s.hooks.SessionStart.flatMap((g) => g.hooks)[0].command, 'node "/c d/cli/memory-hook.mjs" session-start')
	assert.equal(s.hooks.SessionEnd.flatMap((g) => g.hooks)[0].command, 'node "/c d/cli/memory-hook.mjs" session-end')
	assert.equal(settingsRunHook(JSON.stringify(s), 'memory-hook.mjs'), true)
	assert.equal(s.hooks.UserPromptSubmit, undefined)
})

// ---- memory on and off ---------------------------------------------------------------------------------

/** The CLI in a sandbox: temp HOME, CLAUDE_HOME and WP_MEMORY_DB. */
function cliBox(t, config = {}) {
	const home = mkdtempSync(join(tmpdir(), 'wp-memcli-'))
	const claude = join(home, 'claude')
	mkdirSync(claude)
	const db = join(home, 'memory-store', 'memory.db')
	const b = brainSandbox({ config, env: { HOME: home, CLAUDE_HOME: claude, CLAUDE_CONFIG_DIR: claude, WP_MEMORY_DB: db } })
	t.after(() => {
		rmSync(home, { recursive: true, force: true })
		rmSync(b.root, { recursive: true, force: true })
	})
	const settingsPath = join(claude, 'settings.json')
	const read = () => JSON.parse(readFileSync(settingsPath, 'utf8'))
	const cfg = () => JSON.parse(readFileSync(b.configPath, 'utf8'))
	const realHook = (args, input) => {
		const env = { ...process.env, HOME: home, WP_BRAIN_CONFIG: b.configPath, WP_MEMORY_DB: db, WP_BRAIN_SESSIONS: b.sessions, CLAUDE_HOME: claude, CLAUDE_CONFIG_DIR: claude }
		delete env.WP_MEMORY_WORKER
		return spawnSync(process.execPath, [HOOK, ...args], { input, encoding: 'utf8', timeout: 30_000, env })
	}
	return { b, home, claude, db, settingsPath, read, cfg, realHook }
}

const rowsIn = (db) => {
	const open = openMemory(db, { readOnly: true })
	try {
		return open.prepare('SELECT count(*) AS n FROM messages').get().n
	} finally {
		open.close()
	}
}

test('memory on, off, on: the worker fills it through the hook, and rows and the first capture_since stay', (t) => {
	const { b, claude, db, cfg, realHook } = cliBox(t)
	const on = b.run('memory', 'on')
	assert.equal(on.status, 0, on.err)
	const first = cfg()
	assert.equal(first.memory, true)
	assert.ok(Number.isFinite(first.capture_since) && Date.now() - first.capture_since < 120_000)
	assert.equal(first.repo, 'test/brain', 'the rest of brain.json stays')
	assert.equal(statSync(db).mode & 0o777, 0o600)
	assert.equal(first.vault, undefined, 'no vault key without a vault')

	const t1 = transcript({ sessionId: SID })
	const path = writeSession(join(claude, 'projects', '-p', `${SID}.jsonl`), t1.user('a synthetic prompt'), t1.answer('a synthetic answer'))
	assert.equal(realHook(['stop'], JSON.stringify({ session_id: SID, transcript_path: path })).status, 0)
	const end = Date.now() + 30_000
	while (rowsIn(db) < 2 && Date.now() < end) pause(50)
	assert.equal(rowsIn(db), 2, 'the real worker captured it')

	const off = b.run('memory', 'off')
	assert.equal(off.status, 0, off.err)
	assert.equal(off.out.trim().split('\n').length, 1, 'one line')
	assert.match(off.out, /kept|stays/)
	assert.equal(cfg().memory, undefined)
	assert.equal(cfg().capture_since, first.capture_since)
	assert.equal(rowsIn(db), 2)

	assert.equal(b.run('memory', 'on').status, 0)
	assert.equal(cfg().memory, true)
	assert.equal(cfg().capture_since, first.capture_since, 'the first date stays')
	assert.equal(rowsIn(db), 2)
})

test('memory on: settings differ only in hooks, with a backup first, and enabledPlugins untouched', (t) => {
	const { b, settingsPath, read } = cliBox(t)
	const before = { enabledPlugins: { 'claude-mem@x': true, 'other@y': false }, permissions: { allow: ['Read(a)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] }, attribution: { commit: 'x' } }
	const text = `${JSON.stringify(before, null, 2)}\n`
	writeFileSync(settingsPath, text)
	assert.equal(b.run('memory', 'on').status, 0)
	const { hooks: afterHooks, ...afterRest } = read()
	const { hooks: _, ...beforeRest } = before
	assert.deepEqual(afterRest, beforeRest)
	assert.equal(readFileSync(`${settingsPath}.wp-brain.bak`, 'utf8'), text)
	assert.deepEqual(Object.keys(afterHooks).sort(), ['SessionEnd', 'SessionStart', 'Stop'])
	assert.ok(afterHooks.Stop.flatMap((g) => g.hooks).some((h) => h.command === 'mine'))
	const hookPath = join(CLI_DIR, 'memory-hook.mjs')
	assert.ok(afterHooks.Stop.flatMap((g) => g.hooks).some((h) => h.command === `node "${hookPath}" stop`))
	// Turning off leaves settings alone: the installed hooks then do nothing.
	const on = readFileSync(settingsPath, 'utf8')
	assert.equal(b.run('memory', 'off').status, 0)
	assert.equal(readFileSync(settingsPath, 'utf8'), on)
})

test('no code changes enabledPlugins', () => {
	for (const f of ['memory-hook.mjs', 'memory-setup.mjs', 'setup.mjs', 'wp-brain.mjs', 'claude-files.mjs']) {
		const text = readFileSync(join(CLI_DIR, f), 'utf8')
		assert.ok(!/enabledPlugins\s*(\.|\[[^\]]*\])?\s*(=[^=]|\?\?=)|delete\s+[\w.]*enabledPlugins/.test(text), f)
	}
})

/** An installed plugin in a temp CLAUDE_HOME. `withHooks` false is an older version, with no memory hook. */
function fakePlugin(claude, withHooks = true) {
	const install = join(claude, 'plugins', 'cache', 'workpulse-brain')
	mkdirSync(join(install, 'hooks'), { recursive: true })
	mkdirSync(join(install, 'cli'), { recursive: true })
	writeFileSync(join(install, 'cli', 'memory-hook.mjs'), '')
	const group = (arg) => [{ hooks: [{ type: 'command', command: `node "\${CLAUDE_PLUGIN_ROOT}/cli/memory-hook.mjs" ${arg} --plugin 2>/dev/null || true` }] }]
	writeFileSync(join(install, 'hooks', 'hooks.json'), JSON.stringify({ hooks: withHooks ? { SessionStart: group('session-start'), Stop: group('stop'), SessionEnd: group('session-end') } : { Stop: [{ hooks: [{ type: 'command', command: 'other' }] }] } }))
	writeFileSync(join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'workpulse-brain@workpulse': [{ scope: 'user', installPath: install }] } }))
}

test('memory on with the plugin installed still installs the settings copy, changing only hooks', (t) => {
	const { b, claude, settingsPath, read, cfg, db } = cliBox(t)
	fakePlugin(claude, false)
	writeFileSync(settingsPath, '{ "enabledPlugins": { "workpulse-brain@workpulse": true } }\n')
	assert.equal(b.run('memory', 'on').status, 0)
	const { hooks, ...rest } = read()
	assert.deepEqual(rest, { enabledPlugins: { 'workpulse-brain@workpulse': true } })
	assert.deepEqual(Object.keys(hooks).sort(), ['SessionEnd', 'SessionStart', 'Stop'])
	assert.ok(!JSON.stringify(hooks).includes('|| true'), 'the bare command, so a broken node shows')
	assert.equal(cfg().memory, true)
	assert.ok(existsSync(db))
	assert.match(memoryLine(b.run('doctor').out), /^✓ Session memory.*hooks installed/)
})

test('memory on stays off when any part fails: broken settings, no brain.json, a corrupt database', (t) => {
	const broken = cliBox(t)
	writeFileSync(broken.settingsPath, '{not json')
	const r1 = broken.b.run('memory', 'on')
	assert.notEqual(r1.status, 0)
	assert.match(r1.err, /settings\.json/)
	assert.equal(readFileSync(broken.settingsPath, 'utf8'), '{not json')
	assert.equal(broken.cfg().memory, undefined)
	assert.equal(existsSync(broken.db), false)

	const none = cliBox(t)
	rmSync(none.b.configPath)
	const r2 = none.b.run('memory', 'on')
	assert.notEqual(r2.status, 0)
	assert.match(r2.err, /setup/)
	assert.equal(existsSync(none.b.configPath), false)
	assert.equal(existsSync(none.db), false)
	assert.equal(existsSync(none.settingsPath), false)

	const badConfig = cliBox(t)
	writeFileSync(badConfig.b.configPath, '{broken')
	for (const sub of ['on', 'off']) {
		assert.notEqual(badConfig.b.run('memory', sub).status, 0, sub)
		assert.equal(readFileSync(badConfig.b.configPath, 'utf8'), '{broken', `${sub} never overwrites it`)
	}

	const corrupt = cliBox(t)
	mkdirSync(dirname(corrupt.db), { recursive: true })
	const junk = 'this is not a database, and it stays as it is. '.repeat(200)
	writeFileSync(corrupt.db, junk)
	const r3 = corrupt.b.run('memory', 'on')
	assert.notEqual(r3.status, 0)
	assert.equal(readFileSync(corrupt.db, 'utf8'), junk)
	assert.equal(corrupt.cfg().memory, undefined)
	assert.equal(existsSync(corrupt.settingsPath), false, 'no hooks either')
})

test('a bad subcommand says how to use it; help lists the command', (t) => {
	const { b } = cliBox(t)
	const r = b.run('memory', 'sideways')
	assert.notEqual(r.status, 0)
	assert.match(r.err, /memory on/)
	assert.match(b.run('help').out, /wp-brain memory on/)
})

test('setup: --memory yes turns it on with one backup of the first settings, defaults keep it, --memory no keeps the data', (t) => {
	const { b, settingsPath, read, cfg, db } = cliBox(t)
	const args = ['--repo', 'test/brain', '--no-push', '--clone', b.clone]
	const text = '{"permissions":{"allow":["Read(mine)"]}}\n'
	writeFileSync(settingsPath, text)
	const on = b.run('setup', '--defaults', '--memory', 'yes', ...args)
	assert.equal(on.status, 0, on.err)
	assert.equal(cfg().memory, true)
	const since = cfg().capture_since
	assert.ok(Number.isFinite(since))
	assert.ok(existsSync(db))
	assert.ok(JSON.stringify(read()).includes('memory-hook.mjs'))
	assert.equal(readFileSync(`${settingsPath}.wp-brain.bak`, 'utf8'), text, 'the backup is of what was there first')

	const again = b.run('setup', '--defaults', ...args)
	assert.equal(again.status, 0, again.err)
	assert.equal(cfg().memory, true, 'setting up again does not turn it off')
	assert.equal(cfg().capture_since, since)
	assert.ok(JSON.stringify(read()).includes('memory-hook.mjs'))

	const off = b.run('setup', '--defaults', '--memory', 'no', ...args)
	assert.equal(off.status, 0, off.err)
	assert.equal(cfg().memory, undefined)
	assert.equal(cfg().capture_since, since)
	assert.ok(existsSync(db), 'the data stays')

	const offAgain = b.run('setup', '--defaults', ...args)
	assert.equal(offAgain.status, 0, offAgain.err)
	assert.equal(cfg().memory, undefined, 'off stays off')
	assert.equal(cfg().capture_since, since, 'the first date survives a re-run while off')
})

// ---- doctor --------------------------------------------------------------------------------------------

const memoryLine = (out) => out.split('\n').find((l) => l.includes('Session memory')) ?? ''

test('doctor: off is a neutral row, and it creates nothing', (t) => {
	const { b, db } = cliBox(t)
	const line = memoryLine(b.run('doctor').out)
	assert.match(line, /^✓ Session memory\s+off/)
	assert.equal(existsSync(db), false)
})

test('doctor: on reports the last write, the database size and the hooks; missing hooks are a failure', (t) => {
	const { b, db, settingsPath } = cliBox(t)
	assert.equal(b.run('memory', 'on').status, 0)
	const fresh = memoryLine(b.run('doctor').out)
	assert.match(fresh, /^✓ Session memory\s+on since \d{4}-\d{2}-\d{2}/)
	assert.match(fresh, /no write yet/)
	assert.match(fresh, /\d+\.\d MB/)
	assert.match(fresh, /hooks installed/)

	writeFileSync(join(dirname(db), 'status.json'), JSON.stringify({ lastWriteAt: Date.UTC(2026, 9, 31, 8, 30) }))
	assert.match(memoryLine(b.run('doctor').out), /last write 2026-10-31/)

	const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
	settings.hooks.SessionEnd = []
	writeFileSync(settingsPath, JSON.stringify(settings))
	const missing = b.run('doctor')
	assert.match(memoryLine(missing.out), /^✗ Session memory.*no working hook/)
	assert.equal(missing.status, 1)

	settings.hooks = placeMemoryHooks({}, '/no/such/cli/memory-hook.mjs').hooks
	writeFileSync(settingsPath, JSON.stringify(settings))
	assert.match(memoryLine(b.run('doctor').out), /^✗ Session memory.*\/no\/such/, 'a hook pointing at a file that moved')
})

test('doctor: with the plugin: its hooks count only if it has them, and a moved copy is a failure anyway', (t) => {
	const { b, claude, settingsPath, read } = cliBox(t)
	fakePlugin(claude, true)
	assert.equal(b.run('memory', 'on').status, 0)
	const settings = read()
	const installed = settings.hooks

	delete settings.hooks
	writeFileSync(settingsPath, JSON.stringify(settings))
	assert.match(memoryLine(b.run('doctor').out), /^✓ Session memory\s+on .*hooks from the plugin/)

	fakePlugin(claude, false)
	const old = b.run('doctor')
	assert.match(memoryLine(old.out), /^✗ Session memory.*no working hook.*memory on again/, 'an older plugin has no such hook')
	assert.equal(old.status, 1)

	fakePlugin(claude, true)
	settings.hooks = placeMemoryHooks({}, '/no/such/cli/memory-hook.mjs').hooks
	writeFileSync(settingsPath, JSON.stringify(settings))
	const moved = b.run('doctor')
	assert.match(memoryLine(moved.out), /^✗ Session memory.*\/no\/such.*memory on again/, 'checked before the plugin')
	assert.equal(moved.status, 1)

	settings.hooks = installed
	writeFileSync(settingsPath, JSON.stringify(settings))
	assert.equal(b.run('memory', 'off').status, 0)
	assert.match(memoryLine(b.run('doctor').out), /^✓ Session memory\s+off.*\d+\.\d MB/)
})

// ---- what the person is told, and what it does -------------------------------------------------------------

test('consent: with a vault it names the encrypted backups and the repository; without one it says what would change', (t) => {
	const none = cliBox(t)
	const plain = none.b.run('memory', 'on')
	assert.match(plain.out, /stays on this machine; if you turn on the vault, it also goes into its encrypted backups/)
	const vault = cliBox(t, { vault: { repo: 'me/my-vault' } })
	const told = vault.b.run('memory', 'on')
	assert.equal(told.status, 0, told.err)
	assert.match(told.out, /encrypted backups in me\/my-vault/)
	assert.ok(!/machine only/.test(told.out))
	assert.match(vault.b.run('help').out, /encrypted backups/)
	assert.ok(!/on this machine only/.test(readFileSync(join(CLI_DIR, 'setup.mjs'), 'utf8')))
	const viaSetup = cliBox(t, { vault: { repo: 'me/my-vault' } })
	const r = viaSetup.b.run('setup', '--defaults', '--memory', 'yes', '--repo', 'test/brain', '--no-push', '--clone', viaSetup.b.clone)
	assert.equal(r.status, 0, r.err)
	assert.match(r.out, /encrypted backups in me\/my-vault/)
})

test('off means off: a session run while off is not swept after turning on again, and one run after is', (t) => {
	const { b, claude, db, cfg, realHook } = cliBox(t)
	assert.equal(b.run('memory', 'on').status, 0)
	const first = cfg().capture_since
	assert.equal(cfg().capture_resumed_at, undefined, 'the first time is not a resume')
	assert.equal(b.run('memory', 'off').status, 0)
	const during = transcript({ sessionId: 'run-while-off' })
	writeSession(join(claude, 'projects', '-p', 'run-while-off.jsonl'), during.user('said while off'), during.answer('answered while off'))
	assert.equal(realHook(['session-start'], '').status, 0)
	pause(50)
	assert.equal(b.run('memory', 'on').status, 0)
	const resumed = cfg().capture_resumed_at
	assert.ok(resumed >= first)
	assert.equal(cfg().capture_since, first)
	const statusFile = join(dirname(db), 'status.json')
	assert.equal(realHook(['session-start'], '').status, 0)
	const end = Date.now() + 30_000
	while (!existsSync(statusFile) && Date.now() < end) pause(50)
	assert.ok(existsSync(statusFile), 'the sweep ran')
	assert.equal(rowsIn(db), 0, 'nothing from the off period')

	pause(50)
	const later = transcript({ sessionId: 'run-after-on' })
	writeSession(join(claude, 'projects', '-p', 'run-after-on.jsonl'), later.user('said after'), later.answer('answered after'))
	assert.equal(realHook(['session-start'], '').status, 0)
	const end2 = Date.now() + 30_000
	while (rowsIn(db) < 2 && Date.now() < end2) pause(50)
	assert.equal(rowsIn(db), 2)

	const stamp = cfg().capture_resumed_at
	assert.equal(b.run('memory', 'on').status, 0)
	assert.equal(cfg().capture_resumed_at, stamp, 'on while already on is not a resume')
	const r = b.run('setup', '--defaults', '--repo', 'test/brain', '--no-push', '--clone', b.clone)
	assert.equal(r.status, 0, r.err)
	assert.equal(cfg().capture_resumed_at, stamp, 'setting up again keeps it')
})

test('the lower bound is the later of the two dates, and a bad value does not count', () => {
	assert.equal(captureLowerBound({ capture_since: 10 }), 10)
	assert.equal(captureLowerBound({ capture_since: 10, capture_resumed_at: 20 }), 20)
	assert.equal(captureLowerBound({ capture_since: 30, capture_resumed_at: 20 }), 30)
	assert.equal(captureLowerBound({ capture_since: 10, capture_resumed_at: 'x' }), 10)
	assert.equal(captureLowerBound({ capture_resumed_at: 20 }), null)
	assert.equal(captureLowerBound({}), null)
	assert.equal(captureLowerBound(null), null)
})

test('session-start sweeps from the resume date when there is one', (t) => {
	const box = hookBox(t, { memory: true, capture_since: 1234, capture_resumed_at: 5678 })
	silent(box.hook(['session-start'], ''))
	assert.deepEqual(box.waitFor(1), [['--since', '5678']])
})

// ---- smaller points -----------------------------------------------------------------------------------------

test('brain.json that is valid JSON but not an object is refused, before any hook goes in', (t) => {
	for (const raw of ['[]', 'null', '"x"', '5']) {
		const { b, settingsPath, db } = cliBox(t)
		writeFileSync(b.configPath, raw)
		for (const sub of ['on', 'off']) {
			const r = b.run('memory', sub)
			assert.notEqual(r.status, 0, `${raw} ${sub}`)
			assert.match(r.err, /settings object/, raw)
			assert.equal(readFileSync(b.configPath, 'utf8'), raw)
		}
		assert.equal(existsSync(settingsPath), false)
		assert.equal(existsSync(db), false)
	}
})

test('hooks in a shape it cannot merge are refused in words, with nothing changed', (t) => {
	for (const raw of ['{"hooks":{"Stop":{"not":"a list"}}}', '{"hooks":[]}', '[]']) {
		const { b, settingsPath, cfg, db } = cliBox(t)
		writeFileSync(settingsPath, raw)
		const r = b.run('memory', 'on')
		assert.notEqual(r.status, 0, raw)
		assert.match(r.err, /nothing was changed/, raw)
		assert.ok(!/is not a function/.test(r.err), raw)
		assert.equal(readFileSync(settingsPath, 'utf8'), raw)
		assert.equal(cfg().memory, undefined)
		assert.equal(existsSync(db), false)
	}
})

test('the setup summary shows the choice given with --memory', (t) => {
	const { b } = cliBox(t)
	const r = b.run('setup', '--defaults', '--memory', 'yes', '--repo', 'test/brain', '--no-push', '--clone', b.clone)
	assert.equal(r.status, 0, r.err)
	assert.match(r.out, /session memory on \(/)
	assert.ok(!/session memory off/.test(r.out))
})

test('a corrupt database while on: the words fit, it stays on, and setup still finishes', (t) => {
	const { b, db, cfg, settingsPath } = cliBox(t)
	assert.equal(b.run('memory', 'on').status, 0)
	const since = cfg().capture_since
	for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true })
	const junk = 'this is not a database, and it stays as it is. '.repeat(200)
	writeFileSync(db, junk)
	const on = b.run('memory', 'on')
	assert.notEqual(on.status, 0)
	assert.match(on.err, /left as it is/)
	assert.ok(!/stays off/.test(on.err), 'it was on, so it does not stay off')
	const r = b.run('setup', '--defaults', '--repo', 'test/brain', '--no-push', '--clone', b.clone)
	assert.equal(r.status, 0, r.err)
	assert.match(r.out, /left as it is/)
	assert.match(r.out, /Claude Code is linked/, 'the rest of setup ran')
	assert.equal(cfg().memory, true)
	assert.equal(cfg().capture_since, since)
	assert.equal(readFileSync(db, 'utf8'), junk)
	assert.ok(existsSync(settingsPath))
})

test('a corrupt database at a first setup --memory yes: stays off and installs no hooks, and setup still finishes', (t) => {
	const { b, db, cfg, read } = cliBox(t)
	mkdirSync(dirname(db), { recursive: true })
	writeFileSync(db, 'not a database. '.repeat(500))
	const r = b.run('setup', '--defaults', '--memory', 'yes', '--repo', 'test/brain', '--no-push', '--clone', b.clone)
	assert.equal(r.status, 0, r.err)
	assert.equal(cfg().memory, undefined)
	assert.ok(!JSON.stringify(read()).includes('memory-hook.mjs'))
})

test('a linked brain.json stays a link when the flag changes', (t) => {
	const { b, home } = cliBox(t)
	const real = join(home, 'dotfiles-brain.json')
	writeFileSync(real, readFileSync(b.configPath))
	rmSync(b.configPath)
	symlinkSync(real, b.configPath)
	assert.equal(b.run('memory', 'on').status, 0)
	assert.ok(lstatSync(b.configPath).isSymbolicLink())
	assert.equal(JSON.parse(readFileSync(real, 'utf8')).memory, true)
	assert.equal(b.run('memory', 'off').status, 0)
	assert.ok(lstatSync(b.configPath).isSymbolicLink())
	assert.equal(JSON.parse(readFileSync(real, 'utf8')).memory, undefined)
})

// ---- the summary ask -------------------------------------------------------------------------------------

/** The hook's stop, with a mark as the worker would leave it. Tracks modules loaded in the hook's process. */
function stopBox(t, mark = { prompts: 3, edits: 0, commits: 1, entrypoint: 'cli' }) {
	const box = hookBox(t)
	const sessions = box.env.WP_BRAIN_SESSIONS
	mkdirSync(sessions, { recursive: true })
	const setMark = (m) => writeFileSync(join(sessions, `${SID}.memory.json`), JSON.stringify(m))
	setMark(mark)
	const askPath = join(sessions, `${SID}.memory-ask.json`)
	const loaded = join(box.root, 'loaded.txt')
	const tracer = join(box.root, 'tracer.mjs')
	writeFileSync(tracer, `import { registerHooks } from 'node:module'
import { appendFileSync } from 'node:fs'
registerHooks({ resolve(spec, context, next) { appendFileSync(${JSON.stringify(loaded)}, spec + '\\n'); return next(spec, context) } })
`)
	const stop = (input = {}) => box.hook(['stop'], JSON.stringify({ session_id: SID, transcript_path: join(box.claude, 'projects', '-p', `${SID}.jsonl`), ...input }), { NODE_OPTIONS: `--import=${tracer}` })
	const reason = (r) => {
		assert.equal(r.status, 0, r.stderr)
		assert.equal(r.stderr, '')
		if (r.stdout === '') return null
		const out = JSON.parse(r.stdout)
		assert.equal(out.decision, 'block')
		return out.reason
	}
	return { box, setMark, askPath, loaded, stop, reason, sessions }
}

test('stop: asks once at the threshold in the documented shape, and the ask is held in its own file', (t) => {
	const s = stopBox(t)
	const first = s.reason(s.stop())
	assert.match(first, new RegExp(`^Before stopping, save this session's memory: node \\S*wp-brain\\.mjs memory summary --session ${SID} `))
	assert.deepEqual(JSON.parse(readFileSync(s.askPath, 'utf8')), { count: 1, prompts: 3, commits: 1 })
	assert.deepEqual(JSON.parse(readFileSync(join(s.sessions, `${SID}.memory.json`), 'utf8')), { prompts: 3, edits: 0, commits: 1, entrypoint: 'cli' }, 'the worker\'s file is left alone')
	assert.equal(s.reason(s.stop()), null, 'nothing new: no second ask')
})

test('stop: the second ask comes after a new commit, and there is never a third', (t) => {
	const s = stopBox(t)
	assert.ok(s.reason(s.stop()))
	s.setMark({ prompts: 4, edits: 0, commits: 2, entrypoint: 'cli' })
	assert.ok(s.reason(s.stop()))
	s.setMark({ prompts: 99, edits: 99, commits: 99, entrypoint: 'cli' })
	assert.equal(s.reason(s.stop()), null)
	assert.equal(JSON.parse(readFileSync(s.askPath, 'utf8')).count, 2)
})

test('stop: no ask with stop_hook_active, for an sdk session, or below the threshold; capture still starts', (t) => {
	const s = stopBox(t)
	assert.equal(s.reason(s.stop({ stop_hook_active: true })), null)
	assert.equal(existsSync(s.askPath), false, 'not counted as asked')
	s.setMark({ prompts: 3, edits: 0, commits: 1, entrypoint: 'sdk-ts' })
	assert.equal(s.reason(s.stop()), null)
	s.setMark({ prompts: 2, edits: 0, commits: 1, entrypoint: 'cli' })
	assert.equal(s.reason(s.stop()), null)
	assert.equal(s.box.waitFor(3).length, 3)
})

test('stop: never opens the database or loads the mask, with an ask pending or not', (t) => {
	const s = stopBox(t)
	assert.ok(s.reason(s.stop()))
	assert.equal(s.reason(s.stop()), null)
	const loaded = readFileSync(s.loaded, 'utf8').split('\n')
	assert.ok(loaded.some((m) => m.includes('memory-note.mjs')), 'the tracer works')
	for (const heavy of ['node:sqlite', 'memory-db.mjs', 'memory-mask.mjs', 'bridge.ts', 'wp-brain.mjs']) assert.equal(loaded.filter((m) => m.includes(heavy)).length, 0, heavy)
})

test('stop: an ask that can\'t be recorded is not made, so it can\'t repeat every turn', (t) => {
	const s = stopBox(t)
	mkdirSync(s.askPath)
	assert.equal(s.reason(s.stop()), null)
})

test('stop: no mark, a broken mark, or an unusable id: no ask and no output', (t) => {
	const s = stopBox(t)
	writeFileSync(join(s.sessions, `${SID}.memory.json`), '{broken')
	assert.equal(s.reason(s.stop()), null)
	rmSync(join(s.sessions, `${SID}.memory.json`))
	assert.equal(s.reason(s.stop()), null)
	assert.equal(existsSync(s.askPath), false)
	for (const session_id of ['a b', '../x', '']) {
		mkdirSync(s.sessions, { recursive: true })
		writeFileSync(join(s.sessions, `${session_id}.memory.json`), JSON.stringify({ prompts: 3, edits: 0, commits: 1, entrypoint: 'cli' }))
		assert.equal(s.reason(s.stop({ session_id })), null, session_id)
		assert.equal(existsSync(join(s.sessions, `${session_id}.memory-ask.json`)), false, session_id)
	}
})

test('stop: an ask file that is present but not a good record means no ask, and it is left as it is', (t) => {
	for (const held of ['{bro', '', 'null', '[]', '5', '{"count":"2"}', '{"count":1.5}', '{"count":-5}', '{}']) {
		const s = stopBox(t)
		writeFileSync(s.askPath, held)
		assert.equal(s.reason(s.stop()), null, held)
		assert.equal(s.reason(s.stop()), null, held)
		assert.equal(readFileSync(s.askPath, 'utf8'), held)
	}
})

test('stop: with a sessions folder it cannot write to there is no ask and no stray file', (t) => {
	const s = stopBox(t)
	const before = readdirSync(s.sessions).sort()
	chmodSync(s.sessions, 0o555)
	try {
		assert.equal(s.reason(s.stop()), null)
	} finally {
		chmodSync(s.sessions, 0o755)
	}
	assert.deepEqual(readdirSync(s.sessions).sort(), before)
})

test('stop: capture off asks nothing, even with a mark in place', (t) => {
	const box = hookBox(t, { repo: 'me/brain' })
	mkdirSync(box.env.WP_BRAIN_SESSIONS, { recursive: true })
	writeFileSync(join(box.env.WP_BRAIN_SESSIONS, `${SID}.memory.json`), JSON.stringify({ prompts: 9, edits: 9, commits: 9, entrypoint: 'cli' }))
	silent(box.hook(['stop']), 'off')
})


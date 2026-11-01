import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { withinBudget } from './sandbox.mjs'

test('brainSandbox: its temp folder is gone when the process ends', (t) => {
	const home = mkdtempSync(join(tmpdir(), 'wp-sandbox-exit-'))
	t.after(() => rmSync(home, { recursive: true, force: true }))
	const script = "import { brainSandbox } from './cli/sandbox.mjs'; console.log(brainSandbox().root)"
	const r = spawnSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8', cwd: join(import.meta.dirname, '..'), env: { ...process.env, TMPDIR: home } })
	assert.equal(r.status, 0, r.stderr)
	assert.ok(r.stdout.trim().startsWith(home), 'the sandbox was made in the temp folder given')
	assert.deepEqual(readdirSync(home), [])
})

test('brainSandbox: a cleanup that fails does not change the exit code', (t) => {
	const home = mkdtempSync(join(tmpdir(), 'wp-sandbox-exit-'))
	t.after(() => {
		for (const name of readdirSync(home)) chmodSync(join(home, name), 0o755)
		rmSync(home, { recursive: true, force: true })
	})
	const script = "import { chmodSync } from 'node:fs'; import { brainSandbox } from './cli/sandbox.mjs'; chmodSync(brainSandbox().root, 0o500)"
	const r = spawnSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8', cwd: join(import.meta.dirname, '..'), env: { ...process.env, TMPDIR: home } })
	assert.equal(readdirSync(home).length, 1, 'the folder stayed, so the cleanup did fail')
	assert.equal(r.status, 0, r.stderr)
})

test('run-tests: runs what it is given in a private temp folder, removes it, keeps the exit code', (t) => {
	const dir = mkdtempSync(join(tmpdir(), 'wp-run-tests-'))
	t.after(() => rmSync(dir, { recursive: true, force: true }))
	const record = join(dir, 'tmp-used')
	const passing = join(dir, 'ok.test.mjs')
	writeFileSync(passing, `import { tmpdir } from 'node:os'; import { writeFileSync, mkdtempSync } from 'node:fs'; import { join } from 'node:path'; mkdtempSync(join(tmpdir(), 'leak-')); writeFileSync(${JSON.stringify(record)}, tmpdir())`)
	const failing = join(dir, 'bad.test.mjs')
	writeFileSync(failing, "throw new Error('red')")
	const runner = join(import.meta.dirname, 'run-tests.mjs')
	// Inherited from this test's own runner, it would stop the nested one running anything.
	const { NODE_TEST_CONTEXT, ...env } = process.env
	const ok = spawnSync('node', [runner, passing], { encoding: 'utf8', env })
	assert.equal(ok.status, 0, ok.stderr)
	const used = readFileSync(record, 'utf8')
	assert.match(used, /wp-test-run-/)
	assert.equal(existsSync(used), false, 'the private temp folder is gone, leak and all')
	assert.notEqual(spawnSync('node', [runner, failing], { encoding: 'utf8', env }).status, 0)
})

const fakeT = () => {
	const notes = []
	return { notes, diagnostic: (line) => notes.push(line) }
}

test('withinBudget: under budget says nothing, over budget on a quiet machine fails', () => {
	const t = fakeT()
	withinBudget(t, 50, 100, 'x', { load: 0 })
	assert.deepEqual(t.notes, [])
	assert.throws(() => withinBudget(t, 150, 100, 'x', { load: 0 }), /x took 150 ms against 100 ms/)
})

test('withinBudget: load excuses a small overrun, not one five times the budget', () => {
	const t = fakeT()
	withinBudget(t, 300, 100, 'x', { load: 1e6 })
	assert.match(t.notes[0], /not judged at load/)
	assert.throws(() => withinBudget(t, 500, 100, 'x', { load: 1e6 }), /x took 500 ms against 100 ms/)
})

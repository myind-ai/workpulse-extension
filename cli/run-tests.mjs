// Runs the CLI's tests in one private temp folder and removes it afterwards, so a test that forgets to clean up costs nothing.
// `node cli/run-tests.mjs` for all of them, or name the test files. The exit code is the tests' own.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const here = import.meta.dirname
const files = process.argv.slice(2)
const chosen = files.length ? files : readdirSync(here).filter((f) => f.endsWith('.test.mjs')).map((f) => join(here, f))
const scratch = mkdtempSync(join(tmpdir(), 'wp-test-run-'))
try {
	const r = spawnSync('node', ['--test', ...chosen], { stdio: 'inherit', env: { ...process.env, TMPDIR: scratch } })
	process.exitCode = r.status ?? 1
} finally {
	rmSync(scratch, { recursive: true, force: true })
}

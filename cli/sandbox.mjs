// A sandbox for the CLI's tests: a bare "remote", a clone of it, a temp config and a temp database. Never touches the real Brain.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CLI = join(dirname(fileURLToPath(import.meta.url)), 'wp-brain.mjs')

/**
 * A time budget a test can hold to. Over budget on a machine with more than half its cores busy, the number says nothing about the code, and a suite
 * that goes red under ordinary load teaches ignoring it: so that case is reported, not judged. The budget itself stays as it is, and a real slowdown
 * still fails on a quiet run. Load excuses up to five times the budget, not more. Use best-of-N first, as one slow run proves nothing either.
 */
export function withinBudget(t, ms, budget, what, { load = loadavg()[0] } = {}) {
	if (ms < budget) return
	const shown = `${what} took ${Math.round(ms)} ms against ${budget} ms`
	if (load > cpus().length / 2 && ms < budget * 5) t.diagnostic(`${shown}, not judged at load ${load}`)
	else assert.fail(shown)
}

/** A bare "remote", a clone of it, a config pointing at the clone, and a `run` for the CLI. `runWith` adds to the environment for one call. */
export function brainSandbox({ config = {}, env = {} } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'wp-brain-test-'))
	// Each test file is its own process: without this, every run left about 450 of these behind (35 GB of temp folders by 2026-11-01).
	// Best effort: a background sync can still be writing here (ENOTEMPTY), and a throw at exit would fail a test file whose tests all passed.
	process.on('exit', () => {
		try {
			rmSync(root, { recursive: true, force: true, maxRetries: 2 })
		} catch {}
	})
	const remote = join(root, 'remote.git')
	const clone = join(root, 'clone')
	const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
	git('init', '-q', '--bare', '-b', 'main', remote)
	git('clone', '-q', remote, clone)
	git('-C', clone, 'config', 'user.email', 'test@example.com')
	git('-C', clone, 'config', 'user.name', 'Test')
	writeFileSync(join(clone, 'README.md'), 'test\n')
	git('-C', clone, 'add', 'README.md')
	git('-C', clone, 'commit', '-q', '-m', 'init')
	git('-C', clone, 'push', '-q', 'origin', 'HEAD:main')
	git('-C', clone, 'branch', '--set-upstream-to=origin/main', 'main')
	const configPath = join(root, 'brain.json')
	writeFileSync(configPath, JSON.stringify({ repo: 'test/brain', clone, device: 'cli-test', ...config }))
	const sessions = join(root, 'sessions')
	mkdirSync(sessions)
	const dbFile = join(root, 'brain.db')
	const runWith = (more, ...args) => {
		const { input, ...extra } = more
		const r = spawnSync('node', [CLI, ...args], {
			encoding: 'utf8',
			input,
			env: { ...process.env, WP_BRAIN_REPO_VISIBILITY: 'private', WP_BRAIN_CONFIG: configPath, WP_BRAIN_SESSIONS: sessions, WP_BRAIN_DB: dbFile, CLAUDE_HOME: join(root, 'claude-home'), WP_BRAIN_RULE_INDEX: join(root, 'rule-index.json'), WP_SESSIONS_MD: join(root, 'sessions-md'), WP_SESSIONS_PACK: join(root, 'session-files.db'), WP_BACKUP_STATUS: join(root, 'backup-status.json'), WP_LAUNCH_AGENTS_DIR: join(root, 'launch-agents'), WP_LAUNCHCTL: join(root, 'no-launchctl'), WP_ICLOUD_DESKTOP: '0', ...env, ...extra },
		})
		return { status: r.status, out: r.stdout, err: r.stderr }
	}
	const run = (...args) => runWith({}, ...args)
	return { root, remote, clone, configPath, sessions, dbFile, run, runWith, git }
}

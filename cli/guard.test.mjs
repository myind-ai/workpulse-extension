// node --test cli/guard.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { claudeFixture } from './fixtures.mjs'
import { ATTRIBUTION, commandsIn, decide, normalise } from './guard.mjs'

const GUARD = new URL('./guard.mjs', import.meta.url).pathname
// Bare spawns never read the real ~/.claude or write the real session marks.
const PINNED = { ...process.env, CLAUDE_HOME: join(tmpdir(), 'guard-test-no-claude'), WP_BRAIN_SESSIONS: join(tmpdir(), 'guard-test-no-sessions') }
// Built from pieces so this file never holds a literal trailer.
const TRAILER = 'Co-Authored-By: ' + 'Claude Sonnet <noreply@' + 'anthropic.com>'
const GENERATED = '🤖 Generated with [' + 'Claude Code](https://claude.com/claude-code)'

const bash = (command, cwd = tmpdir()) => decide({ tool_name: 'Bash', tool_input: { command }, cwd })
const kind = (command, cwd) => bash(command, cwd)?.decision ?? null

function git(cwd, ...args) {
	return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
		cwd,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim()
}
function repo() {
	const dir = mkdtempSync(join(tmpdir(), 'guard-repo-'))
	git(dir, 'init', '-q', '-b', 'main')
	writeFileSync(join(dir, 'a.txt'), 'a')
	git(dir, 'add', 'a.txt')
	git(dir, 'commit', '-q', '-m', 'init')
	return dir
}
function commitWith(dir, message, file = 'b.txt') {
	writeFileSync(join(dir, file), message)
	const msg = join(dir, '..', `msg-${Math.random().toString(36).slice(2)}.txt`)
	writeFileSync(msg, message + '\n')
	git(dir, 'add', file)
	git(dir, 'commit', '-q', '-F', msg)
	return git(dir, 'rev-parse', '--short=7', 'HEAD')
}
function withRemote() {
	const dir = repo()
	const bare = mkdtempSync(join(tmpdir(), 'guard-bare-'))
	git(bare, 'init', '-q', '--bare')
	git(dir, 'remote', 'add', 'origin', bare)
	return dir
}

test('commandsIn splits, unquotes and enters substitutions', () => {
	assert.deepEqual(commandsIn('a b && c "d e"; f | g'), [['a', 'b'], ['c', 'd e'], ['f'], ['g']])
	assert.deepEqual(commandsIn("echo 'git push' x"), [['echo', 'git push', 'x']])
	assert.deepEqual(commandsIn('echo $(git push)').map((a) => a[0]).sort(), ['echo', 'git'])
	assert.deepEqual(commandsIn('x `git push`').map((a) => a[0]).sort(), ['git', 'x'])
	assert.deepEqual(commandsIn("bash -c 'git push -u'").find((a) => a[0] === 'git'), ['git', 'push', '-u'])
	assert.deepEqual(commandsIn('cat <<EOF\ngit push\nEOF\nls'), [['cat'], ['ls']])
	assert.deepEqual(commandsIn('a 2>&1 && b'), [['a'], ['b']])
})

test('normalise strips assignments, wrappers, paths and git globals', () => {
	assert.deepEqual(normalise(['FOO=1', 'git', 'push']), ['git', 'push'])
	assert.deepEqual(normalise(['/usr/bin/git', 'push']), ['git', 'push'])
	assert.deepEqual(normalise(['timeout', '-s', 'KILL', '30', 'git', 'push']), ['git', 'push'])
	assert.deepEqual(normalise(['nice', '-n', '5', 'nohup', 'git', 'push']), ['git', 'push'])
	assert.deepEqual(normalise(['env', '-u', 'X', 'A=1', 'rtk', 'git', 'push']), ['git', 'push'])
	assert.deepEqual(normalise(['stdbuf', '-oL', 'time', 'command', 'git', 'push']), ['git', 'push'])
	assert.deepEqual(normalise(['git', '-C', 'y', '-c', 'k=v', '--no-pager', 'push', 'o']), ['git', 'push', 'o'])
})

test('ATTRIBUTION matches shapes, not the word', () => {
	assert.ok(ATTRIBUTION.test(TRAILER))
	assert.ok(ATTRIBUTION.test('co-authored-by: Someone <x@anthropic.com>'.replace('x@anthropic.com', 'noreply@' + 'anthropic.com')))
	assert.ok(ATTRIBUTION.test(GENERATED))
	assert.ok(!ATTRIBUTION.test('feat: sync Claude logs from timesheet'))
	assert.ok(!ATTRIBUTION.test('Co-Authored-By: Pat <pat@example.com>'))
})

for (const command of [
	'git push',
	'git push -u origin x',
	'rtk git push',
	'cd x && git -C y push',
	'FOO=1 git push',
	'/usr/bin/git push',
	'timeout 30 git push',
	"bash -c 'git push'",
	'echo $(git push)',
	'git commit -m "$(cat <<\'EOF\'\nfix: don\'t crash\nEOF\n)" && git push',
	'git commit -m "$(cat <<\'EOF\'\nsay "hi\nEOF\n)" && git push',
	'if true; then git push; fi',
	'for b in a; do git push; done',
	'while x; do git push origin main; done',
	'{ git push; }',
	'! git push',
	'if git push; then :; fi',
	'exec git push',
	'git --no-optional-locks push',
	'git --git-dir .git push',
	'git push>/dev/null',
	'git push 2>&1',
]) {
	test(`ask: ${command}`, () => {
		const d = bash(command, tmpdir())
		assert.equal(d?.decision, 'ask')
		assert.match(d.reason, /push/i)
	})
}

for (const command of [
	'git commit -m "docs: how git push works"',
	'git log --grep="git push"',
	'echo "git push"',
	'git commit -F - <<EOF\ndocs: x\ngit push\nEOF',
	'git status',
	'node cli/wp-brain.mjs add learning "x"',
	'git commit -m "feat: sync Claude logs from timesheet"',
	'echo "' + TRAILER + '"',
]) {
	test(`null: ${command.split('\n')[0]}`, () => {
		assert.equal(bash(command), null)
	})
}

// Options before the subcommand used to hide it from the guard (task 6b).
for (const command of [
	'vercel --target production',
	'vercel ./app',
	'rtk vercel --target production',
	'cd x && vercel ./app',
	'npm --prefix x publish',
	'rtk npm --prefix x publish',
	'cd x && pnpm --filter y publish',
	'gh -R o/r pr merge 3',
	'rtk gh -R o/r pr merge 3',
	'cd x && gh --repo o/r pr merge 3',
	'gh -R o/r pr create --title t',
	'asc --report-file x builds upload',
	'rtk asc --report-file x builds upload',
	'cd x && asc --report-file x builds upload',
	'case x in a) git push;; esac',
]) {
	test(`ask (options first): ${command}`, () => {
		assert.equal(bash(command)?.decision, 'ask')
	})
}

for (const command of [
	'vercel env ls',
	'vercel ls',
	'vercel --scope team env ls',
	'vercel logs x',
	'vercel whoami',
	'vercel link --yes',
	'supabase db diff',
	'git reset --soft HEAD~1',
	'npm --prefix x install',
	'npm run build',
	'gh -R o/r pr view 3',
	'gh -R o/r pr list',
	'asc --report-file x builds list',
	'sudo ls',
	'xargs rm',
	'eval "$(ssh-agent -s)"',
	'echo "it\'s done',
	'$HOME/bin/tool run',
]) {
	test(`null (quiet): ${command}`, () => {
		assert.equal(bash(command), null)
	})
}

// A command the guard cannot read, naming a gated word, asks rather than allows.
for (const command of [
	'G=git; $G push',
	'$G push',
	'eval "$x"; git status',
	'x=push; eval "git $x"',
	'sudo git push',
	'xargs git push',
	'nice -n5 git push',
	'env -C d git push',
	'git commit -m "it\'s',
	'echo "unclosed; git push',
	"git push 'origin",
]) {
	test(`ask (cannot read): ${command}`, () => {
		const d = bash(command)
		assert.equal(d?.decision, 'ask')
	})
}

// Review round: substitutions, env -S, other tools, runners, wrappers.
for (const command of [
	'$(which git) push',
	'`which git` push',
	'$(which vercel) --prod',
	'$(which gh) pr merge 3',
	'git $(echo push)',
	'git `echo push`',
	'$G clean -fd',
	'$G checkout -f',
	'$G branch -f x',
	'$G commit -am x',
	'$V --prod',
	'env -S "git push"',
	'env -S"git push"',
	'env --split-string="git push"',
	'env -C d -S "git push"',
	'firebase --token t deploy',
	'firebase --account a deploy',
	'supabase --agent no functions deploy f',
	'supabase --foo x db push',
	'npx vercel --prod',
	'npx -y supabase db push',
	'pnpm exec vercel --prod',
	'pnpm dlx vercel --prod',
	'yarn vercel --prod',
	'bunx vercel',
	'yarn publish',
	'bun publish',
	'sudo git push',
	'sudo -u me git push',
	'doas git push',
	'xargs git push',
	'xargs -n1 git push',
	'watch git push',
	'rtk sudo git push',
]) {
	test(`ask (review): ${command}`, () => {
		assert.equal(bash(command)?.decision, 'ask')
	})
}

for (const command of [
	'x=$(git rev-parse HEAD)',
	'eval "$(ssh-agent -s)" && git status',
	'git log $(git rev-parse HEAD)',
	'cd "$(git rev-parse --show-toplevel)" && ls',
	'sudo git status',
	'sudo git log',
	'sudo apt install git',
	'find . | xargs grep push',
	'find . | xargs grep -l create',
	'sudo vercel ls',
	'watch git status',
	'$PYTHON -m pytest && git diff',
	'yarn install',
	'npx prettier --write .',
	'firebase --token t emulators:start',
	'supabase --agent no db diff',
]) {
	test(`null (review): ${command}`, () => {
		assert.equal(bash(command), null)
	})
}

test('cannot-read reason says so', () => {
	assert.match(bash('$G push').reason, /could ?n.t read/i)
	assert.match(bash('eval "$x"; git status').reason, /could ?n.t read/i)
})

test('internal-error fallback asks for a gated word and stays quiet otherwise', () => {
	const run = (command) => spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: 5 }), encoding: 'utf8', env: PINNED })
	const r = run('cd x && asc builds list')
	assert.equal(r.status, 0)
	const out = JSON.parse(r.stdout).hookSpecificOutput
	assert.equal(out.permissionDecision, 'ask')
	assert.match(out.permissionDecisionReason, /internal error/)
	assert.equal(run('cd x && ls').stdout, '')
})

test('deny: trailer in -m, -F file, heredoc, gh pr create/edit', () => {
	assert.equal(kind(`git commit -m "feat: x\n\n${TRAILER}"`), 'deny')
	assert.equal(kind(`git commit -am "feat: x" -m "${TRAILER}"`), 'deny')
	assert.equal(kind(`git commit --message="${GENERATED}"`), 'deny')
	const dir = mkdtempSync(join(tmpdir(), 'guard-msg-'))
	writeFileSync(join(dir, 'msg.txt'), `fix: y\n\n${TRAILER}\n`)
	assert.equal(kind('git commit -F msg.txt', dir), 'deny')
	assert.equal(kind(`git commit -F ${join(dir, 'msg.txt')}`), 'deny')
	assert.equal(kind(`git commit -F - <<'EOF'\nfix: y\n\n${TRAILER}\nEOF`), 'deny')
	assert.equal(kind(`git commit -m "$(cat <<'EOF'\nfix: y\n\n${TRAILER}\nEOF\n)"`), 'deny')
	assert.equal(kind(`gh pr create --title t --body "x\n${GENERATED}"`), 'deny')
	assert.equal(kind(`gh pr create --body "$(cat <<'EOF'\nx\n${GENERATED}\nEOF\n)"`), 'deny')
	assert.equal(kind('gh pr edit 3 --body-file b.md', (() => { const d = mkdtempSync(join(tmpdir(), 'guard-pr-')); writeFileSync(join(d, 'b.md'), GENERATED); return d })()), 'deny')
	assert.match(bash(`git commit -m "${TRAILER}"`).reason, /trailer|attribution/i)
})

test('null: clean commit and clean PR edit; a clean PR create now asks', () => {
	assert.equal(bash('git commit -m "feat: ok"'), null)
	assert.equal(bash('gh pr edit 3 --body "all good"'), null)
	assert.equal(kind('gh pr create --title t --body "all good"'), 'ask')
})

test('push scan: unpushed trailer is denied with the short SHA', () => {
	const dir = withRemote()
	const sha = commitWith(dir, `feat: b\n\n${TRAILER}`)
	const d = bash('git push -u origin main', dir)
	assert.equal(d.decision, 'deny')
	assert.ok(d.reason.includes(sha), d.reason)
})

test('push scan: clean range asks; already-pushed trailer is ignored', () => {
	const dir = withRemote()
	commitWith(dir, `feat: old\n\n${TRAILER}`)
	git(dir, 'push', '-q', '-u', 'origin', 'main')
	commitWith(dir, 'feat: clean', 'c.txt')
	assert.equal(kind('git push', dir), 'ask')
})

test('push scan: no upstream scans HEAD --not --remotes', () => {
	const dir = withRemote()
	assert.equal(kind('git push origin main', dir), 'ask')
	commitWith(dir, `feat: t\n\n${TRAILER}`)
	assert.equal(kind('git push origin main', dir), 'deny')
})

test('push scan: a branch named on the command line is scanned', () => {
	const dir = withRemote()
	git(dir, 'switch', '-q', '-c', 'other')
	const sha = commitWith(dir, `feat: o\n\n${TRAILER}`)
	git(dir, 'switch', '-q', 'main')
	const d = bash('git push origin other', dir)
	assert.equal(d.decision, 'deny')
	assert.ok(d.reason.includes(sha))
	assert.equal(kind('git push origin HEAD:refs/heads/z', dir), 'ask')
})

test('push scan: git failing still asks and says it could not scan', () => {
	const notRepo = mkdtempSync(join(tmpdir(), 'guard-none-'))
	const d = bash('git push', notRepo)
	assert.equal(d.decision, 'ask')
	assert.match(d.reason, /could not scan/i)
})

test('a non-git command spawns no process', () => {
	// Under --permission without --allow-child-process, any spawn throws, so a clean exit proves none happened.
	const code = `import('${new URL('./guard.mjs', import.meta.url).href}').then(({ decide }) => {
		for (const command of ['ls -la && echo hi', 'node x.mjs add learning "y"', 'echo "git push"'])
			if (decide({ tool_name: 'Bash', tool_input: { command }, cwd: '/' }) !== null) process.exit(3)
		if (decide({ tool_name: 'Read', tool_input: {}, cwd: '/' }) !== null) process.exit(4)
	})`
	const r = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', '-e', code], { encoding: 'utf8' })
	assert.equal(r.status, 0, r.stderr)
})

function runScript(input) {
	return spawnSync(process.execPath, [GUARD], { input, encoding: 'utf8' })
}

test('script: prints hookSpecificOutput for a push, nothing otherwise', () => {
	const out = runScript(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push' }, cwd: tmpdir() }))
	assert.equal(out.status, 0)
	const j = JSON.parse(out.stdout).hookSpecificOutput
	assert.equal(j.hookEventName, 'PreToolUse')
	assert.equal(j.permissionDecision, 'ask')
	assert.ok(j.permissionDecisionReason)
	const none = runScript(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: tmpdir() }))
	assert.equal(none.status, 0)
	assert.equal(none.stdout, '')
})

test('script: bad JSON exits 0 with no output; importing prints nothing', () => {
	for (const input of ['', 'not json', '[1']) {
		const out = runScript(input)
		assert.equal(out.status, 0)
		assert.equal(out.stdout, '')
	}
})

test('commandsIn: redirections are not words; words end at > and <', () => {
	assert.deepEqual(commandsIn('git push>/dev/null'), [['git', 'push']])
	assert.deepEqual(commandsIn('git push origin main > /tmp/l 2>&1'), [['git', 'push', 'origin', 'main']])
	assert.deepEqual(commandsIn('a &> f && b'), [['a'], ['b']])
	assert.deepEqual(commandsIn('cd d && ls').map((a) => a[0]), ['cd', 'ls'])
})

test('push scan: history already on the remote via a merge is not denied', () => {
	const dir = withRemote()
	commitWith(dir, `feat: old\n\n${TRAILER}`)
	git(dir, 'push', '-q', '-u', 'origin', 'main')
	git(dir, 'switch', '-q', '-c', 'feature')
	commitWith(dir, 'feat: f', 'f.txt')
	git(dir, 'push', '-q', '-u', 'origin', 'feature')
	git(dir, 'switch', '-q', 'main')
	commitWith(dir, `feat: m\n\n${TRAILER}`, 'm.txt')
	git(dir, 'push', '-q', 'origin', 'main')
	git(dir, 'switch', '-q', 'feature')
	git(dir, 'merge', '-q', '--no-edit', 'origin/main')
	assert.equal(kind('git push', dir), 'ask')
})

test('push scan: redirections and option values are not refspecs', () => {
	const dir = withRemote()
	commitWith(dir, `feat: t\n\n${TRAILER}`)
	for (const c of ['git push origin main 2>&1', 'git push origin main > /tmp/l', 'git push -o ci.skip origin main', 'git push --push-option=x origin main'])
		assert.equal(kind(c, dir), 'deny', c)
})

test('push scan: one bad ref does not discard the others', () => {
	const dir = withRemote()
	commitWith(dir, `feat: t\n\n${TRAILER}`)
	assert.equal(kind('git push origin nosuchbranch main', dir), 'deny')
})

test('cd and git -C change the repo that is scanned and the folder files resolve against', () => {
	const dirty = withRemote()
	commitWith(dirty, `feat: t\n\n${TRAILER}`)
	const clean = withRemote()
	assert.equal(kind(`cd ${clean} && git push`, dirty), 'ask')
	assert.equal(kind(`cd ${dirty} && git push`, clean), 'deny')
	assert.equal(kind(`cd ${dirty}; git push`, clean), 'deny')
	assert.equal(kind(`git -C ${dirty} push`, clean), 'deny')
	const d = mkdtempSync(join(tmpdir(), 'guard-cd-'))
	writeFileSync(join(d, 'm.txt'), `fix: y\n\n${TRAILER}\n`)
	assert.equal(kind(`cd ${d} && git commit -F m.txt`, tmpdir()), 'deny')
	assert.equal(kind(`git -C ${d} commit -F m.txt`, tmpdir()), 'deny')
	assert.equal(kind(`(cd ${d} && ls); git commit -F m.txt`, tmpdir()), null)
})

// ---- Task 4: deploys, destructive git, the Artifact tool --------------------------------------------

const ASK = [
	'gh pr create --title x --body y',
	'gh pr merge 12 --squash',
	'vercel',
	'vercel --prod',
	'vercel deploy',
	'vercel deploy --prebuilt',
	'supabase functions deploy foo --project-ref r',
	'supabase db push',
	'asc builds upload --app 1',
	'asc publish testflight --app 1',
	'npm publish',
	'firebase deploy --only hosting',
	'git reset --hard HEAD~1',
	'git checkout -f main',
	'git checkout --force main',
	'git clean -fd',
	'git clean -f',
	'git branch -f main abc1234',
	'git push --force origin main',
	'git push -f',
]
const ALLOW = [
	'vercel env ls',
	'vercel logs',
	'supabase db diff',
	'supabase functions list',
	'asc builds list --app 1',
	'firebase projects:list',
	'npm install',
	'git reset --soft HEAD~1',
	'git status',
	'git checkout main',
	'git checkout -b feature/x',
	'git branch -d old',
	'git clean -n',
	'gh pr view 3',
	'gh pr list',
	'echo "vercel --prod"',
	"git commit --allow-empty -m 'about git reset --hard'",
]

test('each deploy and discard command asks, plain, through rtk, after cd, and by full path', () => {
	for (const c of ASK) {
		for (const wrapped of [c, `rtk ${c}`, `cd /tmp && ${c}`, `cd /tmp && rtk proxy ${c}`, `FOO=1 timeout 5 ${c}`]) {
			assert.equal(kind(wrapped), 'ask', wrapped)
		}
	}
})

test('read-only and safe neighbours of the gated commands are left alone', () => {
	for (const c of ALLOW) assert.equal(kind(c), null, c)
	assert.equal(kind('rtk vercel env ls'), null)
})

test('a directory before gh, vercel, supabase, npm and the rest does not hide the command', () => {
	assert.equal(kind('/opt/homebrew/bin/gh pr create --title x'), 'ask')
	assert.equal(kind('/usr/local/bin/vercel --prod'), 'ask')
	assert.equal(kind('/opt/homebrew/bin/supabase db push'), 'ask')
	assert.equal(kind('/usr/bin/git reset --hard'), 'ask')
	assert.equal(kind('rtk /opt/homebrew/bin/gh pr merge 3'), 'ask')
	assert.deepEqual(normalise(['/opt/homebrew/bin/gh', 'pr', 'create']), ['gh', 'pr', 'create'])
	assert.equal(kind('/usr/local/bin/vercel env ls'), null)
})

test('inside bash -c, command substitution and a heredoc body that is run, the gates still ask', () => {
	assert.equal(kind("bash -c 'vercel --prod'"), 'ask')
	assert.equal(kind('echo $(npm publish)'), 'ask')
	assert.equal(kind('cat <<EOF\nvercel --prod\nEOF'), null)
	assert.equal(kind('if true; then firebase deploy; fi'), 'ask')
})

test('a forced push says so; a trailer in an unpushed commit still denies', () => {
	assert.match(bash('git push --force').reason, /force/i)
	assert.match(bash('git push --force-with-lease origin x').reason, /force/i)
	const dir = withRemote()
	commitWith(dir, `fix\n\n${TRAILER}`)
	assert.equal(kind('git push --force', dir), 'deny')
})

test('gh pr merge holds the attribution check: a trailer in --body or --body-file denies, otherwise it asks', () => {
	const dir = mkdtempSync(join(tmpdir(), 'guard-body-'))
	writeFileSync(join(dir, 'b.txt'), `merged\n\n${TRAILER}\n`)
	assert.equal(kind(`gh pr merge 4 --squash --body "x\n${GENERATED}"`), 'deny')
	assert.equal(kind(`gh pr merge 4 -b "${TRAILER}"`), 'deny')
	assert.equal(kind('gh pr merge 4 --body-file b.txt', dir), 'deny')
	assert.equal(kind('gh pr merge 4 --squash --body "clean"'), 'ask')
	assert.equal(kind('gh pr merge 4 --body-file missing.txt', dir), 'ask')
	assert.equal(kind(`gh pr create --title t --body "${TRAILER}"`), 'deny')
})

test('the Artifact tool asks to publish, with the action omitted, and to delete; list, read and open pass', () => {
	const art = (tool_input) => decide({ tool_name: 'Artifact', tool_input, cwd: tmpdir() })?.decision ?? null
	assert.equal(art({ file_path: '/x/a.html' }), 'ask')
	assert.equal(art({ action: 'publish', file_path: '/x/a.html' }), 'ask')
	assert.equal(art({ action: 'delete', url: 'u' }), 'ask')
	assert.equal(art({ action: 'list' }), null)
	assert.equal(art({ action: 'read', url: 'u' }), null)
	assert.equal(art({ action: 'open', url: 'u' }), null)
	assert.equal(art({}), 'ask')
	assert.match(decide({ tool_name: 'Artifact', tool_input: {} }).reason, /publish|claude\.ai/i)
	assert.equal(decide({ tool_name: 'Read', tool_input: { file_path: 'x' } }), null)
})

test('as a hook script, an Artifact publish prints an ask and a list prints nothing', () => {
	const run = (input) => spawnSync('node', [GUARD], { input: JSON.stringify(input), encoding: 'utf8', env: PINNED })
	const a = run({ tool_name: 'Artifact', tool_input: { action: 'publish', file_path: 'x.html' }, cwd: tmpdir() })
	assert.equal(a.status, 0)
	assert.equal(JSON.parse(a.stdout).hookSpecificOutput.permissionDecision, 'ask')
	const b = run({ tool_name: 'Artifact', tool_input: { action: 'list' }, cwd: tmpdir() })
	assert.equal(b.status, 0)
	assert.equal(b.stdout, '')
	const c = run({ tool_name: 'Bash', tool_input: { command: 'vercel --prod' }, cwd: tmpdir() })
	assert.equal(JSON.parse(c.stdout).hookSpecificOutput.permissionDecision, 'ask')
})

// ---- pointing at rules when a command runs -----------------------------------------------------------

const hook = (fx, sessions, input, env = {}) => {
	const r = spawnSync(process.execPath, [GUARD], {
		input: JSON.stringify({ tool_name: 'Bash', cwd: tmpdir(), ...input }),
		encoding: 'utf8',
		env: { ...process.env, CLAUDE_HOME: fx.claude, WP_BRAIN_SESSIONS: sessions, ...env },
	})
	assert.equal(r.status, 0, r.stderr)
	return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null
}
const cmd = (command) => ({ tool_input: { command } })

test('guard: git commit gets no decision and one pointer the first time, and nothing the second', () => {
	const fx = claudeFixture()
	const sessions = mkdtempSync(join(tmpdir(), 'guard-sessions-'))
	const first = hook(fx, sessions, { ...cmd('git commit -m "feat: x"'), session_id: 's1' })
	assert.equal(first.hookEventName, 'PreToolUse')
	assert.equal(first.permissionDecision, undefined)
	assert.equal(first.permissionDecisionReason, undefined)
	assert.match(first.additionalContext, /Read before acting: \S*commit-hygiene\.md/)
	assert.doesNotMatch(first.additionalContext, /RULEBODYTEXT/)
	assert.equal(hook(fx, sessions, { ...cmd('git commit -m "fix: y"'), session_id: 's1' }), null)
	// Another session is pointed at it again.
	assert.match(hook(fx, sessions, { ...cmd('git commit -m "x"'), session_id: 's2' }).additionalContext, /commit-hygiene/)
})

test('guard: a subagent is pointed at the rule even when its parent was, and only once', () => {
	const fx = claudeFixture()
	const sessions = mkdtempSync(join(tmpdir(), 'guard-sessions-'))
	assert.ok(hook(fx, sessions, { ...cmd('git commit -m x'), session_id: 's1' }))
	const sub = hook(fx, sessions, { ...cmd('git commit -m x'), session_id: 's1', agent_id: 'agent-7' })
	assert.match(sub.additionalContext, /commit-hygiene/)
	assert.equal(hook(fx, sessions, { ...cmd('git commit -m x'), session_id: 's1', agent_id: 'agent-7' }), null)
	assert.ok(hook(fx, sessions, { ...cmd('git commit -m x'), session_id: 's1', agent_id: 'agent-8' }))
})

test('guard: an ask keeps its reason and may carry the pointer; a deny keeps its reason alone', () => {
	const fx = claudeFixture()
	const sessions = mkdtempSync(join(tmpdir(), 'guard-sessions-'))
	const ask = hook(fx, sessions, { ...cmd('git push'), session_id: 's1' })
	assert.equal(ask.permissionDecision, 'ask')
	assert.ok(ask.permissionDecisionReason)
	assert.match(ask.additionalContext, /git-push-rule\.md/)
	const deny = hook(fx, sessions, { ...cmd(`git commit -m "x\n\n${TRAILER}"`), session_id: 's1' })
	assert.equal(deny.permissionDecision, 'deny')
	assert.ok(deny.permissionDecisionReason)
	assert.equal(deny.additionalContext, undefined)
	// The deny did not use up the commit pointer.
	assert.match(hook(fx, sessions, { ...cmd('git commit -m "x"'), session_id: 's1' }).additionalContext, /commit-hygiene/)
})

test('guard: no map, no pointer; other commands, no pointer; and the output without a map is what it was', () => {
	const none = claudeFixture({ map: false })
	const sessions = mkdtempSync(join(tmpdir(), 'guard-sessions-'))
	assert.equal(hook(none, sessions, { ...cmd('git commit -m x'), session_id: 's1' }), null)
	const push = hook(none, sessions, { ...cmd('git push'), session_id: 's1' })
	assert.deepEqual(Object.keys(push).sort(), ['hookEventName', 'permissionDecision', 'permissionDecisionReason'])
	const fx = claudeFixture()
	assert.equal(hook(fx, sessions, { ...cmd('ls -la && echo hi'), session_id: 's1' }), null)
	assert.equal(hook(fx, sessions, { ...cmd('git status'), session_id: 's1' }), null)
	assert.equal(hook(fx, sessions, { tool_name: 'Read', tool_input: {}, session_id: 's1' }), null)
	// A broken map is quiet, and the push still asks.
	writeFileSync(fx.mapPath, 'nope')
	assert.equal(hook(fx, sessions, { ...cmd('git commit -m x'), session_id: 's1' }), null)
	assert.equal(hook(fx, sessions, { ...cmd('git push'), session_id: 's1' }).permissionDecision, 'ask')
})

test('guard: marks live in the sessions folder, and a call with no session still gets its pointer', () => {
	const fx = claudeFixture()
	const sessions = mkdtempSync(join(tmpdir(), 'guard-sessions-'))
	hook(fx, sessions, { ...cmd('git commit -m x'), session_id: 's9' })
	const marks = readFileSync(join(sessions, 's9.rules.json'), 'utf8')
	assert.match(marks, /commit-hygiene/)
	const home = mkdtempSync(join(tmpdir(), 'guard-home-'))
	assert.match(hook(fx, sessions, cmd('git commit -m x'), { HOME: home }).additionalContext, /commit-hygiene/)
	assert.ok(!existsSync(join(home, '.workpulse')), 'nothing written without a session')
})

test('guard: a command that cannot match imports no rules module, with or without a map', () => {
	const fx = claudeFixture()
	const sessions = mkdtempSync(join(tmpdir(), 'guard-sessions-'))
	const log = join(sessions, 'imports.log')
	const loader = join(sessions, 'trace.mjs')
	writeFileSync(loader, `import { registerHooks } from 'node:module'\nimport { appendFileSync } from 'node:fs'\nregisterHooks({ resolve(s, c, next) { const r = next(s, c); appendFileSync(${JSON.stringify(log)}, r.url + '\\n'); return r } })\n`)
	const run = (command, env) =>
		spawnSync(process.execPath, ['--import', loader, GUARD], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: tmpdir(), session_id: 'imp' }), encoding: 'utf8', env: { ...process.env, CLAUDE_HOME: fx.claude, WP_BRAIN_SESSIONS: sessions, ...env } })
	const imported = () => (existsSync(log) ? readFileSync(log, 'utf8') : '')
	assert.equal(run('ls -la && echo hi').status, 0)
	assert.doesNotMatch(imported(), /rules\.mjs/, 'a non-git command with a map')
	assert.equal(run('git status').status, 0)
	assert.doesNotMatch(imported(), /rules\.mjs/, 'git, but no onCommand matches')
	assert.equal(run('git commit -m x', { CLAUDE_HOME: claudeFixture({ map: false }).claude }).status, 0)
	assert.doesNotMatch(imported(), /rules\.mjs/, 'a git command with no map')
	run('git commit -m x')
	assert.match(imported(), /rules\.mjs/, 'a matching command does import it')
})

// ---- final review, issue 3: forms of a gated command that used to get no decision ------------------

test('final review: package-manager shorthand and runners ask', () => {
	for (const c of [
		'pnpm vercel --prod',
		'pnpm supabase db push',
		'bun vercel --prod',
		'yarn dlx vercel --prod',
		'yarn exec vercel --prod',
		'pnpm --filter x exec vercel --prod',
		'pnpm -C app dlx supabase db push',
	])
		assert.equal(kind(c), 'ask', c)
	for (const c of ['pnpm install', 'pnpm run build', 'pnpm vercel env ls', 'yarn dlx prettier .', 'pnpm --filter x test']) assert.equal(kind(c), null, c)
})

test('final review: an unknown wrapper in front of a gated command asks', () => {
	for (const c of [
		'gtimeout 30 git push',
		'caffeinate -i git push',
		'arch -arm64 git push',
		'find . -exec git push \;',
		'op run -- git push',
		'dotenv -- vercel --prod',
		'op run -- gh pr merge 3',
	])
		assert.equal(kind(c), 'ask', c)
})

test('final review: ordinary tools that take words as arguments do not prompt', () => {
	for (const c of [
		'grep "git push" f',
		'node x.js "git push"',
		'git log --grep=push',
		'ls push',
		'cat git push',
		'echo git push',
		'man git push',
		'mkdir git push',
		'which git',
		'rg push src',
		'git help push',
		'npm run deploy',
		'make deploy',
	])
		assert.equal(kind(c), null, c)
})

test('final review: a shell fed on stdin is read', () => {
	assert.equal(kind('bash <<EOF\ngit push\nEOF'), 'ask')
	assert.equal(kind("sh <<'EOF'\nvercel --prod\nEOF"), 'ask')
	assert.equal(kind("echo 'git push' | bash"), 'ask')
	assert.equal(kind("printf '%s\\n' 'git push' | sh"), 'ask')
	assert.equal(kind("bash -s <<< 'git push'"), 'ask')
	assert.equal(kind('cat x | bash'), null)
	assert.equal(kind('bash <<EOF\nls\nEOF'), null)
	assert.equal(kind('cat <<EOF\ngit push\nEOF'), null)
})

test('final review: fish, ksh, function bodies, arithmetic, vc', () => {
	assert.equal(kind("fish -c 'git push'"), 'ask')
	assert.equal(kind("ksh -c 'git push'"), 'ask')
	assert.equal(kind('function f { git push; }; f'), 'ask')
	assert.equal(kind('function f() { git push; }'), 'ask')
	assert.equal(kind('(( x << 1 ))\ngit push'), 'ask')
	assert.equal(kind('vc deploy'), 'ask')
	assert.equal(kind('vc --prod'), 'ask')
	assert.equal(kind('vc env ls'), null)
	assert.equal(kind('command -v vercel'), null)
	assert.equal(kind('command -V git'), null)
	assert.equal(kind('command git push'), 'ask')
})

test('final review: a trailer in a message that arrives on a pipe or here-string is denied', () => {
	assert.equal(kind(`echo "fix: y\n\n${TRAILER}" | git commit -F -`), 'deny')
	assert.equal(kind(`printf '%s' "${TRAILER}" | git commit -F -`), 'deny')
	assert.equal(kind(`git commit -F - <<< "fix: y\n\n${TRAILER}"`), 'deny')
	assert.equal(kind(`echo "x\n${GENERATED}" | gh pr edit 3 --body-file -`), 'deny')
	assert.equal(kind('echo "fix: y" | git commit -F -'), null)
	assert.equal(kind('git commit -F - <<< "fix: y"'), null)
})

test('a (( that is nested subshells asks; real arithmetic stays quiet', () => {
	for (const c of [
		'((git push) || (git status))',
		'((git push); (ls))',
		'((git push) && (echo ok))',
		'((git push) | (cat))',
		'((ls) && (git push)) && true',
		'((ls); (git push))',
		'((git push)\n(ls))',
		'(( x << 1 ))\ngit push',
	]) assert.equal(kind(c), 'ask', c)
	assert.equal(kind('((git push))'), null)
})

test('a gated command inside (( … )) is read', () => {
	for (const c of [
		'(( $(git push) ))',
		'(( `git push` ))',
		'true && (( $(git push) ))',
		'(( "$(git push)" ))',
		"(( '$(git push)' ))", // zsh runs it even in single quotes
		'(( x + $(( $(git push) )) ))',
		'echo $(( $(git push) + 1 ))',
		'echo "$(( `git push` + 1 ))"',
		'echo $(( 1 << 1\n))\ngit push',
		'if (( $(git push) )); then echo ok; fi',
		'for (( i=$(git push); i<1; i++ )); do echo; done',
	]) assert.equal(kind(c), 'ask', c)
})

test('a << shift after if, while, for and friends is no heredoc', () => {
	for (const c of [
		'if (( 1 << 1 )); then\n  git push\nfi',
		'while (( 1 << 1 )); do\n  git push\ndone',
		'until (( 1 << 1 )); do\n  git push\ndone',
		'for ((i=1;i<<2;i++)); do\n  git push\ndone',
		'if true; then (( 1 << 1 )); git push\nfi',
		'if false; then :; elif (( 1 << 1 )); then\n  git push\nfi',
		'if ! (( 1 << 1 )); then\n  git push\nfi',
		'f() { (( 1 << 1 ))\n  git push\n}',
	]) assert.equal(kind(c), 'ask', c)
})

test('(( … )) respects quotes, and asks on what it cannot close', () => {
	for (const c of [
		'(( ")" << 1 ))\ngit push',
		"(( ')' << 1 ))\ngit push",
		'(( "(" << 1 ))\ngit push',
		"(( '(' << 1 ))\ngit push",
		'(( x \\) << 1 ))\ngit push',
		'(( "x << 1 ))\ngit push',
		"(( 'x << 1 ))\ngit push",
		'(( 1 << 1\ngit push',
	]) assert.equal(kind(c), 'ask', c)
})

test('deep nesting asks instead of passing', () => {
	const nest = (n, inner) => '$(echo '.repeat(n) + inner + ')'.repeat(n)
	for (const n of [8, 9, 12]) assert.equal(kind(`echo ${nest(n, 'git push')}`), 'ask', `${n} levels`)
	assert.match(bash(`echo ${nest(9, 'git push')}`).reason, /nested too deep/)
	assert.equal(kind(`echo ${nest(7, 'git status')}`), null)
	assert.equal(kind(`echo ${nest(9, 'ls')}`), null, 'no gated word: nothing to ask about')
	let sh = 'git push'
	for (let i = 0; i < 9; i++) sh = `bash -c ${JSON.stringify(sh)}`
	assert.equal(kind(sh), 'ask')
})

test('safe commands and normal arithmetic stay silent', () => {
	for (const c of [
		'git status',
		'git log --oneline',
		'ls',
		'echo "git push"',
		'(( x + 1 ))',
		'(( x << 1 ))',
		'if (( 1 << 1 )); then echo ok; fi',
		'while (( i < 3 )); do echo git; (( i++ )); done',
		'for ((i=0;i<<2;i++)); do git status; done',
		'(( (a + 1) * 2 ))',
		'(( x = $(wc -l < file) ))',
		'echo $(( 1 << 2 ))',
		'git log -n $(( 1 << 2 ))',
		'x=$(( $(git rev-list --count HEAD) + 1 ))',
		'echo "$(( 1 << 2 ))"',
	]) assert.equal(kind(c), null, c)
})

// A git on PATH that sleeps, then does what git does. `ignoreTerm`: it also shrugs off SIGTERM.
function slowGit(seconds, { ignoreTerm = false } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'guard-slow-git-'))
	const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
	writeFileSync(join(dir, 'git'), `#!/bin/sh\n${ignoreTerm ? "trap '' TERM\n" : ''}sleep ${seconds}\nexec ${JSON.stringify(real)} "$@"\n`, { mode: 0o755 })
	return dir
}
function guardWith(shim, command, cwd) {
	const t0 = Date.now()
	const r = spawnSync(process.execPath, [GUARD], {
		input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }),
		encoding: 'utf8',
		env: { ...PINNED, PATH: `${shim}:${process.env.PATH}` },
	})
	return { ms: Date.now() - t0, out: JSON.parse(r.stdout || '{}').hookSpecificOutput }
}

for (const [name, seconds, command, opts] of [
	['one git call never ends', 30, 'git push', {}],
	['one git call never ends and ignores SIGTERM', 30, 'git push', { ignoreTerm: true }],
	['every git call is slow, and there are many', 1.3, 'git push origin a b c d e f', {}],
	['several pushes share the one deadline', 2, 'git push; git push; git push', {}],
]) {
	test(`a slow git: the guard answers ask before the hook's 5 s timeout (${name})`, () => {
		const { ms, out } = guardWith(slowGit(seconds, opts), command, repo())
		assert.equal(out?.permissionDecision, 'ask')
		assert.match(out.permissionDecisionReason, /Could not scan/)
		assert.ok(ms < 5000, `took ${ms} ms`)
	})
}

test('a slow git that still answers in time decides as before', () => {
	const dir = repo()
	commitWith(dir, `fix: y\n\n${TRAILER}`)
	const { out } = guardWith(slowGit(0.2), 'git push', dir)
	assert.equal(out?.permissionDecision, 'deny')
})

test('gh flags between the group and the subcommand do not hide the rule', () => {
	for (const c of [
		'gh pr -R o/r merge 3',
		'gh pr --repo o/r create --title t',
		'gh pr --repo=o/r merge 3',
		'gh -R o/r pr --repo o/r merge 3',
		'gh --hostname h.example.com pr merge 3',
	]) assert.equal(kind(c), 'ask', c)
	assert.equal(kind(`gh pr -R o/r edit 3 --body "x\n${TRAILER}"`), 'deny')
	assert.equal(kind(`gh pr --repo o/r comment 3 --body "x\n${TRAILER}"`), 'deny')
	for (const c of ['gh pr -R o/r view 3', 'gh pr -R o/r list', 'gh pr list --json merge', 'gh pr view 3 --json merge', 'gh -R o/r pr edit 3 --title t']) assert.equal(kind(c), null, c)
})

test('options between the parts of a supabase or asc command do not hide the rule', () => {
	for (const c of ['supabase functions --project-ref x deploy f', 'supabase db --db-url u push', 'asc builds --report-file x upload']) assert.equal(kind(c), 'ask', c)
	for (const c of ['supabase functions --project-ref x list', 'supabase db --db-url u diff', 'asc builds --report-file x list']) assert.equal(kind(c), null, c)
})

test('a git alias on the command line and $IFS in a command word ask', () => {
	for (const c of [
		'git -c alias.p=push p',
		"git -c alias.p='!git push' p",
		'git -c alias.p=reset\\ --hard p',
		'git -c ALIAS.p=push p',
		'git --config-env=alias.p=X p',
		'git --config-env alias.p=X p',
		'rtk git -c alias.p=push p',
		'caffeinate git -c alias.p=push p',
		"bash -c 'git -c alias.p=push p'",
		'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p',
		'git${IFS}push',
		'git$IFS""push',
		'git$IFS"push"',
		'git $IFS push',
		'rtk git${IFS}push',
		'git --no-pager${IFS}push',
		'vercel${IFS}--prod',
		'gi${x}t push',
		'g\\it p\\ush',
		'gi""t pu""sh',
	]) assert.equal(kind(c), 'ask', c)
	for (const c of [
		'git -c core.pager=cat log',
		'git -c alias.st=status st',
		'echo git -c alias.p=push p',
		'grep "$IFS" git',
		'echo${IFS}hi',
		'echo "$IFS"',
		'IFS=, read a b',
		'x="$IFS"',
	]) assert.equal(kind(c), null, c)
})

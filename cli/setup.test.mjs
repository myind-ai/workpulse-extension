// node --test cli/setup.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { brainSandbox } from './sandbox.mjs'
import { GUARD_ALLOW, GUARD_ASK_RULES, guardPathOf, ensureRepo, extensionSteps, guardSettings, nudgeText, repoRows, placeHook, placeRule, removeGuard, removeHook, ruleText, settingsRunHook, viaPlugin } from './setup.mjs'

test('a hook is added beside the others, and replaced rather than doubled on a re-run', () => {
	const s = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook' }] }], Stop: [{ hooks: [{ type: 'command', command: 'other-stop' }] }] } }
	placeHook(s, 'Stop', 'node /a/wp-brain.mjs stop-check', 'wp-brain.mjs stop-check')
	placeHook(s, 'Stop', 'node /b/wp-brain.mjs stop-check', 'wp-brain.mjs stop-check')
	const stops = s.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command))
	assert.deepEqual(stops, ['other-stop', 'node /b/wp-brain.mjs stop-check'])
	assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'rtk hook')
})

test('answering no removes only our hook, and the event when nothing is left', () => {
	const s = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node x/wp-brain.mjs hook' }] }] } }
	removeHook(s, 'SessionStart', 'wp-brain.mjs hook')
	assert.equal(s.hooks.SessionStart, undefined)
})

test('the rule replaces its marked block, or a hand-written section of the same name, and is never doubled', () => {
	const rule = ruleText({ repo: 'me/notes', branch: 'brain', cli: '/x/wp-brain.mjs' })
	assert.match(rule, /branch \*\*`brain`\*\* of the private repo \*\*`me\/notes`\*\*/)
	const hand = '# Rules\n\n## A\nkeep\n\n## WorkPulse Brain — old\nold text\n\n## Z\nkeep z\n'
	const once = placeRule(hand, rule)
	assert.ok(once.includes('keep\n') && once.includes('## Z\nkeep z'))
	assert.ok(!once.includes('old text'))
	const twice = placeRule(once, ruleText({ repo: 'me/notes', branch: '', cli: '/x/wp-brain.mjs' }))
	assert.equal(twice.split('workpulse-brain:start').length - 1, 1)
	assert.match(twice, /the private repo \*\*`me\/notes`\*\*/)
	assert.match(placeRule('# Only\n', rule), /# Only\n\n<!-- workpulse-brain:start -->/)
})

test('a missing repository is created private only when asked, and an existing one is left alone', () => {
	const calls = []
	const sh = (exists, ok = true) => (cmd, args) => {
		calls.push(args.join(' '))
		if (args[1] === 'view') return exists ? '{}' : null
		return ok ? 'ok' : null
	}
	assert.equal(ensureRepo({ repo: 'me/notes', create: true, sh: sh(true) }), 'exists')
	assert.ok(!calls.some((c) => c.startsWith('repo create')))
	assert.equal(ensureRepo({ repo: 'me/notes', create: true, sh: sh(false) }), 'created')
	assert.ok(calls.some((c) => c.startsWith('repo create me/notes --private')))
	assert.throws(() => ensureRepo({ repo: 'me/notes', create: false, sh: sh(false) }), /--create yes/)
	assert.throws(() => ensureRepo({ repo: 'me/notes', create: true, sh: sh(false, false) }), /Couldn't create|GitHub CLI is missing/)
})

test('the browser steps name the branch, the repository and a pre-filled token page for its owner', () => {
	const text = extensionSteps({ repo: 'me/notes', branch: 'brain', tokenUrl: (o) => `TOKEN?owner=${o}` })
	assert.match(text, /Branch: brain/)
	assert.match(text, /TOKEN\?owner=me/)
	assert.match(text, /pick me\/notes, press Back up now/)
	assert.match(extensionSteps({ repo: 'me/notes', branch: '', tokenUrl: () => '' }), /default branch/)
})

test('the plugin hook stays quiet when settings.json already runs the same hook', () => {
	const s = { hooks: {} }
	placeHook(s, 'SessionStart', 'node /x/wp-brain.mjs hook 2>/dev/null || true', 'wp-brain.mjs hook')
	assert.equal(settingsRunHook(JSON.stringify(s), 'wp-brain.mjs hook'), true)
	assert.equal(settingsRunHook(JSON.stringify(s), 'wp-brain.mjs stop-check'), false)
	assert.equal(settingsRunHook('{not json', 'wp-brain.mjs hook'), false)
	assert.equal(settingsRunHook('', 'wp-brain.mjs hook'), false)
})

test('the not-linked nudge points at the skill and asks only once', () => {
	assert.match(nudgeText(), /workpulse-brain skill/)
	assert.match(nudgeText(), /do not ask again/)
})

test('doctor sees the plugin when it is installed, and not when it is switched off', () => {
	const dir = mkdtempSync(join(tmpdir(), 'wp-plugin-'))
	assert.equal(viaPlugin(dir, {}), null)
	mkdirSync(join(dir, 'plugins'))
	writeFileSync(join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'workpulse-brain@workpulse': [{ scope: 'user' }] } }))
	assert.equal(viaPlugin(dir, {}), 'workpulse-brain@workpulse')
	assert.equal(viaPlugin(dir, { enabledPlugins: { 'workpulse-brain@workpulse': false } }), null)
})

// ---- the guard: installed through setup, off by default -----------------------------------------------

const GUARD = '/x/cli/guard.mjs'
const mine = () => ({
	hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }] },
	permissions: { allow: ['Bash(git push:*)'], deny: ['Bash(rm -rf /)'] },
	model: 'opus',
})

test('the ask rules start with the push gate and cover the deploy and discard rows', () => {
	assert.deepEqual(GUARD_ASK_RULES.slice(0, 2), ['Bash(git push *)', 'Bash(git push)'])
	for (const r of ['gh pr create', 'gh pr merge', 'vercel --prod', 'vercel deploy', 'supabase functions deploy', 'supabase db push', 'asc builds upload', 'asc publish', 'npm publish', 'firebase deploy', 'git reset --hard', 'git checkout -f', 'git clean -f', 'git branch -f'])
		assert.ok(GUARD_ASK_RULES.some((x) => x.startsWith(`Bash(${r}`)), r)
	assert.ok(!GUARD_ASK_RULES.some((x) => /vercel \*\)/.test(x)), 'a bare vercel * would also ask for vercel env ls')
	assert.equal(new Set(GUARD_ASK_RULES).size, GUARD_ASK_RULES.length)
})

test('guardSettings leaves the rtk hook and the allowed push alone, and adds the guard', () => {
	const s = guardSettings(mine(), GUARD)
	assert.deepEqual(s.hooks.PreToolUse[0], mine().hooks.PreToolUse[0])
	assert.deepEqual(s.permissions.allow, ['Bash(git push:*)', ...GUARD_ALLOW])
	assert.deepEqual(s.permissions.deny, ['Bash(rm -rf /)'])
	assert.deepEqual(s.permissions.ask, GUARD_ASK_RULES)
	assert.deepEqual(s.attribution, { commit: '', pr: '', sessionUrl: false })
	assert.equal(s.model, 'opus')
	const g = s.hooks.PreToolUse.find((x) => x.hooks.some((h) => h.command.includes('guard.mjs')))
	assert.equal(g.matcher, 'Bash|Artifact')
	assert.deepEqual(g.hooks, [{ type: 'command', command: `node "${GUARD}"`, timeout: 5 }])
})

test('installing twice leaves no duplicates, and a moved guard replaces the old path', () => {
	const once = guardSettings(mine(), GUARD)
	const twice = guardSettings(JSON.parse(JSON.stringify(once)), GUARD)
	assert.deepEqual(twice, once)
	const moved = guardSettings(twice, '/y/cli/guard.mjs')
	assert.equal(moved.hooks.PreToolUse.flatMap((g) => g.hooks).filter((h) => h.command.includes('guard.mjs')).length, 1)
	assert.ok(moved.hooks.PreToolUse.flatMap((g) => g.hooks).some((h) => h.command === 'node "/y/cli/guard.mjs"'))
})

test('removeGuard takes off only what the guard added', () => {
	assert.deepEqual(removeGuard(guardSettings(mine(), GUARD)), mine())
	assert.deepEqual(removeGuard(guardSettings({}, GUARD)), {})
	const own = { permissions: { ask: ['Bash(rm *)'], allow: ['Read(~/.claude/rule-files/**)', 'Bash(ls)'] }, attribution: { commit: 'mine' } }
	const out = removeGuard(guardSettings(JSON.parse(JSON.stringify(own)), GUARD))
	assert.deepEqual(out.permissions.ask, ['Bash(rm *)'])
	assert.deepEqual(removeGuard({ attribution: { commit: 'mine' } }), { attribution: { commit: 'mine' } })
})

const clone = (o) => JSON.parse(JSON.stringify(o))

test('guardSettings keeps the owner\'s attribution, and removeGuard leaves it exactly as it was', () => {
	for (const own of [{ commit: 'mine', pr: 'mine too' }, { commit: '', pr: '' }, { commit: '', pr: 'x', sessionUrl: true }]) {
		const before = { ...mine(), attribution: clone(own) }
		const on = guardSettings(clone(before), GUARD)
		assert.deepEqual(on.attribution, own, 'not overwritten')
		assert.deepEqual(removeGuard(on), before)
	}
})

test('without an attribution of the owner\'s, the guard sets its own and removal deletes it', () => {
	const on = guardSettings(mine(), GUARD)
	assert.deepEqual(on.attribution, { commit: '', pr: '', sessionUrl: false })
	assert.deepEqual(removeGuard(on), mine())
})

test('installing twice does not lose the owner\'s attribution or what the first install recorded', () => {
	const before = { ...mine(), attribution: { commit: 'mine' } }
	const twice = guardSettings(guardSettings(clone(before), GUARD), GUARD)
	assert.deepEqual(twice.attribution, { commit: 'mine' })
	assert.deepEqual(removeGuard(twice), before)
	const none = guardSettings(guardSettings(mine(), GUARD), GUARD)
	assert.deepEqual(removeGuard(none), mine(), 'none before: ours is still removed after two installs')
})

test('removeGuard keeps the ask rules and allow entry the owner had before install', () => {
	const before = { permissions: { ask: ['Bash(git push *)', 'Bash(rm *)'], allow: ['Read(~/.claude/rule-files/**)', 'Bash(ls)'] } }
	const out = removeGuard(guardSettings(guardSettings(clone(before), GUARD), GUARD))
	assert.deepEqual(out, before)
})

test('installing over a guard that has no record keeps the owner-held rules on removal', () => {
	const own = { ...mine(), attribution: { commit: 'mine' } }
	const first = guardSettings(clone(own), GUARD)
	delete first.workpulseGuard // an install from before the record, or a lost key
	const again = guardSettings(first, GUARD)
	assert.ok(again.workpulseGuard.ask.length > 0, 'the rules already there are recorded as ours')
	const out = removeGuard(again)
	assert.deepEqual(out.permissions?.ask ?? [], [], 'ours are gone')
	assert.deepEqual(out.attribution, { commit: 'mine' })
	const bare = guardSettings(mine(), GUARD)
	delete bare.workpulseGuard
	assert.deepEqual(removeGuard(guardSettings(bare, GUARD)), mine(), 'our own attribution and rules go too')
})

test('the plugin hooks.json files carry no guard', () => {
	const root = new URL('..', import.meta.url).pathname
	const files = [join(root, 'hooks', 'hooks.json')]
	for (const p of existsSync(join(root, 'plugins')) ? readdirSync(join(root, 'plugins')) : []) files.push(join(root, 'plugins', p, 'hooks', 'hooks.json'))
	const found = files.filter(existsSync)
	assert.ok(found.length > 0)
	for (const f of found) assert.ok(!/guard/i.test(readFileSync(f, 'utf8')), f)
})

function guardBox() {
	const claude = mkdtempSync(join(tmpdir(), 'wp-guard-claude-'))
	const b = brainSandbox({ env: { CLAUDE_HOME: claude } })
	const args = ['--repo', 'test/brain', '--no-push', '--clone', b.clone]
	const settingsPath = join(claude, 'settings.json')
	const read = () => JSON.parse(readFileSync(settingsPath, 'utf8'))
	return { b, claude, args, settingsPath, read }
}

test('setup --defaults leaves the guard off; --guard yes installs it after a backup; a re-run with defaults keeps it; --guard no removes it', () => {
	const { b, claude, args, settingsPath, read } = guardBox()
	writeFileSync(settingsPath, JSON.stringify(mine(), null, 2) + '\n')
	const off = b.run('setup', '--defaults', ...args)
	assert.equal(off.status, 0, off.err)
	assert.ok(!JSON.stringify(read()).includes('guard.mjs'))
	assert.equal(read().attribution, undefined)
	assert.equal(read().permissions.ask, undefined)

	const before = readFileSync(settingsPath, 'utf8')
	const on = b.run('setup', '--defaults', '--guard', 'yes', ...args)
	assert.equal(on.status, 0, on.err)
	assert.equal(readFileSync(`${settingsPath}.wp-brain.bak`, 'utf8'), before, 'the backup is the file as it was')
	const s = read()
	assert.ok(s.hooks.PreToolUse.some((g) => g.matcher === 'Bash|Artifact' && g.hooks[0].command.endsWith('guard.mjs"') && g.hooks[0].timeout === 5))
	assert.ok(s.hooks.PreToolUse.some((g) => g.hooks.some((h) => h.command === 'rtk hook claude')))
	assert.deepEqual(s.permissions.ask, GUARD_ASK_RULES)

	assert.equal(b.run('setup', '--defaults', ...args).status, 0)
	assert.ok(JSON.stringify(read()).includes('guard.mjs'), 'defaults do not switch an installed guard off')

	assert.equal(b.run('setup', '--defaults', '--guard', 'no', ...args).status, 0)
	assert.ok(!JSON.stringify(read()).includes('guard.mjs'))
	assert.deepEqual(read().permissions.allow, ['Bash(git push:*)'])
	assert.ok(existsSync(join(claude, 'settings.json')))
})

test('doctor reports the guard off, on, on with a missing path, and on without attribution', () => {
	const { b, args, settingsPath, read } = guardBox()
	assert.equal(b.run('setup', '--defaults', ...args).status, 0)
	assert.match(b.run('doctor').out, /✓ Guard\s+off/)

	assert.equal(b.run('setup', '--defaults', '--guard', 'yes', ...args).status, 0)
	const on = b.run('doctor').out
	assert.match(on, /✓ Guard\s+on/)
	assert.doesNotMatch(on, /! Guard/)

	const s = read()
	delete s.attribution
	writeFileSync(settingsPath, JSON.stringify(s))
	assert.match(b.run('doctor').out, /! Guard attribution\s+/)

	const t = read()
	t.attribution = { commit: '', pr: '', sessionUrl: false }
	for (const g of t.hooks.PreToolUse) for (const h of g.hooks) if (h.command.includes('guard.mjs')) h.command = 'node /nowhere/guard.mjs'
	writeFileSync(settingsPath, JSON.stringify(t))
	assert.match(b.run('doctor').out, /! Guard\s+.*does not exist/)
})

test('wp-brain guard prints the decision and the reason for a command', () => {
	const { b } = guardBox()
	assert.match(b.run('guard', 'git reset --hard HEAD~1').out, /^ask: .*your yes/)
	assert.match(b.run('guard', 'vercel env ls').out, /^allow/)
	assert.match(b.run('guard', 'gh pr merge 3 --body "Co-Authored-By: ' + 'Claude <noreply@' + 'anthropic.com>"').out, /^deny: /)
})

test('final review: the guard allows reading every file recall points at, and takes off only those it added', () => {
	assert.ok(GUARD_ALLOW.includes('Read(~/.claude/rules/**)') && GUARD_ALLOW.includes('Read(~/.claude/RTK.md)') && GUARD_ALLOW.includes('Read(~/.claude/rule-files/**)'))
	const own = { permissions: { allow: ['Read(~/.claude/RTK.md)', 'Bash(ls)'] } }
	const on = guardSettings(clone(own), GUARD)
	assert.deepEqual(on.permissions.allow, ['Read(~/.claude/RTK.md)', 'Bash(ls)', 'Read(~/.claude/rule-files/**)', 'Read(~/.claude/rules/**)'])
	assert.deepEqual(removeGuard(on), own, "the owner's own RTK.md allow stays")
	// A record from before this change held `allow: true` for the rule-files entry only.
	const old = guardSettings(clone(own), GUARD)
	old.workpulseGuard.allow = true
	assert.deepEqual(removeGuard(old).permissions.allow, ['Read(~/.claude/RTK.md)', 'Bash(ls)', 'Read(~/.claude/rules/**)'])
})

test('final review: the guard path is quoted so a space in it cannot stop the gate from starting, and doctor reads it back', () => {
	const s = guardSettings({}, '/Users/a b/cli/guard.mjs')
	const cmd = s.hooks.PreToolUse[0].hooks[0].command
	assert.equal(cmd, 'node "/Users/a b/cli/guard.mjs"')
	assert.equal(guardPathOf(cmd), '/Users/a b/cli/guard.mjs')
	assert.equal(guardPathOf('node /x/cli/guard.mjs'), '/x/cli/guard.mjs', 'an unquoted older install')
})

test('doctor says when the learning is public, shares a repository, or a file still names the repository it left', () => {
	const claude = mkdtempSync(join(tmpdir(), 'wp-brain-test-rows-'))
	const heads = 'aaa\trefs/heads/brain\nbbb\trefs/heads/main\n'
	const shared = repoRows({ cfg: { repo: 'me/code', branch: 'brain' }, heads, visibility: 'private', claude })
	assert.deepEqual(shared.map((r) => [r.what, r.ok]), [['Private', true], ['Own repository', false]])
	assert.match(shared[1].detail, /wp-brain move me\/workpulse-notes/)
	assert.equal(repoRows({ cfg: { repo: 'me/open', branch: 'brain' }, heads: 'a\trefs/heads/brain', visibility: 'public', claude })[0].ok, false)
	assert.equal(repoRows({ cfg: { repo: 'me/notes', branch: 'brain' }, heads: 'a\trefs/heads/brain', visibility: 'private', claude }).length, 1)
	const moved = { repo: 'me/notes', branch: 'brain', movedFrom: { repo: 'me/code', at: '2026-11-01T00:00:00Z' } }
	assert.equal(repoRows({ cfg: moved, heads: 'a\trefs/heads/brain', visibility: 'private', claude }).at(-1).ok, true)
	writeFileSync(join(claude, 'CLAUDE.md'), 'branch brain of me/code\n')
	const stale = repoRows({ cfg: moved, heads: 'a\trefs/heads/brain', visibility: 'private', claude }).at(-1)
	assert.equal(stale.ok, false)
	assert.match(stale.detail, /CLAUDE\.md still names me\/code/)
	writeFileSync(join(claude, 'CLAUDE.md'), 'branch brain of me/code-notes\n')
	assert.equal(repoRows({ cfg: { ...moved, repo: 'me/code-notes' }, heads: 'a\trefs/heads/brain', visibility: 'private', claude }).at(-1).ok, true, 'a name that only starts with the old one')
})

test('doctor: a browser backup counts as the extension being seen, with or without an entry from the Brain page', () => {
	const b = brainSandbox()
	assert.equal(b.run('add', 'learning', 'One entry so doctor reads on', '--no-push').status, 0)
	assert.match(b.run('doctor').out, /! Extension seen\s+no browser has written yet/)
	mkdirSync(join(b.clone, 'workpulse'))
	writeFileSync(join(b.clone, 'workpulse', 'index.json'), JSON.stringify({ version: 2, exportedAt: Date.UTC(2026, 10, 1) }))
	assert.match(b.run('doctor').out, /✓ Extension seen\s+backed up 2026-11-01; nothing added from the Brain page yet/)
})

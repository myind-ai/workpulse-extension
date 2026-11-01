// node --test cli/caps.test.mjs
// Hard token caps on the brief and recall, and `wp-brain show`.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CAPS, capLines, tokensOf } from './budget.mjs'
import { claudeFixture, linkedSkill } from './fixtures.mjs'
import { CLI, brainSandbox, withinBudget } from './sandbox.mjs'

// Step 1's fixed lessons and prompts (cli/brain-db.test.mjs), as entries `add --json` takes.
const VIDEO = { project: 'youtube-learning', tags: ['youtube', 'content', 'scripting'], body: 'From "Psychology Behind My Viral Videos" https://www.youtube.com/watch?v=Ad7VTVeREOk&t=181s. Notes: /x/youtube-learning/notes.md' }
const L = (title, more = {}) => ({ kind: 'learning', title, ...more })
const FIXTURE = [
	L("Open every script with Promise-Proof-Plan: the result promised in the thumbnail, proof you did it, then how you'll show it #youtube #content #scripting", VIDEO),
	L('Before a script, answer the 3 viewer objections on screen: is it for me, is this person credible #youtube #content #scripting', VIDEO),
	L('Value equation for hooks and listings: raise dream outcome, cut time and effort #youtube #content', { ...VIDEO, tags: ['youtube', 'content'] }),
	L("Landing script overwrote another session's uncommitted edits: a newline-separated file list was matched wrongly #git #tooling", { kind: 'mistake', tags: ['git', 'tooling'], rootCause: 'bad shell loop' }),
	L('Write tool turned \\u escapes into real characters in a content script #ascii #tooling', { kind: 'mistake', tags: ['ascii', 'tooling'] }),
	L("Wait loops with pgrep -f on a script name never ended: the loop's own zsh command line matched #shell #tooling", { kind: 'mistake', tags: ['shell', 'tooling'] }),
	L('Re-run of a sync script did rm -rf on the folder and took node_modules with it #scripts', { kind: 'mistake', tags: ['scripts', 'tooling'] }),
	L('Instagram reels have no subtitle tracks: save the caption and run Whisper #instagram', { tags: ['instagram', 'whisper'] }),
	L('A Stop hook that blocks must check stop_hook_active and ask once per session, or it loops #claude-code #hooks', { tags: ['claude-code', 'hooks'] }),
	L('Started feature edits in the main checkout instead of a new worktree #git', { kind: 'mistake', tags: ['git'] }),
	L('ElevenLabs stock voices sound English in Marathi; use native library voices by ID #elevenlabs #voice', { tags: ['elevenlabs', 'voice', 'marathi'] }),
	L('कहानी की शुरुआत वादे से करें और दर्शक का ध्यान पकड़ें #हिंदी', { tags: ['हिंदी'] }),
	L('App video studio frames each screen for a narrated explainer', { tags: ['video'] }),
	L('HyperFrames pilot records the app screen at 30 fps', { tags: ['video-editing'] }),
	L('Reel script hook ticket log with every word of the prompt', { kind: 'ticket' }),
]
const FIXED_PROMPTS = [
	'write the reel script hook',
	'how should I open the youtube video script',
	'fix the shell script that hangs',
	'why is the stop hook looping',
	'elevenlabs marathi voice sounds english',
	'git worktree conflict after a rebase',
	'दर्शक का ध्यान कैसे पकड़ें',
	'hello there how are you',
]

const hookJson = (r) => JSON.parse(r.out).hookSpecificOutput.additionalContext
const add = (sb, entries) => {
	const r = sb.runWith({ input: JSON.stringify(entries) }, 'add', '--json', '-', '--no-push')
	assert.equal(r.status, 0, r.err)
}

// ── capLines ───────────────────────────────────────────────────────────────

test('capLines keeps whole lines, counts its own more-line, and says how many it dropped', () => {
	const lines = Array.from({ length: 30 }, (_, i) => `line number ${i} with some padding words`)
	const more = (n) => `… ${n} more: wp-brain brief KEY --full`
	for (const max of [40, 60, 100, 150]) {
		const got = capLines(lines, max, more)
		assert.ok(tokensOf(got.lines.join('\n')) <= max, `${tokensOf(got.lines.join('\n'))} > ${max}`)
		assert.ok(got.dropped > 0)
		assert.equal(got.lines.at(-1), more(got.dropped))
		assert.deepEqual(got.lines.slice(0, -1), lines.slice(0, got.lines.length - 1), 'whole lines, in order')
	}
	assert.deepEqual(capLines(lines.slice(0, 2), 1000, more), { lines: lines.slice(0, 2), dropped: 0 })
	assert.deepEqual(capLines([], 10), { lines: [], dropped: 0 })
})

test('capLines without a more-line still drops whole lines', () => {
	const got = capLines(['aaaa aaaa', 'bbbb bbbb', 'cccc cccc'], 5)
	assert.deepEqual(got, { lines: ['aaaa aaaa', 'bbbb bbbb'].slice(0, got.lines.length), dropped: 3 - got.lines.length })
	assert.ok(tokensOf(got.lines.join('\n')) <= 5)
})

test('one line over the cap is cut at a code point with an ellipsis, never through a Devanagari letter or an emoji', () => {
	for (const line of ['कहानी की शुरुआत वादे से करें '.repeat(20), 'party 🎉👩‍👩‍👧 time '.repeat(30), 'x'.repeat(2000)]) {
		const got = capLines([line, 'second'], 25, (n) => `… ${n} more`)
		const text = got.lines.join('\n')
		assert.ok(tokensOf(text) <= 25, `${tokensOf(text)} tokens`)
		assert.ok(got.lines[0].endsWith('…'))
		assert.ok(!got.lines[0].includes('�'), 'no broken character')
		assert.ok(line.startsWith(got.lines[0].slice(0, -1)), 'a clean prefix of the line')
		assert.equal(got.dropped, 1)
	}
})

// ── recall ─────────────────────────────────────────────────────────────────

test('recall returns the same lessons in the same order as before the cap (step 1 prompts)', () => {
	// Recorded by running the uncapped recall on these prompts before this change.
	const expected = {
		'write the reel script hook': ['Before a script', 'Open every script'],
		'how should I open the youtube video script': ['Open every script', 'Value equation', 'Before a script'],
		'fix the shell script that hangs': ['Wait loops with pgrep'],
		'why is the stop hook looping': ['A Stop hook that blocks'],
		'elevenlabs marathi voice sounds english': ['ElevenLabs stock voices'],
		'git worktree conflict after a rebase': ['Started feature edits'],
		'दर्शक का ध्यान कैसे पकड़ें': ['कहानी की शुरुआत'],
		'hello there how are you': [],
	}
	const sb = brainSandbox()
	add(sb, FIXTURE)
	sb.run('db', 'rebuild')
	assert.deepEqual(FIXED_PROMPTS, Object.keys(expected))
	for (const [prompt, titles] of Object.entries(expected)) {
		const lines = sb.run('recall', prompt).out.split('\n').filter((l) => l.startsWith('- '))
		assert.equal(lines.length, titles.length, `${prompt}: ${lines.join(' | ')}`)
		lines.forEach((l, i) => assert.ok(l.includes(titles[i]), `${prompt}: #${i} should be "${titles[i]}", got ${l}`))
		// The hook is the capped path: same lessons, same order, none of them the one the cap drops here (all short).
		const hook = sb.runWith({ input: JSON.stringify({ session_id: `s-${prompt.length}`, prompt, cwd: tmpdir() }) }, 'recall')
		const shown = hook.out ? hookJson(hook).split('\n').filter((l) => l.startsWith('- ')) : []
		assert.equal(shown.length, titles.length, prompt)
		shown.forEach((l, i) => assert.ok(l.includes(titles[i]), `${prompt}: hook #${i}`))
	}
})

const QUOKKA = (n, extra = {}) => ({ kind: 'learning', title: `Quokka handling gloves patience lesson number ${n}: ${'wear thick gloves and move slowly around the animal '.repeat(3)}`, body: 'SECRETBODYTEXT should never reach the prompt', rootCause: 'SECRETROOTCAUSE nor this', ...extra })

test('the recall hook is 300 tokens or fewer with its header, and carries no body and no root cause', () => {
	const sb = brainSandbox()
	add(sb, [1, 2, 3].map((n) => QUOKKA(n)))
	sb.run('db', 'rebuild')
	const r = sb.runWith({ input: JSON.stringify({ session_id: 's1', prompt: 'quokka handling gloves patience', cwd: tmpdir() }) }, 'recall')
	assert.equal(r.status, 0, r.err)
	const text = hookJson(r)
	assert.ok(tokensOf(text) <= CAPS.recall, `${tokensOf(text)} tokens`)
	assert.match(text, /Quokka handling gloves/)
	assert.doesNotMatch(text, /SECRETBODYTEXT|SECRETROOTCAUSE|root cause/)
	assert.match(text, /wp-brain show [0-9a-z]{8}/, 'each lesson says how to open it')
})

test('a lesson the cap drops is not marked seen, and comes up on a later prompt', () => {
	const sb = brainSandbox()
	const url = 'https://example.com/' + 'quokka-handling-gloves/'.repeat(14)
	add(sb, [1, 2, 3].map((n) => QUOKKA(n, { source: { type: 'site', url: `${url}${n}` } })))
	sb.run('db', 'rebuild')
	const ask = () => sb.runWith({ input: JSON.stringify({ session_id: 'same', prompt: 'quokka handling gloves patience', cwd: tmpdir() }) }, 'recall')
	const first = hookJson(ask())
	assert.ok(tokensOf(first) <= CAPS.recall, `${tokensOf(first)} tokens`)
	const numbers = (t) => [...t.matchAll(/lesson number (\d)/g)].map((m) => m[1])
	const firstSeen = numbers(first)
	assert.ok(firstSeen.length >= 1 && firstSeen.length < 3, `shown ${firstSeen}`)
	assert.match(first, /… \d+ more/)
	const second = ask()
	assert.ok(second.out, 'something was held back, so something comes next')
	const secondSeen = numbers(hookJson(second))
	assert.ok(secondSeen.length >= 1)
	for (const n of secondSeen) assert.ok(!firstSeen.includes(n), `${n} was already shown`)
	const all = new Set(firstSeen)
	for (let i = 0; i < 3 && all.size < 3; i++) {
		const r = ask()
		if (!r.out) break
		numbers(hookJson(r)).forEach((n) => all.add(n))
		secondSeen.forEach((n) => all.add(n))
	}
	secondSeen.forEach((n) => all.add(n))
	assert.equal(all.size, 3, 'every lesson was shown in the end')
})

// ── brief ──────────────────────────────────────────────────────────────────

/** A git folder on a ticket branch, and a Brain with 40 entries for the ticket, 6 repeated mistakes, 6 follow-ups. */
function busyTicket() {
	const sb = brainSandbox()
	const repo = mkdtempSync(join(tmpdir(), 'wp-caps-repo-'))
	const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
	git('init', '-q', '-b', 'fix/pay-77-retry-webhook')
	git('remote', 'add', 'origin', 'https://github.com/acme/payments-web.git')
	const entries = []
	for (let i = 0; i < 40; i++) {
		entries.push({
			kind: i % 2 ? 'debug' : 'ticket',
			title: `PAY-77 step ${i}: the webhook retry path handled event number ${i} in a way that needed a closer look`,
			ticket: 'PAY-77',
			project: 'acme/payments-web',
			rootCause: i % 3 === 0 ? `root cause ${i}: the handler read the payload twice and the second read was empty` : undefined,
			next: i < 6 ? [`follow-up ${i}: re-run the failing delivery and compare the signatures`] : undefined,
			status: i < 6 ? 'wip' : 'done',
		})
	}
	for (let t = 1; t <= 6; t++) for (const k of ['a', 'b']) entries.push({ kind: 'mistake', title: `Repeated mistake ${t}${k}: forgot to check the thing again`, tags: [`rep${t}`], rootCause: 'not checked' })
	add(sb, entries)
	return { sb, repo, hook: (more = {}) => sb.runWith({ input: JSON.stringify({ session_id: 'sb', cwd: repo }), ...more }, 'hook') }
}

const inboxFile = (sb, id, text) => {
	const dir = join(sb.clone, 'bridge', 'inbox', 'to-cli')
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, at: 1, ticket: 'PAY-77', text }))
}

test('hook and brief on a busy ticket are 400 tokens or fewer, headed, and end with how to get the rest', () => {
	const { sb, repo, hook } = busyTicket()
	const r = hook()
	assert.equal(r.status, 0, r.err)
	const text = hookJson(r)
	assert.ok(tokensOf(text) <= CAPS.brief, `hook ${tokensOf(text)} tokens`)
	assert.match(text, /^WorkPulse Brain/)
	assert.match(text.trimEnd(), /… \d+ more: wp-brain brief PAY-77 --project acme\/payments-web --full$/)

	const brief = sb.run('brief', 'PAY-77', '--project', 'acme/payments-web')
	assert.equal(brief.status, 0, brief.err)
	assert.ok(tokensOf(brief.out) <= CAPS.brief, `brief ${tokensOf(brief.out)} tokens`)
	assert.match(brief.out.trimEnd(), /… \d+ more: wp-brain brief PAY-77 --project acme\/payments-web --full$/)

	const full = sb.run('brief', 'PAY-77', '--project', 'acme/payments-web', '--full')
	assert.ok(tokensOf(full.out) > CAPS.brief * 2, `--full is not capped: ${tokensOf(full.out)}`)
	assert.doesNotMatch(full.out, /more: wp-brain brief/)
	assert.ok(repo)
})

test('under pressure the inbox stays, then the ticket, follow-ups, repeats; the project comes last', () => {
	const { sb, hook } = busyTicket()
	inboxFile(sb, 'req-1', 'Please look at the retry limit before anything else')
	inboxFile(sb, 'req-2', 'Second request from the extension about PAY-77')
	const text = hookJson(hook())
	assert.ok(tokensOf(text) <= CAPS.brief)
	assert.match(text, /Please look at the retry limit/)
	assert.match(text, /Second request from the extension/)
	const at = (re) => text.search(re)
	assert.ok(at(/Inbox/) > 0 && at(/Inbox/) < at(/PAY-77: /), 'inbox first')
	assert.ok(at(/step \d+/) > 0, 'the ticket entries come next')
	// What gets dropped is the tail: the project section and then the learned/repeat sections, not the front.
	assert.doesNotMatch(text, /last \d+/, 'the project section is the first to go')
})

test('an inbox request is never dropped: 20 long requests all appear by id within 400 tokens', () => {
	const { sb, hook } = busyTicket()
	const ids = Array.from({ length: 20 }, (_, i) => `req-${String(i).padStart(2, '0')}`)
	for (const id of ids) inboxFile(sb, id, `Please deal with ${id}: ${'the retry limit and the signature check on the webhook '.repeat(8)}`)
	const text = hookJson(hook())
	assert.ok(tokensOf(text) <= CAPS.brief, `${tokensOf(text)} tokens`)
	for (const id of ids) assert.ok(text.includes(`[${id}]`), `${id} is missing:\n${text}`)
	assert.match(text, /^WorkPulse Brain/)
})

test('inbox requests holding a checklist or newlines still fit 400 tokens with every id', () => {
	const { sb, hook } = busyTicket()
	const ids = Array.from({ length: 20 }, (_, i) => `chk-${String(i).padStart(2, '0')}`)
	for (const id of ids) inboxFile(sb, id, `Do these for ${id}:\n- [ ] check the retry limit on the webhook handler\n- [ ] compare the signatures\n- [ ] ${'write it up in detail '.repeat(10)}\n- [x] done already`)
	const text = hookJson(hook())
	assert.ok(tokensOf(text) <= CAPS.brief, `${tokensOf(text)} tokens`)
	for (const id of ids) assert.ok(text.includes(`[${id}]`), `${id} missing`)
})

test('a few inbox requests keep their text, and everything else goes first', () => {
	const { sb, hook } = busyTicket()
	for (const id of ['a1', 'a2', 'a3']) inboxFile(sb, id, `Request ${id} about the retry limit`)
	const text = hookJson(hook())
	for (const id of ['a1', 'a2', 'a3']) assert.match(text, new RegExp(`\\[${id}\\] PAY-77: Request ${id} about the retry limit`))
	assert.ok(tokensOf(text) <= CAPS.brief)
})

const savedPage = (sb, id, url) => {
	const dir = join(sb.clone, 'bridge', 'inbox', 'to-cli')
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, at: 1, from: 'extension', type: 'save-url', url, title: `Title ${id}`, text: `Save to Brain: ${url}` }))
}

const COUNT_LINE = /^Saved to read: 3 \(say "process my queue"\)$/m

test('the saved-pages count is one line inside the 400-token cap, and a busy brief cannot push it out', () => {
	const { sb, hook } = busyTicket()
	for (const id of ['s1', 's2', 's3']) savedPage(sb, id, `https://example.com/${id}`)
	for (const text of [hookJson(hook()), sb.run('brief', 'PAY-77', '--project', 'acme/payments-web').out]) {
		assert.ok(tokensOf(text) <= CAPS.brief, `${tokensOf(text)} tokens`)
		assert.match(text, COUNT_LINE)
		assert.equal(text.match(/Saved to read/g).length, 1)
		assert.doesNotMatch(text, /example\.com|Title s1/)
		assert.match(text.trimEnd(), /… \d+ more: wp-brain brief PAY-77 --project acme\/payments-web --full$/)
	}
	assert.match(sb.run('brief', 'PAY-77', '--project', 'acme/payments-web', '--full').out, COUNT_LINE)
})

test('the saved-pages count survives 20 long inbox requests, every id kept, within 400 tokens', () => {
	const { sb, hook } = busyTicket()
	const ids = Array.from({ length: 20 }, (_, i) => `r${i}`)
	for (const id of ids) inboxFile(sb, id, `Please deal with ${id}: ${'the retry limit and the signature check on the webhook '.repeat(8)}`)
	for (const id of ['s1', 's2', 's3']) savedPage(sb, id, `https://example.com/${id}`)
	const text = hookJson(hook())
	assert.ok(tokensOf(text) <= CAPS.brief, `${tokensOf(text)} tokens`)
	assert.match(text, COUNT_LINE)
	for (const id of ids) assert.match(text, new RegExp(`\\[${id}\\]`))
})

test('with room to spare every section shows, in the order inbox, ticket, follow-ups, repeats, learned, project', () => {
	const sb = brainSandbox()
	const repo = mkdtempSync(join(tmpdir(), 'wp-caps-repo-'))
	const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
	git('init', '-q', '-b', 'fix/pay-5-retry-webhook')
	git('remote', 'add', 'origin', 'https://github.com/acme/payments-web.git')
	add(sb, [
		{ kind: 'ticket', title: 'PAY-5 first look', ticket: 'PAY-5', project: 'acme/payments-web', status: 'wip', next: ['finish the retry'] },
		{ kind: 'mistake', title: 'Forgot the retry limit once', tags: ['limit'] },
		{ kind: 'mistake', title: 'Forgot the retry limit twice', tags: ['limit'] },
		{ kind: 'learning', title: 'Webhook retry needs idempotency keys #webhook', project: 'other/repo' },
		{ kind: 'debug', title: 'Project only note', project: 'acme/payments-web' },
	])
	inboxFile(sb, 'r1', 'Check the retry')
	const r = sb.runWith({ input: JSON.stringify({ session_id: 'x', cwd: repo }) }, 'hook')
	const text = hookJson(r)
	const order = [/Inbox/, /## PAY-5/, /Open follow-ups/, /acme\/payments-web: last/, /Learned before/, /keep coming back/].map((re) => text.search(re))
	assert.ok(order.every((n) => n >= 0), `a section is missing: ${order}\n${text}`)
	assert.deepEqual([...order].sort((a, b) => a - b), order)
	assert.doesNotMatch(text, /more: wp-brain brief/)
})

test('nudgeText is 400 tokens or fewer', async () => {
	const { nudgeText } = await import('./setup.mjs')
	assert.ok(tokensOf(nudgeText()) <= CAPS.brief, `${tokensOf(nudgeText())} tokens`)
})

// ── show ───────────────────────────────────────────────────────────────────

test('show prints the whole entry, and exits non-zero on an unknown id', () => {
	const sb = brainSandbox()
	add(sb, [{ kind: 'mistake', title: 'Webhook retry loop', ticket: 'PAY-9', rootCause: 'ROOTCAUSEHERE the handler retried forever', body: 'BODYHERE line one\nline two', next: ['NEXTHERE'], tags: ['webhook'] }])
	const id = sb.run('list').out.match(/\[(\w{8})\]/)[1]
	const r = sb.run('show', id)
	assert.equal(r.status, 0, r.err)
	for (const want of ['Webhook retry loop', 'PAY-9', 'ROOTCAUSEHERE', 'BODYHERE line one', 'line two', 'NEXTHERE']) assert.ok(r.out.includes(want), `${want} missing:\n${r.out}`)
	const bad = sb.run('show', 'zzzzzzzz')
	assert.notEqual(bad.status, 0)
	assert.match(bad.err, /No entry matches/)
	assert.notEqual(sb.run('show').status, 0)
})

// ── recall points at rules and skills ──────────────────────────────────────

const POINTER = /^- Read before acting: (\S+\.md) \(/gm
const asks = (sb, fx, prompt, session = 'rs', more = {}) =>
	sb.runWith({ CLAUDE_HOME: fx.claude, WP_BRAIN_RULE_INDEX: fx.index, input: JSON.stringify({ session_id: session, prompt, cwd: tmpdir() }), ...more }, 'recall')
const pointed = (r) => (r.out ? [...hookJson(r).matchAll(POINTER)].map((m) => m[1].split('/').at(-2) + '/' + m[1].split('/').at(-1)) : [])

test('recall: one lesson with a 3,000-character URL still shows its title, within 300 tokens, and is marked seen', () => {
	const sb = brainSandbox()
	add(sb, [QUOKKA(1, { source: { type: 'site', url: 'https://example.com/' + 'a'.repeat(3000) } })])
	sb.run('db', 'rebuild')
	const ask = () => sb.runWith({ input: JSON.stringify({ session_id: 'long-url', prompt: 'quokka handling gloves patience', cwd: tmpdir() }) }, 'recall')
	const text = hookJson(ask())
	assert.ok(tokensOf(text) <= CAPS.recall, `${tokensOf(text)} tokens`)
	assert.match(text, /Quokka handling gloves patience lesson number 1/)
	assert.doesNotMatch(text, /^WorkPulse[^\n]*\n… \d+ more[^\n]*$/)
	assert.match(text, /wp-brain show [0-9a-z]{8}/, 'a too long URL falls back to show')
	assert.equal(ask().out, '', 'the lesson was marked seen')
})

test('recall: a lesson with a URL that fits carries its id, a long Devanagari title is cut at a code point', () => {
	const sb = brainSandbox()
	add(sb, [{ kind: 'learning', title: 'कहानी की शुरुआत वादे से करें '.repeat(20) + '#हिंदी', tags: ['हिंदी'], source: { type: 'site', url: 'https://example.com/short' } }])
	sb.run('db', 'rebuild')
	const r = sb.runWith({ input: JSON.stringify({ session_id: 'dev', prompt: 'कहानी की शुरुआत वादे से करें', cwd: tmpdir() }) }, 'recall')
	const text = hookJson(r)
	assert.ok(tokensOf(text) <= CAPS.recall)
	assert.match(text, /https:\/\/example\.com\/short\) \[[0-9a-z]{8}\]/)
	assert.doesNotMatch(text, /\uFFFD/)
})

test('recall: a one-word prompt brings up the rule, a not phrase cancels it, and only a pointer is printed', () => {
	const sb = brainSandbox()
	const fx = claudeFixture()
	const r = asks(sb, fx, 'push')
	assert.equal(r.status, 0, r.err)
	assert.deepEqual(pointed(r), ['rule-files/git-push-rule.md'])
	assert.doesNotMatch(r.out, /RULEBODYTEXT|SKILLBODYTEXT/)
	assert.equal(asks(sb, fx, 'push notifications are late', 'other').out, '')
})

test('recall: a Flutter paywall prompt brings up the skill, dinner and slash commands bring up nothing', () => {
	const sb = brainSandbox()
	const fx = claudeFixture()
	linkedSkill(fx, 'linked-reel-voiceover', 'Voice over a reel with timed captions')
	assert.deepEqual(pointed(asks(sb, fx, 'the flutter paywall shows the wrong subscription price', 'a')), ['flutter-paywall-audit/SKILL.md'])
	assert.deepEqual(pointed(asks(sb, fx, 'add a voice over to the reel captions', 'b')), ['linked-reel-voiceover/SKILL.md'])
	assert.equal(asks(sb, fx, "what's for dinner", 'c').out, '')
	assert.equal(asks(sb, fx, '/flutter-paywall-audit the subscription paywall', 'd').out, '')
})

test('recall: 3 lessons and 2 rules stay within 300 tokens, and the rules survive the cap', () => {
	const sb = brainSandbox()
	const fx = claudeFixture()
	const url = 'https://example.com/' + 'quokka-handling-gloves/'.repeat(14)
	add(sb, [1, 2, 3].map((n) => QUOKKA(n, { source: { type: 'site', url: `${url}${n}` } })))
	sb.run('db', 'rebuild')
	const r = asks(sb, fx, 'quokka handling gloves patience: push the commit message', 'cap')
	const text = hookJson(r)
	assert.ok(tokensOf(text) <= CAPS.recall, `${tokensOf(text)} tokens`)
	assert.deepEqual(pointed(r), ['rule-files/git-push-rule.md', 'rule-files/commit-hygiene.md'])
	assert.match(text, /Quokka handling gloves/)
	assert.ok(text.indexOf('git-push-rule') < text.indexOf('Quokka'), 'rules come first')
	assert.doesNotMatch(text, /RULEBODYTEXT/)
})

test('recall: no rule map means the same output as before, even with skills on disk', () => {
	const sb = brainSandbox()
	const fx = claudeFixture({ map: false })
	add(sb, [QUOKKA(1)])
	sb.run('db', 'rebuild')
	const prompt = 'quokka handling gloves patience flutter paywall subscription push'
	const withSkills = asks(sb, fx, prompt, 's1')
	const bare = sb.runWith({ CLAUDE_HOME: join(fx.root, 'empty'), WP_BRAIN_RULE_INDEX: fx.index, input: JSON.stringify({ session_id: 's2', prompt, cwd: tmpdir() }) }, 'recall')
	assert.equal(withSkills.out, bare.out)
	assert.doesNotMatch(withSkills.out, /Read before acting/)
	assert.equal(asks(sb, fx, 'the flutter paywall subscription', 's3').out, '')
	assert.equal(existsSync(fx.index), false)
})

test('recall: a rule is shown once per session, again after a compact, and a lesson is not shown again', () => {
	const sb = brainSandbox()
	const fx = claudeFixture()
	add(sb, [QUOKKA(1)])
	sb.run('db', 'rebuild')
	const prompt = 'quokka handling gloves patience: push it'
	const first = asks(sb, fx, prompt, 'same')
	assert.deepEqual(pointed(first), ['rule-files/git-push-rule.md'])
	assert.match(first.out, /Quokka handling gloves/)
	assert.equal(asks(sb, fx, prompt, 'same').out, '', 'neither the rule nor the lesson repeats')
	assert.equal(asks(sb, fx, 'push', 'same').out, '')
	const compact = sb.runWith({ CLAUDE_HOME: fx.claude, WP_BRAIN_RULE_INDEX: fx.index, input: JSON.stringify({ session_id: 'same', source: 'compact', cwd: tmpdir() }) }, 'hook')
	assert.equal(compact.status, 0, compact.err)
	const again = asks(sb, fx, prompt, 'same')
	assert.deepEqual(pointed(again), ['rule-files/git-push-rule.md'])
	assert.doesNotMatch(again.out, /Quokka/, 'the lesson stays marked')
	// Another session is untouched by the compact of this one.
	assert.equal(asks(sb, fx, 'push', 'elsewhere').out !== '', true)
})

test('recall: a broken map or a broken skill does not stop the lessons, and doctor says so', () => {
	const sb = brainSandbox()
	const fx = claudeFixture()
	add(sb, [QUOKKA(1)])
	sb.run('db', 'rebuild')
	writeFileSync(fx.mapPath, '{ not json')
	mkdirSync(join(fx.claude, 'skills', 'bare'))
	writeFileSync(join(fx.claude, 'skills', 'bare', 'SKILL.md'), '# no frontmatter\n')
	const good = claudeFixture()
	const prompt = 'quokka handling gloves patience push the flutter paywall subscription'
	assert.match(hookJson(asks(sb, good, prompt, 'good')), /flutter-paywall-audit/, 'the same prompt points at a skill with a good map')
	const r = asks(sb, fx, prompt, 'broken')
	assert.equal(r.status, 0, r.err)
	assert.equal(r.err, '')
	assert.match(hookJson(r), /Quokka handling gloves/)
	assert.doesNotMatch(hookJson(r), /Read before acting/)
	assert.equal(existsSync(fx.index), false)
	const d = sb.runWith({ CLAUDE_HOME: fx.claude, WP_BRAIN_RULE_INDEX: fx.index }, 'doctor')
	assert.match(d.out, /! Rule map\s+.*(not valid JSON|cannot be read)/)
	const ok = claudeFixture()
	assert.match(sb.runWith({ CLAUDE_HOME: ok.claude, WP_BRAIN_RULE_INDEX: ok.index }, 'doctor').out, /✓ Rule map\s+2 rules/)
})

test('recall with 276 skills and a warm cache stays within the recall time budget', (t) => {
	const sb = brainSandbox()
	const fx = claudeFixture({ extra: 270 })
	add(sb, [QUOKKA(1)])
	sb.run('db', 'rebuild')
	const timed = (...args) => {
		const t = performance.now()
		const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8', input: JSON.stringify({ session_id: `t${Math.random()}`, prompt: 'quokka handling gloves patience push', cwd: tmpdir() }), env: { ...process.env, WP_BRAIN_CONFIG: sb.configPath, WP_BRAIN_SESSIONS: sb.sessions, WP_BRAIN_DB: sb.dbFile, CLAUDE_HOME: fx.claude, WP_BRAIN_RULE_INDEX: fx.index } })
		return { ms: performance.now() - t, ...r }
	}
	const first = timed('recall')
	assert.equal(first.status, 0, first.stderr)
	assert.ok(existsSync(fx.index))
	const start = Math.min(...[1, 2, 3].map(() => timed('help').ms))
	const warm = Math.min(...[1, 2, 3].map(() => timed('recall').ms))
	assert.match(timed('recall').stdout, /git-push-rule/)
	const BUDGET_MS = 500
	withinBudget(t, warm - start, BUDGET_MS, 'warm recall with 276 skills, beyond starting the CLI,')
})

test('the brief header has no blank name when there is no ticket and no remote', () => {
	const sb = brainSandbox()
	const repo = mkdtempSync(join(tmpdir(), 'wp-caps-repo-'))
	execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'fix/retry-webhook'], { stdio: 'ignore' })
	add(sb, [{ kind: 'learning', title: 'Retry the webhook with a fresh key', tags: ['retry'] }])
	const r = sb.runWith({ input: JSON.stringify({ session_id: 'sb', cwd: repo }) }, 'hook')
	assert.equal(r.status, 0, r.err)
	const text = hookJson(r)
	assert.match(text, /^WorkPulse Brain, recorded before \(read before planning\):/)
	assert.doesNotMatch(text, /for +\(/)
})

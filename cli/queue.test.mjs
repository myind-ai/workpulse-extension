// node --test cli/queue.test.mjs
// `wp-brain queue` against temp bare repos, temp configs and a local web server. Never the real Brain, never the network.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

import { ackOf, ownerOf, queueCountLine, queueRows, routeOf } from './queue.mjs'
import { CLI, brainSandbox } from './sandbox.mjs'

const WORDS = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ')

/** A local server counting requests: /a is an article, /b another, /empty has 2 words. */
async function withServer(fn, onHit = () => {}) {
	const hits = []
	const server = createServer((req, res) => {
		hits.push(req.url)
		onHit(req.url)
		res.setHeader('content-type', 'text/html')
		if (req.url === '/empty') return res.end('<html><head><title>Login</title></head><body><p>please login</p></body></html>')
		res.end(`<html><head><title>Page ${req.url}</title></head><body><article><h1>Page</h1><p>${WORDS(120)}</p></article></body></html>`)
	})
	await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
	try {
		return await fn(`http://127.0.0.1:${server.address().port}`, hits)
	} finally {
		server.close()
	}
}

/** Two devices (cli-test and cli-b) on one bare remote, and a way to post messages as the extension. */
function twoDevices() {
	const s = brainSandbox()
	const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
	const clone2 = join(s.root, 'clone-b')
	git('clone', '-q', s.remote, clone2)
	git('-C', clone2, 'config', 'user.email', 'b@example.com')
	git('-C', clone2, 'config', 'user.name', 'B')
	const configB = join(s.root, 'brain-b.json')
	writeFileSync(configB, JSON.stringify({ repo: 'test/brain', clone: clone2, device: 'cli-b' }))
	const learnRoot = join(s.root, 'learn')
	const env = { YT_LEARN_ROOT: learnRoot }
	const runA = (...a) => s.runWith(env, ...a)
	const runB = (...a) => s.runWith({ ...env, WP_BRAIN_CONFIG: configB, WP_BRAIN_DB: join(s.root, 'b.db') }, ...a)
	/** Like runA, without blocking this process: the local web server lives in it. */
	const arunWith = (more, ...a) =>
		new Promise((ok) => {
			const { input, ...extra } = more
			const p = spawn('node', [CLI, ...a], { env: { ...process.env, WP_BRAIN_REPO_VISIBILITY: 'private', WP_BRAIN_CONFIG: s.configPath, WP_BRAIN_SESSIONS: s.sessions, WP_BRAIN_DB: s.dbFile, ...env, ...extra } })
			let out = ''
			let err = ''
			p.stdout.on('data', (c) => (out += c))
			p.stderr.on('data', (c) => (err += c))
			p.on('close', (status) => ok({ status, out, err }))
			p.stdin.end(input ?? '')
		})
	const arunA = (...a) => arunWith({}, ...a)
	let n = 0
	/** As the extension: one message file in bridge/inbox/to-cli, pushed. */
	const post = (msg) => {
		n++
		const at = msg.at ?? 1_700_000_000_000 + n * 1000
		const id = msg.id ?? `m${n}`
		const m = { schema: 'workpulse.bridge.msg/1', id, at, from: 'extension', text: msg.text ?? `Save to Brain: ${msg.url}`, ...(msg.url ? { type: 'save-url', url: msg.url, title: msg.title ?? `T${n}` } : {}) }
		const rel = `bridge/inbox/to-cli/${new Date(at).toISOString().replace(/[:.]/g, '-')}-${id}.json`
		mkdirSync(join(s.clone, 'bridge/inbox/to-cli'), { recursive: true })
		writeFileSync(join(s.clone, rel), JSON.stringify(m))
		git('-C', s.clone, 'add', rel)
		git('-C', s.clone, 'commit', '-q', '-m', `msg ${id}`)
		git('-C', s.clone, 'pull', '-q', '--rebase')
		git('-C', s.clone, 'push', '-q', 'origin', 'HEAD:main')
		return id
	}
	const ackJson = (dev, id) => {
		try {
			return JSON.parse(git('-C', s.remote, 'show', `main:bridge/inbox/acks/${dev}/${id}.json`))
		} catch {
			return null
		}
	}
	return { ...s, git, clone2, runA, arunA, arunWith, runB, post, ackJson, learnRoot }
}

test('routeOf: youtube and instagram are video, the rest are sites', () => {
	for (const u of ['https://www.youtube.com/watch?v=a', 'https://youtu.be/a', 'https://m.youtube.com/watch?v=a', 'https://www.instagram.com/reel/x/']) assert.equal(routeOf(u), 'video', u)
	for (const u of ['https://example.com/post', 'https://notyoutube.com/a', 'https://example.com/?u=youtube.com', 'not a url']) assert.equal(routeOf(u), 'site', u)
})

test('ownerOf: earliest at, ties by device name; none for no acks', () => {
	assert.equal(ownerOf([]), null)
	assert.equal(ownerOf([{ at: 5, by: 'b' }, { at: 3, by: 'z' }]), 'z')
	assert.equal(ownerOf([{ at: 3, by: 'b' }, { at: 3, by: 'a' }]), 'a')
})

test('queueCountLine: one line, nothing at 0', () => {
	assert.equal(queueCountLine(0), null)
	assert.equal(queueCountLine(3), 'Saved to read: 3 (say "process my queue")')
})

test('queueRows: states, owner, route and the oldest first; asks are not rows', () => {
	const msgs = [
		{ id: 'b', at: 2, type: 'save-url', url: 'https://youtu.be/x', title: 'V' },
		{ id: 'a', at: 1, type: 'save-url', url: 'https://example.com/p', title: 'P' },
		{ id: 'c', at: 3, text: 'an ask' },
		{ id: 'd', at: 4, type: 'save-url', url: 'https://example.com/q', title: 'Q' },
	]
	const rows = queueRows(msgs, { d: [{ id: 'd', at: 9, by: 'dev1', state: 'failed', why: 'nope' }] }, 'dev2')
	assert.deepEqual(rows.map((r) => [r.id, r.state, r.owner, r.route]), [['a', 'waiting', null, 'site'], ['b', 'waiting', null, 'video'], ['d', 'failed', 'dev1', 'site']])
	assert.equal(rows[2].why, 'nope')
})

test('ackOf reads every device; no state counts as done', () => {
	const { clone } = brainSandbox()
	const put = (dev, id, body) => {
		mkdirSync(join(clone, 'bridge/inbox/acks', dev), { recursive: true })
		writeFileSync(join(clone, 'bridge/inbox/acks', dev, `${id}.json`), JSON.stringify(body))
	}
	put('a', 'x', { id: 'x', at: 5, by: 'a' })
	put('b', 'x', { id: 'x', at: 3, by: 'b', state: 'claimed' })
	put('b', 'y', { id: 'y', at: 3, by: 'b', state: 'failed', why: 'w' })
	assert.deepEqual(ackOf(clone, 'x').sort((p, q) => p.at - q.at), [{ id: 'x', at: 3, by: 'b', state: 'claimed' }, { id: 'x', at: 5, by: 'a', state: 'done' }])
	assert.deepEqual(ackOf(clone, 'y'), [{ id: 'y', at: 3, by: 'b', state: 'failed', why: 'w' }])
	assert.deepEqual(ackOf(clone, 'none'), [])
})

test('brief shows asks as today plus one count line holding no URL or title; hook is the same; none, no line', () => {
	const d = twoDevices()
	assert.doesNotMatch(d.runA('brief').out, /Saved to read/)
	d.post({ text: 'please check the PAY-1 retry' })
	for (const u of ['https://example.com/one', 'https://example.com/two', 'https://example.com/three']) d.post({ url: u, title: 'Secret Title Here' })
	const b = d.runA('brief')
	assert.equal(b.status, 0, b.err)
	assert.match(b.out, /## Inbox from the extension\n- \[m1\] please check the PAY-1 retry/)
	assert.equal(b.out.match(/Saved to read/g).length, 1)
	assert.match(b.out, /^Saved to read: 3 \(say "process my queue"\)$/m)
	assert.doesNotMatch(b.out, /example\.com|Secret Title|Save to Brain/)
	const i = d.runA('inbox')
	assert.match(i.out, /please check the PAY-1 retry/)
	assert.match(i.out, /Saved to read: 3/)
	assert.doesNotMatch(i.out, /example\.com|Secret Title/)
})

test('hook prints the same single count line', () => {
	const d = twoDevices()
	d.post({ url: 'https://example.com/one' })
	d.git('-C', d.clone, 'checkout', '-q', '-b', 'fix/pay-9-retry')
	const h = d.runWith({ YT_LEARN_ROOT: d.learnRoot, input: JSON.stringify({ cwd: d.clone, session_id: 's1' }) }, 'hook')
	assert.equal(h.status, 0, h.err)
	const text = JSON.parse(h.out).hookSpecificOutput.additionalContext
	assert.equal(text.match(/Saved to read/g).length, 1)
	assert.doesNotMatch(text, /example\.com/)
})

test('hook: when the count is all there is, it adds that one line and no header', () => {
	const d = twoDevices()
	d.post({ url: 'https://example.com/one' })
	d.git('-C', d.clone, 'checkout', '-q', '-b', 'fix/pay-9-retry')
	const h = d.runWith({ YT_LEARN_ROOT: d.learnRoot, input: JSON.stringify({ cwd: d.clone, session_id: 's1' }) }, 'hook')
	assert.equal(h.status, 0, h.err)
	assert.equal(JSON.parse(h.out).hookSpecificOutput.additionalContext, 'Saved to read: 1 (say "process my queue")')
})

test('hook: nothing known and nothing saved stays silent', () => {
	const d = twoDevices()
	d.git('-C', d.clone, 'checkout', '-q', '-b', 'fix/pay-9-retry')
	const h = d.runWith({ YT_LEARN_ROOT: d.learnRoot, input: JSON.stringify({ cwd: d.clone, session_id: 's1' }) }, 'hook')
	assert.equal(h.status, 0, h.err)
	assert.equal(h.out, '')
})

test('hook: with something known the header stays, and the count is still one line', () => {
	const d = twoDevices()
	d.post({ url: 'https://example.com/one' })
	d.git('-C', d.clone, 'checkout', '-q', '-b', 'fix/pay-9-retry')
	assert.equal(d.runA('add', 'learning', 'Retry budgets need a cap', '--ticket', 'PAY-9').status, 0)
	const h = d.runWith({ YT_LEARN_ROOT: d.learnRoot, input: JSON.stringify({ cwd: d.clone, session_id: 's1' }) }, 'hook')
	const text = JSON.parse(h.out).hookSpecificOutput.additionalContext
	assert.match(text, /^WorkPulse Brain, recorded before/)
	assert.match(text, /Retry budgets need a cap/)
	assert.equal(text.match(/Saved to read/g).length, 1)
})

test('no hook, recall, stop-check, brief, inbox or list fetches a page or shows a saved URL', async () => {
	const d = twoDevices()
	await withServer(async (base, hits) => {
		d.post({ url: `${base}/a`, title: 'Distinctive saved page' })
		d.git('-C', d.clone, 'checkout', '-q', '-b', 'fix/pay-9-retry')
		const input = JSON.stringify({ cwd: d.clone, session_id: 's1', prompt: 'distinctive saved page' })
		const h = await d.arunWith({ input }, 'hook')
		assert.equal(h.status, 0, h.err)
		assert.match(JSON.parse(h.out).hookSpecificOutput.additionalContext, /Saved to read: 1/)
		assert.doesNotMatch(h.out, /127\.0\.0\.1|Distinctive/)
		const r = await d.arunWith({ input }, 'recall')
		assert.doesNotMatch(r.out, /127\.0\.0\.1|Distinctive/i)
		// a commit after the hook, nothing recorded: stop-check now reaches its Brain lookup
		writeFileSync(join(d.clone, 'work.txt'), 'x')
		d.git('-C', d.clone, 'add', 'work.txt')
		d.git('-C', d.clone, 'commit', '-q', '-m', 'work')
		const sc = await d.arunWith({ input }, 'stop-check')
		assert.equal(sc.status, 0, sc.err)
		assert.match(sc.out, /PAY-9/, 'stop-check reached its listing path')
		assert.doesNotMatch(sc.out, /127\.0\.0\.1|Distinctive/)
		for (const cmd of ['brief', 'inbox']) assert.doesNotMatch((await d.arunWith({}, cmd)).out, /127\.0\.0\.1|Distinctive/)
		await d.arunWith({}, 'queue')
		await new Promise((ok) => setTimeout(ok, 200))
		assert.deepEqual(hits, [])
	})
})

test('a resumed claim that never reached the remote is pushed before anything is fetched', async () => {
	const d = twoDevices()
	await withServer(async (base, hits) => {
		d.post({ id: 'rp', url: `${base}/a`, title: 'Unpushed' })
		const hook = join(d.remote, 'hooks', 'pre-receive')
		writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
		const first = await d.arunA('queue', 'next')
		assert.notEqual(first.status, 0)
		assert.equal(d.ackJson('cli-test', 'rp'), null)
		rmSync(hook)
		const second = await d.arunA('queue', 'next')
		assert.equal(second.status, 0, second.err)
		assert.equal(JSON.parse(second.out.trim()).id, 'rp')
		assert.equal(d.ackJson('cli-test', 'rp').state, 'claimed')
		assert.deepEqual(hits, ['/a'])
	}, () => {})
})

test('queue lists waiting rows with ids; empty says so', () => {
	const d = twoDevices()
	assert.match(d.runA('queue').out, /Queue empty/)
	d.post({ id: 'abc', url: 'https://example.com/p', title: 'Pretty' })
	const q = d.runA('queue')
	assert.match(q.out, /\[abc\].*waiting.*https:\/\/example\.com\/p/)
	assert.match(q.out, /Pretty/)
})

test('queue next pushes a claimed ack before it fetches, then prints the saved page', async () => {
	const d = twoDevices()
	let atFetch = 'no request'
	await withServer(async (base, hits) => {
		const id = d.post({ id: 'mine', url: `${base}/a`, title: 'Mine' })
		const r = await d.arunA('queue', 'next')
		assert.equal(r.status, 0, r.err)
		const j = JSON.parse(r.out.trim())
		assert.equal(j.id, id)
		assert.equal(j.url, `${base}/a`)
		assert.equal(j.route, 'site')
		assert.equal(j.words, 121)
		assert.deepEqual(j.problems, [])
		assert.ok(existsSync(join(j.folder, 'article.md')))
		assert.deepEqual(hits, ['/a'])
		const ack = d.ackJson('cli-test', id)
		assert.equal(ack.state, 'claimed')
		assert.equal(ack.by, 'cli-test')
		assert.equal(atFetch.state, 'claimed', 'the claim was on the remote when the page was requested')
	}, () => (atFetch = d.ackJson('cli-test', 'mine')))
	assert.equal(d.runA('queue', 'done', 'mine').status, 0)
	const id = d.post({ url: 'http://127.0.0.1:1/never', title: 'Dead' })
	const r = await d.arunA('queue', 'next')
	assert.equal(r.status, 0, r.err)
	assert.equal(JSON.parse(r.out.trim()).failed, true)
	assert.equal(d.ackJson('cli-test', id).state, 'failed')
})

test('a YouTube and an Instagram URL print route video, with no folder, and nothing is fetched', async () => {
	await withServer(async (base, hits) => {
		const d = twoDevices()
		d.post({ id: 'yt', url: 'https://www.youtube.com/watch?v=abc', title: 'Video' })
		d.post({ id: 'ig', url: 'https://www.instagram.com/reel/xyz/', title: 'Reel' })
		const a = JSON.parse((await d.arunA('queue', 'next')).out.trim())
		assert.deepEqual([a.id, a.route, a.folder], ['yt', 'video', undefined])
		assert.equal(a.url, 'https://www.youtube.com/watch?v=abc')
		assert.equal(d.ackJson('cli-test', 'yt').state, 'claimed')
		// the claim is unfinished, so the same device gets it again; finish it, then the next
		assert.equal(JSON.parse(d.runA('queue', 'next').out.trim()).id, 'yt')
		assert.equal(d.runA('queue', 'done', 'yt').status, 0)
		const b = JSON.parse((await d.arunA('queue', 'next')).out.trim())
		assert.deepEqual([b.id, b.route, b.folder], ['ig', 'video', undefined])
		await new Promise((ok) => setTimeout(ok, 200))
		assert.deepEqual(hits, [])
		assert.equal(existsSync(d.learnRoot), false)
	})
})

test('a 2-word page fails with the reason, is not lost, the next call moves on, and retry brings it back', async () => {
	await withServer(async (base) => {
		const d = twoDevices()
		d.post({ id: 'bad', url: `${base}/empty`, title: 'Login wall' })
		d.post({ id: 'good', url: `${base}/a`, title: 'Fine' })
		const f = await d.arunA('queue', 'next')
		assert.equal(f.status, 0, f.err)
		const fj = JSON.parse(f.out.trim())
		assert.equal(fj.id, 'bad')
		assert.equal(fj.failed, true)
		assert.match(fj.why, /couldn't read this page \(login or JavaScript\?\)/)
		assert.match(f.err, /bad/)
		const ack = d.ackJson('cli-test', 'bad')
		assert.equal(ack.state, 'failed')
		assert.match(ack.why, /couldn't read this page/)
		assert.match(d.runA('queue').out, /\[bad\].*failed.*couldn't read this page/)
		assert.equal(JSON.parse((await d.arunA('queue', 'next')).out.trim()).id, 'good')
		// B can't retry A's failure; A can
		assert.notEqual(d.runB('queue', 'retry', 'bad').status, 0)
		assert.equal(d.runA('queue', 'retry', 'bad').status, 0)
		assert.equal(d.ackJson('cli-test', 'bad').state, 'claimed')
		assert.equal(d.ackJson('cli-test', 'bad').why, undefined)
	})
})

test('queue retry refuses a row that has not failed', () => {
	const d = twoDevices()
	d.post({ id: 'w', url: 'https://youtu.be/x' })
	assert.notEqual(d.runA('queue', 'retry', 'w').status, 0)
	assert.notEqual(d.runA('queue', 'retry', 'nope').status, 0)
})

test('two devices: B skips what A claimed; the earliest ack wins and the loser removes its own', () => {
	const d = twoDevices()
	d.post({ id: 'one', url: 'https://youtu.be/one' })
	d.post({ id: 'two', url: 'https://youtu.be/two' })
	assert.equal(JSON.parse(d.runA('queue', 'next').out.trim()).id, 'one')
	const b = JSON.parse(d.runB('queue', 'next').out.trim())
	assert.equal(b.id, 'two')
	assert.match(d.runB('queue').out, /\[one\].*claimed by cli-test/)
	assert.equal(d.ackJson('cli-b', 'one'), null)

	// A race: both claimed 'x' with B first by timestamp, before either pulled. A pushed its claim later.
	d.post({ id: 'x', url: 'https://youtu.be/x' })
	d.runB('queue', 'done', 'two')
	d.runA('queue', 'done', 'one')
	d.runA('queue', 'next') // A pulls x and claims it: it is the owner
	const early = join(d.clone2, 'bridge/inbox/acks/cli-b/x.json')
	// B writes a claim stamped earlier than A's, as if it had claimed first
	d.runB('sync')
	mkdirSync(join(d.clone2, 'bridge/inbox/acks/cli-b'), { recursive: true })
	writeFileSync(early, JSON.stringify({ id: 'x', at: 1, by: 'cli-b', state: 'claimed' }))
	d.git('-C', d.clone2, 'add', early)
	d.git('-C', d.clone2, 'commit', '-q', '-m', 'b claims x first')
	d.git('-C', d.clone2, 'pull', '-q', '--rebase')
	d.git('-C', d.clone2, 'push', '-q', 'origin', 'HEAD:main')
	// A's next call sees B is the true owner of x; it keeps no claim on it and has nothing else to do
	const r = JSON.parse(d.runA('queue', 'next').out.trim())
	assert.equal(r.empty, true)
	assert.equal(d.ackJson('cli-test', 'x'), null)
	assert.equal(d.ackJson('cli-b', 'x').state, 'claimed')
})

test('a claim that lost the race removes its own ack and moves on to the next URL', () => {
	const d = twoDevices()
	d.post({ id: 'p', url: 'https://youtu.be/p' })
	d.post({ id: 'q', url: 'https://youtu.be/q' })
	d.runB('sync')
	// While A's claim on p is being pushed, B gets an earlier claim on p onto the remote first.
	const rel = 'bridge/inbox/acks/cli-b/p.json'
	mkdirSync(join(d.clone2, 'bridge/inbox/acks/cli-b'), { recursive: true })
	writeFileSync(join(d.clone2, rel), JSON.stringify({ id: 'p', at: 1, by: 'cli-b', state: 'claimed' }))
	d.git('-C', d.clone2, 'add', rel)
	d.git('-C', d.clone2, 'commit', '-q', '-m', 'b claims p')
	const marker = join(d.root, 'raced')
	const hook = join(d.clone, '.git', 'hooks', 'pre-push')
	writeFileSync(hook, `#!/bin/sh\n[ -e "${marker}" ] && exit 0\n: > "${marker}"\nunset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE\ngit -C "${d.clone2}" push -q origin HEAD:main\n`, { mode: 0o755 })
	const r = d.runA('queue', 'next')
	assert.equal(r.status, 0, r.err)
	assert.equal(JSON.parse(r.out.trim()).id, 'q')
	assert.ok(existsSync(marker), 'the race ran')
	assert.equal(d.ackJson('cli-test', 'p'), null)
	assert.equal(d.ackJson('cli-b', 'p').state, 'claimed')
	assert.equal(d.ackJson('cli-test', 'q').state, 'claimed')
})

test('a row acknowledged by another device leaves this device count and list; an old-style ack counts as done', () => {
	const d = twoDevices()
	d.post({ id: 'old', url: 'https://example.com/old' })
	d.post({ id: 'new', url: 'https://example.com/new' })
	assert.match(d.runA('brief').out, /Saved to read: 2/)
	const rel = 'bridge/inbox/acks/cli-b/old.json'
	d.runB('sync')
	mkdirSync(join(d.clone2, 'bridge/inbox/acks/cli-b'), { recursive: true })
	writeFileSync(join(d.clone2, rel), JSON.stringify({ id: 'old', at: 5, by: 'cli-b' }))
	d.git('-C', d.clone2, 'add', rel)
	d.git('-C', d.clone2, 'commit', '-q', '-m', 'old-style ack')
	d.git('-C', d.clone2, 'push', '-q', 'origin', 'HEAD:main')
	const brief = d.runA('brief')
	assert.match(brief.out, /Saved to read: 1/)
	const list = d.runA('queue')
	assert.doesNotMatch(list.out, /\[old\]/)
	assert.match(list.out, /\[new\]/)
})

test('a session that died after claiming: the same device resumes, another device sees it claimed and leaves it', () => {
	const d = twoDevices()
	d.post({ id: 'a', url: 'https://youtu.be/a' })
	d.post({ id: 'b', url: 'https://youtu.be/b' })
	assert.equal(JSON.parse(d.runA('queue', 'next').out.trim()).id, 'a')
	// the session died: no done. Next call by A returns a again, not b.
	assert.equal(JSON.parse(d.runA('queue', 'next').out.trim()).id, 'a')
	assert.equal(d.ackJson('cli-test', 'b'), null)
	// B sees it stuck and does not take it
	assert.match(d.runB('queue').out, /\[a\].*claimed by cli-test/)
	assert.equal(JSON.parse(d.runB('queue', 'next').out.trim()).id, 'b')
	assert.match(d.runB('queue').out, /\[a\].*claimed by cli-test/)
	// B can't finish A's claim
	assert.notEqual(d.runB('queue', 'done', 'a').status, 0)
})

test('a secret-shaped message is listed as refused by id only, never printed and never fetched', async () => {
	await withServer(async (base, hits) => {
		const d = twoDevices()
		const token = 'ghp_' + 'a'.repeat(30)
		d.post({ id: 'sec', url: `${base}/a?x=${token}`, title: 'Leaky' })
		const q = await d.arunA('queue')
		assert.match(q.out, /\[sec\] refused/)
		assert.doesNotMatch(q.out + q.err, new RegExp(token))
		assert.doesNotMatch(q.out, /127\.0\.0\.1|Leaky/)
		const n = JSON.parse((await d.arunA('queue', 'next')).out.trim())
		assert.equal(n.empty, true)
		assert.doesNotMatch((await d.arunA('brief')).out, /Saved to read/)
		await new Promise((ok) => setTimeout(ok, 200))
		assert.deepEqual(hits, [])
		assert.equal(d.ackJson('cli-test', 'sec'), null)
	})
})

test('a state change keeps the first at, so ownership does not move', () => {
	const d = twoDevices()
	d.post({ id: 'k', url: 'https://youtu.be/k' })
	d.runA('queue', 'next')
	const first = d.ackJson('cli-test', 'k').at
	assert.ok(first > 0)
	d.runA('queue', 'done', 'k', '--lessons', '3')
	const done = d.ackJson('cli-test', 'k')
	assert.equal(done.state, 'done')
	assert.equal(done.at, first)
	assert.equal(done.lessons, 3)
	d.post({ id: 'm', url: 'https://youtu.be/m' })
	d.runA('queue', 'next')
	const at = d.ackJson('cli-test', 'm').at
	d.runA('queue', 'fail', 'm', '--why', 'no captions')
	const failed = d.ackJson('cli-test', 'm')
	assert.deepEqual([failed.state, failed.why, failed.at], ['failed', 'no captions', at])
	d.runA('queue', 'retry', 'm')
	assert.equal(d.ackJson('cli-test', 'm').at, at)
})

test('queue fail needs a reason; queue done and fail refuse a row this device does not own', () => {
	const d = twoDevices()
	d.post({ id: 'r', url: 'https://youtu.be/r' })
	assert.notEqual(d.runA('queue', 'fail', 'r', '--why', 'x').status, 0) // not claimed yet
	d.runA('queue', 'next')
	assert.notEqual(d.runA('queue', 'fail', 'r').status, 0)
	assert.notEqual(d.runB('queue', 'done', 'r').status, 0)
	assert.equal(d.runA('queue', 'fail', 'r', '--why', 'no captions').status, 0)
})

test('queue with an unknown subcommand says what exists', () => {
	const d = twoDevices()
	const r = d.runA('queue', 'bogus')
	assert.notEqual(r.status, 0)
	assert.match(r.err, /next/)
})

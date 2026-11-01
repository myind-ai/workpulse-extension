import { beforeEach, describe, expect, it, vi } from 'vitest'

import { memoryKV, Store } from '@/lib/store'
import type { ZohoClient } from '@/lib/zoho'

import { Commands } from './bridge-commands'
import { DayCommands } from './commands'
import { Engine, type Ui } from './engine'

// What GitHub was asked to write, and whether it is reachable.
const remote = vi.hoisted(() => ({
	files: {} as Record<string, string>,
	commits: [] as string[][],
	down: false,
	/** What treeIfChanged answers; null = 304. */
	tree: null as { etag?: string; truncated?: boolean; files: { path: string; sha: string }[] } | null,
	etagsAsked: [] as (string | undefined)[],
	blobs: {} as Record<string, string>,
	blobReads: [] as string[],
	/** Blob shas whose read throws once, then answers. */
	blobFailOnce: new Set<string>(),
}))
vi.mock('@/lib/github', () => ({
	GitHub: class {
		async read(path: string) {
			if (remote.down) throw new Error('offline')
			return path in remote.files ? { text: remote.files[path], sha: 'x' } : null
		}
		async commit(files: { path: string; content: string }[]) {
			if (remote.down) throw new Error('offline')
			remote.commits.push(files.map((f) => f.path))
			for (const f of files) remote.files[f.path] = f.content
		}
		async treeIfChanged(etag?: string) {
			remote.etagsAsked.push(etag)
			if (remote.down) throw new Error('offline')
			if (remote.tree && etag && etag === remote.tree.etag) return null
			return remote.tree ? { truncated: false, ...remote.tree } : null
		}
		async readBlob(sha: string) {
			remote.blobReads.push(sha)
			if (remote.blobFailOnce.delete(sha)) throw new Error('blob hiccup')
			return sha in remote.blobs ? remote.blobs[sha] : null
		}
	},
}))

let store: Store
let cmd: Commands
const clock = Date.UTC(2026, 9, 27, 6)

beforeEach(() => {
	remote.files = {}
	remote.commits = []
	remote.down = false
	remote.tree = null
	remote.etagsAsked = []
	remote.blobs = {}
	remote.blobReads = []
	remote.blobFailOnce = new Set()
	store = new Store(memoryKV())
	const ui = { changed() {}, currentPage: async () => null } as unknown as Ui
	const zoho = {} as unknown as ZohoClient
	cmd = new Commands(new Engine({ store, zoho, now: () => clock, idleSecs: async () => 0, ui }), zoho)
})

const connect = async () => {
	await store.saveSettings({ syncRepo: 'me/notes', syncBranch: 'brain' })
	await store.saveSyncToken('github_pat_test')
}

describe('saving to the Brain', () => {
	it('writes this browser’s entry line and its own record, in one commit, all under bridge/', async () => {
		await connect()
		const e = await cmd.saveContext({ title: 'Retry fix half done', next: 'Add the two-retry test', page: { title: 'PAY-2433 Webhook retry - Jira', url: 'https://acme.atlassian.net/browse/PAY-2433' } })
		expect(e).toMatchObject({ ticket: 'PAY-2433', next: ['Add the two-retry test'], links: { urls: ['https://acme.atlassian.net/browse/PAY-2433'] } })
		expect(e.queued).toBeUndefined()
		expect(remote.commits).toHaveLength(1)
		const [paths] = remote.commits
		expect(paths).toHaveLength(2)
		expect(paths.every((p) => p.startsWith('bridge/'))).toBe(true)
		expect(paths.some((p) => p.includes(`/${e.device}/`))).toBe(true)
		expect((await cmd.bridge()).open[0]).toMatchObject({ key: 'PAY-2433', next: ['Add the two-retry test'] })
	})

	it('keeps it here with no repository, and sends it once there is one', async () => {
		const e = await cmd.saveContext({ title: 'Decided to use a queue', kind: 'decision' })
		expect(e.queued).toBe(true)
		expect(remote.commits).toHaveLength(0)
		expect((await cmd.bridge()).queued).toBe(1)
		expect((await cmd.bridge()).entries.map((x) => x.id)).toContain(e.id)
		await connect()
		await cmd.pollBridge()
		expect(remote.commits).toHaveLength(1)
		expect((await cmd.bridge()).queued).toBe(0)
	})

	it('keeps it here when GitHub cannot be reached, and says why', async () => {
		await connect()
		remote.down = true
		const e = await cmd.saveContext({ title: 'Debugging the retry' })
		expect(e.queued).toBe(true)
		const view = await cmd.bridge()
		expect(view.queued).toBe(1)
		expect(view.error).toContain('not sent yet')
		remote.down = false
		await cmd.saveContext({ title: 'Second one' })
		expect(remote.commits).toHaveLength(1)
		expect(remote.commits[0].filter((p) => p.includes('/records/'))).toHaveLength(2)
		expect((await cmd.bridge()).queued).toBe(0)
	})

	it('refuses a title shaped like a secret, and saves nothing', async () => {
		await expect(cmd.saveContext({ title: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789' })).rejects.toThrow()
		expect((await cmd.bridge()).queued).toBe(0)
	})

	it('finds a Brain entry in the one search', async () => {
		await connect()
		await cmd.saveContext({ title: 'Idempotency key reused on retry', next: 'write the test' })
		const { hits } = await cmd.findAll('idempotency')
		expect(hits.find((h) => h.kind === 'brain')).toBeTruthy()
	})
})

describe('filters and the page you are on', () => {
	beforeEach(async () => {
		await connect()
		await cmd.saveContext({ title: 'Retry fix half done', kind: 'debug', next: 'Run the two-retry test', page: { title: 'PAY-2433 - Jira', url: 'https://acme.atlassian.net/browse/PAY-2433' } })
		await cmd.saveContext({ title: 'Picked a queue for retries', kind: 'decision', ticket: 'PAY-9' })
	})

	it('a filter makes the one search the Brain’s, and filters alone list what passes', async () => {
		expect((await cmd.findAll('queue type:decision')).hits.map((h) => h.text)).toEqual(['Picked a queue for retries'])
		expect((await cmd.findAll('has:next-action')).hits.map((h) => h.text)).toEqual(['Retry fix half done'])
		expect((await cmd.findAll('ticket:PAY-404')).hits).toEqual([])
	})

	it('names the records for a Jira page, and nothing for an unrelated one', async () => {
		const r = await cmd.relatedContext('https://acme.atlassian.net/browse/PAY-2433?focused=1')
		expect(r).toMatchObject({ keys: ['PAY-2433'], total: 1 })
		expect(r.entries[0]).toMatchObject({ title: 'Retry fix half done', why: 'link' })
		expect((await cmd.relatedContext('https://example.com/')).total).toBe(0)
	})
})

describe('update check', () => {
	beforeEach(() => vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ version: '1.3.0' }), reload: vi.fn() } }))
	const release = (v: string) => ({ ok: true, json: async () => ({ tag_name: `v${v}`, html_url: `https://github.com/r/releases/tag/v${v}`, body: '- New', assets: [{ browser_download_url: `https://x/workpulse-extension-${v}-chrome.zip` }] }) })
	const current = () => chrome.runtime.getManifest().version

	it('asks GitHub once a day, and Check now asks again', async () => {
		const fetchFn = vi.fn(async () => release('99.0.0'))
		vi.stubGlobal('fetch', fetchFn)
		expect((await cmd.checkForUpdate())?.version).toBe('99.0.0')
		await cmd.checkForUpdate()
		expect(fetchFn).toHaveBeenCalledTimes(1)
		await cmd.checkForUpdate(true)
		expect(fetchFn).toHaveBeenCalledTimes(2)
		const u = await cmd.updateState()
		expect(u).toMatchObject({ current: current(), latest: { version: '99.0.0' }, on: true, storeInstall: false })
		expect(u.command).toContain('update.sh | bash')
		vi.unstubAllGlobals()
	})

	it('does nothing for a Web Store install, which Chrome updates itself', async () => {
		const fetchFn = vi.fn(async () => release('99.0.0'))
		vi.stubGlobal('fetch', fetchFn)
		vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ version: '1.3.0', update_url: 'https://clients2.google.com/service/update2/crx' }) } })
		await cmd.checkForUpdate(true)
		expect(fetchFn).not.toHaveBeenCalled()
		expect((await cmd.updateState()).storeInstall).toBe(true)
		vi.unstubAllGlobals()
	})

	it('stays quiet when GitHub fails, unless asked', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })))
		expect(await cmd.checkForUpdate()).toBeNull()
		expect((await cmd.updateState()).error).toContain('403')
		await expect(cmd.checkForUpdate(true)).rejects.toThrow('403')
		vi.unstubAllGlobals()
	})

	it('does not ask when switched off, and Not now is for that version only', async () => {
		const fetchFn = vi.fn(async () => release('99.0.0'))
		vi.stubGlobal('fetch', fetchFn)
		await store.saveSettings({ updateCheck: false })
		await cmd.checkForUpdate()
		expect(fetchFn).not.toHaveBeenCalled()
		await cmd.checkForUpdate(true)
		await cmd.dismissUpdate('99.0.0')
		expect((await cmd.updateState()).dismissed).toBe('99.0.0')
		vi.unstubAllGlobals()
	})
})

describe('managing what was saved', () => {
	beforeEach(connect)

	it('edits, archives, restores and deletes with one-line changes in this browser’s own file', async () => {
		const e = await cmd.bridgeAdd({ kind: 'learning', scope: 'work', title: 'Keys per HTTP attempt #retry' })
		await cmd.bridgeAmend(e.id, { set: { title: 'Keys per logical operation, not per attempt', tags: ['retry', 'payments'] } })
		let view = await cmd.bridge()
		expect(view.entries).toHaveLength(1)
		expect(view.entries[0]).toMatchObject({ id: e.id, title: 'Keys per logical operation, not per attempt', tags: ['retry', 'payments'] })
		// Every write went to this browser's own entries file (and the first one's record); nothing else.
		expect(new Set(remote.commits.flat().filter((p) => p.includes('/entries/'))).size).toBe(1)
		expect(remote.commits[1]).toHaveLength(1)

		await cmd.bridgeAmend(e.id, { state: 'archived' })
		view = await cmd.bridge()
		expect(view.entries).toHaveLength(0)
		expect(view.archived.map((x) => x.id)).toEqual([e.id])
		expect((await cmd.findAll('logical operation')).hits.filter((h) => h.kind === 'brain')).toHaveLength(0)

		await cmd.bridgeAmend(e.id, { state: 'active' })
		expect((await cmd.bridge()).entries).toHaveLength(1)
		await cmd.bridgeAmend(e.id, { state: 'deleted' })
		view = await cmd.bridge()
		expect([view.entries.length, view.archived.length]).toEqual([0, 0])
	})

	it('does not save the same learning twice, and points at the one there is', async () => {
		const first = await cmd.bridgeAdd({ kind: 'learning', scope: 'work', title: 'Guard at the server #idempotency' })
		const again = await cmd.bridgeAdd({ kind: 'learning', scope: 'work', title: 'guard at the server.' })
		expect(again).toMatchObject({ id: first.id, duplicate: true })
		expect(remote.commits).toHaveLength(1)
		expect((await cmd.bridgeAdd({ kind: 'mistake', scope: 'work', title: 'Guard at the server' })).duplicate).toBeUndefined()
	})

	it('refuses an empty title or no change, and an entry it does not know', async () => {
		const e = await cmd.bridgeAdd({ kind: 'note', scope: 'work', title: 'A note' })
		await expect(cmd.bridgeAmend(e.id, { set: { title: '  ' } })).rejects.toThrow('empty')
		await expect(cmd.bridgeAmend(e.id, {})).rejects.toThrow('Nothing to change')
		await expect(cmd.bridgeAmend('e_nope', { state: 'archived' })).rejects.toThrow('not here')
	})

	it('applies an edit made offline at once, and sends it later', async () => {
		const e = await cmd.bridgeAdd({ kind: 'note', scope: 'work', title: 'Before' })
		remote.down = true
		expect((await cmd.bridgeAmend(e.id, { set: { title: 'After' } })).queued).toBe(true)
		expect((await cmd.bridge()).entries[0].title).toBe('After')
		remote.down = false
		await cmd.pollBridge()
		expect((await cmd.bridge()).queued).toBe(0)
		expect((await cmd.bridge()).entries[0].title).toBe('After')
	})
})

describe('Claude Code work-log restore', () => {
	it('imports once normally, and imports again after its local row was restored away', async () => {
		const from = clock - 30 * 60_000
		const file = { 'bridge/worklogs/2026-10/cli-a.jsonl': JSON.stringify({ schema: 'workpulse.worklog/1', id: 'claude-1', from, to: clock - 60_000, text: 'Claude Code work · payments', jobId: 'job-1' }) }
		expect(await (cmd as any).importWorklogs(file, clock)).toBe(1)
		const date = new Date(from).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
		const first = await store.entries(date)
		expect(first).toHaveLength(1)
		expect(first[0]).toMatchObject({ bridgeWorklogId: 'claude-1', auto: true, jobId: 'job-1' })
		expect(await (cmd as any).importWorklogs(file, clock)).toBe(0)
		await store.setEntries(date, [])
		expect(await (cmd as any).importWorklogs(file, clock)).toBe(1)
		expect(await store.entries(date)).toHaveLength(1)
	})
})

describe('a real poll imports Claude Code work logs', () => {
	const wl = (id: string, from: number) => JSON.stringify({ schema: 'workpulse.worklog/1', id, from, to: from + 20 * 60_000, text: `Claude Code work ${id}` })
	const path = 'bridge/worklogs/2026-10/cli-a.jsonl'
	const date = new Date(clock - 3 * 3_600_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
	const base = clock - 3 * 3_600_000
	const rows = async () => (await store.entries(date)).filter((e) => e.bridgeWorklogId)

	it('adds one auto row, none on the same sha, one more for one more line, and keeps it when the file goes', async () => {
		await connect()
		remote.files[path] = wl('w1', base)
		remote.tree = { etag: '"a"', files: [{ path, sha: 's1' }] }
		await cmd.pollBridge(true)
		expect(await rows()).toHaveLength(1)
		expect((await rows())[0]).toMatchObject({ bridgeWorklogId: 'w1', auto: true })
		await cmd.pollBridge(true)
		expect(await rows()).toHaveLength(1)
		remote.files[path] = `${wl('w1', base)}\n${wl('w2', base + 30 * 60_000)}`
		remote.tree = { etag: '"b"', files: [{ path, sha: 's2' }] }
		await cmd.pollBridge(true)
		expect((await rows()).map((e) => e.bridgeWorklogId).sort()).toEqual(['w1', 'w2'])
		// The work log is not a Brain entry, a device or a count.
		const b = await cmd.bridge()
		expect(b.entries).toHaveLength(0)
		expect(b.devices).toEqual([])
		remote.tree = { etag: '"c"', files: [] }
		await cmd.pollBridge(true)
		expect(await rows()).toHaveLength(2)
	})
})

describe('a work log the person deleted', () => {
	const wl = (id: string, from: number) => JSON.stringify({ schema: 'workpulse.worklog/1', id, from, to: from + 20 * 60_000, text: `Claude Code work ${id}` })
	const path = 'bridge/worklogs/2026-10/cli-a.jsonl'
	const base = clock - 3 * 3_600_000
	const date = new Date(base).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
	const rows = async () => (await store.entries(date)).filter((e) => e.bridgeWorklogId)
	const ids = async () => (await rows()).map((e) => e.bridgeWorklogId).sort()
	const uidOf = async (id: string) => (await rows()).find((e) => e.bridgeWorklogId === id)!.uid
	/** The two rows imported, ready for a later poll to change the tree. */
	const imported = async () => {
		await connect()
		remote.files[path] = `${wl('w1', base)}\n${wl('w2', base + 30 * 60_000)}`
		remote.tree = { etag: '"a"', files: [{ path, sha: 's1' }] }
		await cmd.pollBridge(true)
		expect(await ids()).toEqual(['w1', 'w2'])
	}
	/** Any CLI commit: the tree moves, and the work-log file is walked again. */
	const anotherCommit = async (tag: string) => {
		remote.tree = { etag: `"${tag}"`, files: [{ path, sha: 's1' }, { path: `bridge/entries/2026-10/${tag}.jsonl`, sha: tag }] }
		remote.files[`bridge/entries/2026-10/${tag}.jsonl`] = ''
		await cmd.pollBridge(true)
	}

	it('does not come back after the Review page deletes it, and the other row stays', async () => {
		await imported()
		await cmd.deleteEntry(date, await uidOf('w1'))
		expect(await ids()).toEqual(['w2'])
		await anotherCommit('b')
		expect(await ids()).toEqual(['w2'])
		// Even when the file itself moves.
		remote.files[path] = `${wl('w1', base)}\n${wl('w2', base + 30 * 60_000)}\n${wl('w3', base + 60 * 60_000)}`
		remote.tree = { etag: '"c"', files: [{ path, sha: 's2' }] }
		await cmd.pollBridge(true)
		expect(await ids()).toEqual(['w2', 'w3'])
	})

	it('does not come back after the older delete command either', async () => {
		await imported()
		await DayCommands.prototype.deleteEntry.call(cmd, date, await uidOf('w1'))
		await anotherCommit('b')
		expect(await ids()).toEqual(['w2'])
	})

	it('does not come back after the day is cleared', async () => {
		await imported()
		// This test's stand-in `ui` has no reminder window to hide; only the entries matter here.
		const engine = (cmd as unknown as { engine: { clearPending: () => Promise<void> } }).engine
		engine.clearPending = async () => undefined
		await cmd.clearDay(date)
		await anotherCommit('b')
		expect(await ids()).toEqual([])
	})

	it('a restore still brings back what was not dismissed, and only that', async () => {
		await imported()
		await cmd.deleteEntry(date, await uidOf('w1'))
		await store.setEntries(date, [])
		await anotherCommit('b')
		expect(await ids()).toEqual(['w2'])
	})

	it('deleting a row that did not come from a work log records nothing', async () => {
		await connect()
		await cmd.addManualEntry({ date, from: '10:00', to: '11:00', text: 'Wrote it by hand' })
		await cmd.deleteEntry(date, (await store.entries(date))[0].uid)
		expect((await store.runtime()).bridge?.dismissedWorklogs ?? []).toEqual([])
	})

	it('keeps the newest 2,000 dismissed ids, like the imported list', async () => {
		await imported()
		await store.updateRuntime((r) => void (r.bridge = { ...r.bridge, dismissedWorklogs: Array.from({ length: 2000 }, (_, i) => `old-${i}`) }))
		await cmd.deleteEntry(date, await uidOf('w1'))
		const list = (await store.runtime()).bridge!.dismissedWorklogs!
		expect(list).toHaveLength(2000)
		expect(list.at(-1)).toBe('w1')
		expect(list).not.toContain('old-0')
	})
})

describe('a Brain file that cannot be read during a poll', () => {
	const path = 'bridge/entries/2026-10/cli-a.jsonl'
	const line = (id: string) => JSON.stringify({ schema: 'workpulse.bridge.entry/1', id, at: clock, device: 'cli-a', kind: 'learning', scope: 'work', title: `Lesson ${id}`, tags: [] })

	it('keeps the old text, does not record the sha, and the next normal poll tries again', async () => {
		await connect()
		remote.files[path] = line('one')
		remote.tree = { etag: '"a"', files: [{ path, sha: 's1' }] }
		await cmd.pollBridge(true)
		expect((await cmd.bridge()).entries.map((e) => e.id)).toEqual(['one'])
		// The file moved, and this read answers nothing.
		delete remote.files[path]
		remote.tree = { etag: '"b"', files: [{ path, sha: 's2' }] }
		await cmd.pollBridge(true)
		expect((await cmd.bridge()).entries.map((e) => e.id)).toEqual(['one'])
		expect((await store.runtime()).bridge?.shas?.[path]).toBeUndefined()
		// Same tree, a normal poll: without this it answers 304 and the file stays stale for good.
		remote.files[path] = `${line('one')}\n${line('two')}`
		await cmd.pollBridge()
		expect(remote.etagsAsked.at(-1)).toBeUndefined()
		expect((await cmd.bridge()).entries.map((e) => e.id).sort()).toEqual(['one', 'two'])
		expect((await store.runtime()).bridge?.shas?.[path]).toBe('s2')
		// Read at last: the ETag is back, and the next look is a 304.
		await cmd.pollBridge()
		expect(remote.etagsAsked.at(-1)).toBe('"b"')
	})
})

describe('the library, read from the tree', () => {
	const lib = (p: string, sha: string) => ({ path: `bridge/library/${p}`, sha })
	const tree = (extra: { path: string; sha: string }[] = [], more: Record<string, unknown> = {}) => ({
		etag: '"e1"',
		files: [lib('youtube/a/notes.md', 'n1'), lib('youtube/a/meta.json', 'm1'), lib('youtube/a/.owner', 'o1'), { path: 'bridge/entries/2026-10/cli-a.jsonl', sha: 'j1' }, ...extra],
		...more,
	})
	beforeEach(() => {
		remote.files['bridge/entries/2026-10/cli-a.jsonl'] = ''
	})

	it('stores meta only, never file text, and nothing from the library in changedFiles', async () => {
		await connect()
		remote.tree = tree()
		remote.blobs.m1 = JSON.stringify({ title: 'Idempotency', channel: 'Ch', words: 9 })
		await cmd.pollBridge()
		expect((await store.runtime()).bridge?.library?.[0].title).toBeUndefined()
		await cmd.bridgeLibrary()
		const rt = await store.runtime()
		expect(rt.bridge?.library).toHaveLength(1)
		expect(rt.bridge?.library?.[0]).toMatchObject({ path: 'bridge/library/youtube/a', title: 'Idempotency', by: 'Ch', words: 9 })
		expect(Object.keys(rt.bridge?.files ?? {}).some((p) => p.startsWith('bridge/library/'))).toBe(false)
		expect(Object.keys(rt.bridge?.shas ?? {}).some((p) => p.startsWith('bridge/library/'))).toBe(false)
		expect(JSON.stringify(rt.bridge)).not.toContain('# notes text')
	})

	it('after an upgrade with an ETag and no library, asks without If-None-Match, then uses the ETag again', async () => {
		await connect()
		remote.tree = tree()
		await store.updateRuntime((r) => void (r.bridge = { ...r.bridge, etag: '"e1"' }))
		await cmd.pollBridge()
		expect(remote.etagsAsked).toEqual([undefined])
		expect((await store.runtime()).bridge?.library).toHaveLength(1)
		await cmd.pollBridge()
		expect(remote.etagsAsked).toEqual([undefined, '"e1"'])
	})

	it('a truncated tree keeps known entry files and says so', async () => {
		await connect()
		remote.tree = tree()
		await cmd.pollBridge()
		const before = (await store.runtime()).bridge
		expect(Object.keys(before?.files ?? {})).toContain('bridge/entries/2026-10/cli-a.jsonl')
		remote.tree = { etag: '"e2"', truncated: true, files: [lib('youtube/b/notes.md', 'n2')] }
		await cmd.pollBridge()
		const rt = (await store.runtime()).bridge
		expect(rt?.truncated).toBe(true)
		expect(Object.keys(rt?.files ?? {})).toContain('bridge/entries/2026-10/cli-a.jsonl')
		expect(rt?.library?.map((i) => i.path).sort()).toEqual(['bridge/library/youtube/a', 'bridge/library/youtube/b'])
		remote.tree = { etag: '"e3"', files: [lib('youtube/b/notes.md', 'n2')] }
		await cmd.pollBridge(true)
		expect((await store.runtime()).bridge?.truncated).toBe(false)
	})

	it('bridgeLibrary fills in at most 30 missing metas per call', async () => {
		await connect()
		const files = Array.from({ length: 35 }, (_, i) => lib(`youtube/f${i}/meta.json`, `m${i}`))
		for (const f of files) remote.blobs[f.sha] = JSON.stringify({ title: `T${f.sha}` })
		remote.tree = { etag: '"e1"', files }
		await cmd.pollBridge()
		const first = await cmd.bridgeLibrary()
		expect(first.items.filter((i) => i.metaSha)).toHaveLength(30)
		expect(first.ready).toBe(true)
		const second = await cmd.bridgeLibrary()
		expect(second.items.filter((i) => i.metaSha)).toHaveLength(35)
	})

	it('bridgeLibraryFile reads through the blob, refuses unknown paths and names outside the allowlist', async () => {
		await connect()
		remote.tree = tree()
		await cmd.pollBridge()
		remote.blobs.n1 = '# notes — text'
		expect(await cmd.bridgeLibraryFile('bridge/library/youtube/a', 'notes.md')).toEqual({ text: '# notes — text', sha: 'n1' })
		expect(remote.blobReads).toEqual(['n1'])
		await expect(cmd.bridgeLibraryFile('bridge/library/youtube/zzz', 'notes.md')).rejects.toThrow()
		await expect(cmd.bridgeLibraryFile('bridge/library/youtube/a', '.owner')).rejects.toThrow()
		await expect(cmd.bridgeLibraryFile('bridge/library/youtube/a', '../../entries/x.jsonl')).rejects.toThrow()
		await expect(cmd.bridgeLibraryFile('bridge/library/youtube/a', 'transcript.md')).rejects.toThrow()
	})

	it('the one search finds library titles, honours source: and gives none for a ticket filter', async () => {
		await connect()
		remote.tree = { etag: '"e1"', files: [lib('youtube/a/meta.json', 'm1'), lib('youtube/a/notes.md', 'n1'), lib('site/b/meta.json', 'm2'), { path: 'bridge/entries/2026-10/cli-a.jsonl', sha: 'j1' }] }
		remote.blobs.m1 = JSON.stringify({ title: 'Idempotency deep dive', channel: 'Ch' })
		remote.blobs.m2 = JSON.stringify({ title: 'Idempotency in articles' })
		remote.blobs.n1 = 'only inside the notes: zebra'
		remote.files['bridge/entries/2026-10/cli-a.jsonl'] = JSON.stringify({ schema: 'workpulse.bridge.entry/1', id: 'l1', at: clock, device: 'cli-a', kind: 'learning', scope: 'work', title: 'Idempotency lesson from a video', source: { type: 'youtube', url: 'https://youtu.be/x' } })
		await cmd.pollBridge()
		await cmd.bridgeLibrary()
		const all = (await cmd.findAll('idempotency')).hits
		expect(all.filter((h) => h.kind === 'library').map((h) => h.hash)).toEqual(expect.arrayContaining([`#/library/${encodeURIComponent('bridge/library/youtube/a')}`, `#/library/${encodeURIComponent('bridge/library/site/b')}`]))
		const yt = (await cmd.findAll('idempotency source:youtube')).hits
		expect(yt.filter((h) => h.kind === 'library').map((h) => h.text)).toEqual(['Idempotency deep dive'])
		expect((await cmd.findAll('source:youtube')).hits.filter((h) => h.kind === 'library')).toHaveLength(1)
		expect(yt.some((h) => h.kind === 'brain')).toBe(true)
		expect((await cmd.findAll('ticket:PAY-1')).hits.filter((h) => h.kind === 'library')).toEqual([])
		expect((await cmd.findAll('zebra')).hits).toEqual([])
	})

	it('with no token and no repository, gives not ready and asks nothing', async () => {
		expect(await cmd.bridgeLibrary()).toEqual({ ready: false, items: [], truncated: false })
		expect(remote.etagsAsked).toEqual([])
		expect(remote.blobReads).toEqual([])
	})
})

describe('Save to Brain', () => {
	const inbox = () => Object.entries(remote.files).filter(([p]) => p.startsWith('bridge/inbox/to-cli/'))
	const ackPath = (id: string, dev = 'cli-a') => `bridge/inbox/acks/${dev}/${id}.json`
	const ack = (id: string, o: Record<string, unknown> = {}) => JSON.stringify({ id, at: clock, by: 'cli-a', ...o })

	it('commits one file with the address and title, and nothing else from the page', async () => {
		await connect()
		const r = await cmd.bridgeSaveUrl('https://user:pw@example.com/a?token=zzz&v=1#h', '  A page  ')
		expect(r.duplicate).toBeUndefined()
		expect(remote.commits).toHaveLength(1)
		expect(inbox()).toHaveLength(1)
		const msg = JSON.parse(inbox()[0][1])
		expect(Object.keys(msg).sort()).toEqual(['at', 'from', 'id', 'schema', 'text', 'title', 'type', 'url'])
		expect(msg).toMatchObject({ type: 'save-url', url: 'https://example.com/a?v=1#h', title: 'A page', text: 'Save to Brain: https://example.com/a?v=1#h' })
		expect((await cmd.bridge()).saved).toMatchObject([{ id: msg.id, url: msg.url, title: 'A page', state: 'waiting' }])
	})

	it('refuses a title shaped like a secret by kind, not value, and cuts a long one', async () => {
		await connect()
		await expect(cmd.bridgeSaveUrl('https://a.io/', 'x ghp_abcdefghijklmnopqrstuvwxyz0123456789')).rejects.toThrow(/GitHub token/)
		await expect(cmd.bridgeSaveUrl('https://a.io/', 'x ghp_abcdefghijklmnopqrstuvwxyz0123456789')).rejects.not.toThrow(/ghp_abc/)
		expect(remote.commits).toHaveLength(0)
		await cmd.bridgeSaveUrl('https://a.io/', 'y'.repeat(300))
		expect(JSON.parse(inbox()[0][1]).title).toHaveLength(200)
	})

	it('refuses what is not a web page, and says so before asking GitHub', async () => {
		await connect()
		await expect(cmd.bridgeSaveUrl('chrome://settings', 't')).rejects.toThrow('Only web pages can be saved.')
		expect(remote.commits).toHaveLength(0)
	})

	it('a URL still waiting is a duplicate of the queue; a lesson source is a duplicate of the brain, even with another &t=', async () => {
		await connect()
		await cmd.bridgeSaveUrl('https://example.com/a?utm_source=x', 'A')
		const again = await cmd.bridgeSaveUrl('https://example.com/a', 'A')
		expect(again.duplicate).toBe('queue')
		expect(remote.commits).toHaveLength(1)
		const line = JSON.stringify({ id: 'l1', at: clock, kind: 'learning', title: 'Lesson', device: 'cli-a', schema: 'workpulse.bridge/1', scope: 'work', tags: [], source: { type: 'youtube', url: 'https://www.youtube.com/watch?v=abc&t=42' } })
		remote.files['bridge/entries/2026-10/cli-a.jsonl'] = line
		remote.tree = { etag: '"b1"', files: [{ path: 'bridge/entries/2026-10/cli-a.jsonl', sha: 'j1' }] }
		await cmd.pollBridge(true)
		expect((await cmd.bridge()).entries).toHaveLength(1)
		const brain = await cmd.bridgeSaveUrl('https://youtu.be/abc?t=9', 'Video')
		expect(brain.duplicate).toBe('brain')
		expect(remote.commits).toHaveLength(1)
	})

	it('with no repository it throws the same words as bridgeAsk and keeps nothing', async () => {
		await expect(cmd.bridgeSaveUrl('https://a.io/', 't')).rejects.toThrow('Set up the backup first')
		await expect(cmd.bridgeAsk('hello')).rejects.toThrow('Set up the backup first')
		const v = await cmd.bridge()
		expect(v.saved).toEqual([])
		expect(v.queued).toBe(0)
	})

	it('moves a row by its ack: no state is done, claimed then done under one path is read once per sha, failed carries why', async () => {
		await connect()
		const a = await cmd.bridgeSaveUrl('https://a.io/one', 'One')
		const b = await cmd.bridgeSaveUrl('https://a.io/two', 'Two')
		const [ida, idb] = [a.saved.id, b.saved.id]
		const state = async (id: string) => (await cmd.bridge()).saved.find((s) => s.id === id)!
		remote.blobs.s1 = ack(ida, { state: 'claimed' })
		remote.blobs.f1 = ack(idb, { state: 'failed', why: 'page needs a login' })
		remote.tree = { etag: '"t1"', files: [{ path: ackPath(ida), sha: 's1' }, { path: ackPath(idb), sha: 'f1' }] }
		await cmd.pollBridge(true)
		expect(await state(ida)).toMatchObject({ state: 'claimed', by: 'cli-a' })
		expect(await state(idb)).toMatchObject({ state: 'failed', why: 'page needs a login' })
		const reads = remote.blobReads.length
		await cmd.pollBridge(true)
		expect(remote.blobReads).toHaveLength(reads)
		// Same path, new content, new sha: the claimed row moves. An ack with no state is done.
		remote.blobs.s2 = ack(ida)
		remote.tree = { etag: '"t2"', files: [{ path: ackPath(ida), sha: 's2' }, { path: ackPath(idb), sha: 'f1' }] }
		await cmd.pollBridge(true)
		expect(await state(ida)).toMatchObject({ state: 'done' })
		expect(remote.blobReads.length).toBe(reads + 1)
	})

	it('a failed ack read is tried again by the next normal poll, not only after Sync now', async () => {
		await connect()
		const a = await cmd.bridgeSaveUrl('https://a.io/one', 'One')
		remote.blobs.s1 = ack(a.saved.id, { state: 'failed', why: 'needs a login' })
		remote.blobFailOnce.add('s1')
		remote.tree = { etag: '"t1"', files: [{ path: ackPath(a.saved.id), sha: 's1' }] }
		await cmd.pollBridge(true)
		expect((await cmd.bridge()).saved[0].state).toBe('waiting')
		// Same tree and ETag: without the fix this answers 304 and never looks again.
		await cmd.pollBridge()
		expect((await cmd.bridge()).saved[0]).toMatchObject({ state: 'failed', why: 'needs a login' })
		expect(remote.etagsAsked.at(-1)).toBeUndefined()
	})

	for (const [what, body] of [['not JSON', '{half a file'], ['JSON that is not an object', 'null']] as const) {
		it(`an ack that is ${what} records its sha and moves on: the row stays and the ETag is kept`, async () => {
			await connect()
			const a = await cmd.bridgeSaveUrl('https://a.io/one', 'One')
			remote.blobs.bad = body
			remote.tree = { etag: '"t1"', files: [{ path: ackPath(a.saved.id), sha: 'bad' }] }
			await cmd.pollBridge(true)
			expect((await cmd.bridge()).saved[0].state).toBe('waiting')
			expect((await store.runtime()).bridge?.ackShas?.[ackPath(a.saved.id)]).toBe('bad')
			expect((await store.runtime()).bridge?.etag).toBe('"t1"')
			const reads = remote.blobReads.length
			await cmd.pollBridge()
			expect(remote.etagsAsked.at(-1)).toBe('"t1"')
			expect(remote.blobReads).toHaveLength(reads)
			// The writer fixes it: a new sha is read as usual.
			remote.blobs.good = ack(a.saved.id, { state: 'done' })
			remote.tree = { etag: '"t2"', files: [{ path: ackPath(a.saved.id), sha: 'good' }] }
			await cmd.pollBridge()
			expect((await cmd.bridge()).saved[0].state).toBe('done')
		})
	}

	it('an ack whose blob is missing clears the ETag, so the next poll looks again', async () => {
		await connect()
		const a = await cmd.bridgeSaveUrl('https://a.io/one', 'One')
		remote.tree = { etag: '"t1"', files: [{ path: ackPath(a.saved.id), sha: 'gone' }] }
		await cmd.pollBridge(true)
		expect((await store.runtime()).bridge?.etag).toBeUndefined()
		expect((await store.runtime()).bridge?.ackShas?.[ackPath(a.saved.id)]).toBeUndefined()
		remote.blobs.gone = ack(a.saved.id, { state: 'done' })
		await cmd.pollBridge()
		expect((await cmd.bridge()).saved[0].state).toBe('done')
	})
})

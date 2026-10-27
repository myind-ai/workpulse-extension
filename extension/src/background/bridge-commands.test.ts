import { beforeEach, describe, expect, it, vi } from 'vitest'

import { memoryKV, Store } from '@/lib/store'
import type { ZohoClient } from '@/lib/zoho'

import { Commands } from './bridge-commands'
import { Engine, type Ui } from './engine'

// What GitHub was asked to write, and whether it is reachable.
const remote = vi.hoisted(() => ({ files: {} as Record<string, string>, commits: [] as string[][], down: false }))
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
		async treeIfChanged() {
			return null
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

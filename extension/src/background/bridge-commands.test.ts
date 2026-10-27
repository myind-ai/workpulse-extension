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

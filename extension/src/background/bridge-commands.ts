// The bridge, from the extension's side: read what the CLI (or any other
// device) wrote under bridge/ in the backup repository, and write this
// browser's own entries and requests there.
//
// It uses the backup's repository and token as they are — no new permission,
// no new setting. Reading is a conditional request for the whole tree, so a
// repository nobody touched costs a 304 that GitHub does not count; only entry
// files whose sha moved are fetched. Writing is one commit to a file only this
// browser writes, so nothing anybody else wrote can be overwritten.

import { appendLine, changedFiles, devicesOf, entriesPath, fold, inboxPath, newEntry, secretsIn, summarise, type BridgeEntry, type Device, type InboxMessage, type Summary } from '@/core/bridge'
import { enabled } from '@/core/features'
import { parseRepo } from '@/core/sync'
import { GitHub } from '@/lib/github'

import { PageCommands } from './page-commands'

export interface BridgeView {
	on: boolean
	/** Set up enough to read: a repository and a token. */
	ready: boolean
	repo: string
	/** The branch backups and the bridge use; empty means the repository's default. */
	branch: string
	hasToken: boolean
	device: string
	/** Everyone who has written to the bridge: Claude Code machines and browsers. */
	devices: Device[]
	polledAt?: number
	error?: string
	entries: BridgeEntry[]
	summary: Summary
}

export class BridgeCommands extends PageCommands {
	private async bridgeGithub(): Promise<GitHub | null> {
		const [s, token] = await Promise.all([this.store.settings(), this.store.syncToken()])
		const where = parseRepo(s.syncRepo)
		if (!where || !token) return null
		return new GitHub(token, { ...where, branch: s.syncBranch.trim() || undefined })
	}

	/** This browser's name as a writer: made once, kept. */
	private async device(): Promise<string> {
		const rt = await this.store.runtime()
		if (rt.bridge?.device) return rt.bridge.device
		const device = `ext-${Math.random().toString(36).slice(2, 8)}`
		await this.store.updateRuntime((r) => void (r.bridge = { ...r.bridge, device }))
		return device
	}

	/** Everything the Brain page shows, from what is already here — no network. */
	async bridge(): Promise<BridgeView> {
		const [s, token, rt, device] = await Promise.all([this.store.settings(), this.store.syncToken(), this.store.runtime(), this.device()])
		const entries = fold(rt.bridge?.files ?? {})
		return {
			on: enabled('BRIDGE_SYNC'),
			ready: !!parseRepo(s.syncRepo) && !!token,
			repo: s.syncRepo,
			branch: s.syncBranch.trim(),
			hasToken: !!token,
			device,
			devices: devicesOf(entries),
			polledAt: rt.bridge?.polledAt,
			error: rt.bridge?.error,
			entries,
			summary: summarise(entries),
		}
	}

	/**
	 * Read what moved under bridge/. `force` skips the ETag, for Sync now: the
	 * person pressing it wants to see the network asked, not a cached answer.
	 */
	async pollBridge(force = false): Promise<{ changed: number; at: number }> {
		const now = this.now()
		if (!enabled('BRIDGE_SYNC')) return { changed: 0, at: now }
		const gh = await this.bridgeGithub()
		if (!gh) return { changed: 0, at: now }
		const rt = await this.store.runtime()
		try {
			const tree = await gh.treeIfChanged(force ? undefined : rt.bridge?.etag)
			if (!tree) {
				await this.store.updateRuntime((r) => void (r.bridge = { ...r.bridge, polledAt: now, error: undefined }))
				return { changed: 0, at: now }
			}
			const { fetch, shas } = changedFiles(rt.bridge?.shas ?? {}, tree.files)
			const files = { ...(rt.bridge?.files ?? {}) }
			for (const path of fetch) {
				const got = await gh.read(path)
				if (got) files[path] = got.text
			}
			for (const path of Object.keys(files)) if (!(path in shas)) delete files[path]
			await this.store.updateRuntime((r) => void (r.bridge = { ...r.bridge, etag: tree.etag, shas, files, polledAt: now, error: undefined }))
			if (fetch.length) this.env.ui.changed()
			return { changed: fetch.length, at: now }
		} catch (e) {
			const error = (e as Error).message
			await this.store.updateRuntime((r) => void (r.bridge = { ...r.bridge, polledAt: now, error }))
			throw e
		}
	}

	/** One entry from this browser, appended to this browser's own file. */
	async bridgeAdd(input: Omit<BridgeEntry, 'schema' | 'id' | 'at' | 'device' | 'tags'> & { tags?: string[] }): Promise<BridgeEntry> {
		if (!enabled('BRIDGE_SYNC')) throw new Error('The bridge is switched off in this build (WXT_FEATURE_BRIDGE_SYNC).')
		if (input.scope === 'personal' && !enabled('PERSONAL')) throw new Error('Personal entries are switched off in this build (WXT_FEATURE_PERSONAL).')
		const gh = await this.bridgeGithub()
		if (!gh) throw new Error('Set up the backup first: a repository and a token, in Settings → Backup.')
		const [device, now] = [await this.device(), this.now()]
		const entry = newEntry(input, device, now)
		const path = entriesPath(now, device)
		const existing = await gh.read(path)
		const text = appendLine(existing?.text ?? null, entry)
		await gh.commit([{ path, content: text }], `bridge: ${entry.kind} — ${entry.title.slice(0, 60)}`)
		// What was written is what is known: show it now, rather than after the
		// next poll. The ETag goes, so that poll does look.
		await this.store.updateRuntime((r) => void (r.bridge = { ...r.bridge, files: { ...r.bridge?.files, [path]: text }, etag: undefined }))
		this.env.ui.changed()
		return entry
	}

	/**
	 * A ticket on the Tickets page for a key the Brain knows and the page does
	 * not: named after the key and the entry, with the entry's pull request and
	 * links as its first tabs — or the Brain filtered to that key when it has
	 * none, since a ticket needs one link to open as a group.
	 */
	async ticketFromBrain(entryId: string): Promise<{ id: string }> {
		const all = (await this.bridge()).entries
		const e = all.find((x) => x.id === entryId)
		if (!e?.ticket) throw new Error('That entry has no ticket key.')
		const key = e.ticket
		const [have] = await this.ticketsForKeys([key])
		if (have?.ticketId) return { id: have.ticketId }
		// The ticket is named by its ticket record when there is one, whichever
		// entry was clicked — a mistake makes a poor ticket title — and it gathers
		// every pull request and link recorded under the key.
		const same = all.filter((x) => x.ticket === key)
		const record = same.find((x) => x.kind === 'ticket') ?? e
		const prs = new Set(same.map((x) => x.links?.pr).filter((u): u is string => !!u))
		const links = [...new Set([...prs, ...same.flatMap((x) => x.links?.urls ?? [])])].filter((u) => /^https?:\/\//.test(u))
		const tabs = links.length
			? links.map((url) => ({ title: prs.has(url) ? `${key} · pull request` : url, url }))
			: [{ title: `${key} in the Brain`, url: chrome.runtime.getURL(`/dashboard.html#/brain/${key}`) }]
		const space = await this.saveWorkspace({ name: `${key} ${record.title}`.slice(0, 120), tabs, note: record.asked })
		return { id: space.id }
	}

	/** Which of these ticket keys already has a ticket on the Tickets page. */
	async brainTickets(keys: string[]): Promise<Record<string, string | null>> {
		const found = await this.ticketsForKeys([...new Set(keys)])
		return Object.fromEntries(found.map((t) => [t.key, t.ticketId ?? null]))
	}

	/**
	 * A new learning or mistake goes to the Brain as well as to this browser, so
	 * Claude reads it in the next brief rather than after tonight's backup. In
	 * the background: saving never waits on GitHub, and a failed copy is caught
	 * up by the daily backup, which the CLI reads too. It keeps the learning's id
	 * (`journal:<id>`), so the two copies are one line everywhere they are read.
	 * Edits stay local: the Brain is append-only.
	 */
	override async saveLearning(input: Parameters<PageCommands['saveLearning']>[0]) {
		const saved = await super.saveLearning(input)
		if (!input.id) void this.mirrorLearning(saved).catch((e) => this.store.updateRuntime((r) => void (r.bridge = { ...r.bridge, error: `Learning not copied to the Brain: ${(e as Error).message}` })))
		return saved
	}

	private async mirrorLearning(l: Awaited<ReturnType<PageCommands['saveLearning']>>): Promise<void> {
		if (!enabled('BRIDGE_SYNC')) return
		const gh = await this.bridgeGithub()
		if (!gh) return
		const space = l.ticketId ? (await this.store.workspaces()).find((w) => w.id === l.ticketId) : undefined
		const ticket = space?.name.match(/\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/)?.[0]
		const [device, now] = [await this.device(), this.now()]
		let entry: BridgeEntry
		try {
			entry = { ...newEntry({ kind: l.kind === 'mistake' ? 'mistake' : 'learning', scope: 'work', title: l.text.split('\n')[0].slice(0, 200), body: l.text.includes('\n') ? l.text : undefined, ticket, tags: l.tags }, device, now), id: `journal:${l.id}` }
		} catch {
			return // shaped like a secret: it stays on this machine
		}
		const path = entriesPath(now, device)
		const existing = await gh.read(path)
		const text = appendLine(existing?.text ?? null, entry)
		await gh.commit([{ path, content: text }], `bridge: ${entry.kind} — ${entry.title.slice(0, 60)}`)
		await this.store.updateRuntime((r) => void (r.bridge = { ...r.bridge, files: { ...r.bridge?.files, [path]: text }, etag: undefined }))
		this.env.ui.changed()
	}

	/** Ask whatever reads the inbox — the CLI skill — to do something. */
	async bridgeAsk(text: string, ticket?: string, project?: string): Promise<void> {
		if (!enabled('BRIDGE_SYNC')) throw new Error('The bridge is switched off in this build (WXT_FEATURE_BRIDGE_SYNC).')
		const found = secretsIn(text)
		if (found.length) throw new Error(`Not sent: it contains what looks like a ${found.join(', ')}.`)
		const gh = await this.bridgeGithub()
		if (!gh) throw new Error('Set up the backup first: a repository and a token, in Settings → Backup.')
		const now = this.now()
		const msg: InboxMessage = { schema: 'workpulse.bridge.msg/1', id: Math.random().toString(36).slice(2, 10), at: now, from: await this.device(), text: text.trim(), ticket, project }
		await gh.commit([{ path: inboxPath(msg), content: `${JSON.stringify(msg, null, 2)}\n` }], `bridge: ask — ${msg.text.slice(0, 60)}`)
	}
}

/** The full command surface the UI can call (see lib/rpc.ts). */
export class Commands extends BridgeCommands {}

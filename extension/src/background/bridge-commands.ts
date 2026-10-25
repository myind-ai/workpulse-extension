// The bridge, from the extension's side: read what the CLI (or any other
// device) wrote under bridge/ in the backup repository, and write this
// browser's own entries and requests there.
//
// It uses the backup's repository and token as they are — no new permission,
// no new setting. Reading is a conditional request for the whole tree, so a
// repository nobody touched costs a 304 that GitHub does not count; only entry
// files whose sha moved are fetched. Writing is one commit to a file only this
// browser writes, so nothing anybody else wrote can be overwritten.

import { appendLine, changedFiles, entriesPath, fold, inboxPath, newEntry, secretsIn, summarise, type BridgeEntry, type InboxMessage, type Summary } from '@/core/bridge'
import { enabled } from '@/core/features'
import { parseRepo } from '@/core/sync'
import { GitHub } from '@/lib/github'

import { PageCommands } from './page-commands'

export interface BridgeView {
	on: boolean
	/** Set up enough to read: a repository and a token. */
	ready: boolean
	repo: string
	device: string
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
			device,
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

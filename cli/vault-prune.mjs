// wp-brain vault prune: deletes this device's old snapshots and its orphan releases. Without --yes it only lists them.
// One writer: it reads every device's manifest (an orphan is judged against all of them) but changes only this device's
// manifest and this device's snapshot releases. Videos (videos-NNNN) are never deleted. Order for each snapshot: delete the
// release, then drop its manifest items; a failed delete leaves its items so `status` stays true, and the rest go on.
// Shares the staging lock with backup and restore, and leaves any release a resumable backup still uses.
import { join } from 'node:path'

import { allManifests, formatBytes, git, manifestRel, ownManifest, prepare, pullRebase, requireCloneOfRepo, requirePrivate, stagedTags, syncManifest, withLock } from './vault.mjs'
import { findOrphans, selectPrune, writeManifest } from './vault-manifest.mjs'

const sum = (xs) => xs.reduce((a, b) => a + b, 0)

/** The tag's device when it is a `snap-<time>-<device>` tag, else null. */
const deviceOfTag = (tag) => /^snap-\d{8}T\d{6}Z-(.+)$/.exec(tag)?.[1] ?? null

const RELEASE_HOW = 'release it with `wp-brain vault backup --discard-staged`'

/** A preview changes nothing: it pulls (a local change to the clone only) when this device's manifest is clean, else it says it shows the local view. */
function refreshForPreview(ctx) {
	try {
		if (git(ctx, 'status', '--porcelain', '--', manifestRel(ctx.cfg.device)).trim()) throw new Error('this device has a manifest change not yet pushed')
		const branch = git(ctx, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
		if (branch === 'HEAD') throw new Error('the clone is not on a branch')
		pullRebase(ctx, branch)
	} catch {
		ctx.log('Could not refresh the manifests from the vault repository, so this is the local view. Nothing is deleted without --yes.')
	}
}

/**
 * opts: { keep (count of recent snapshots, default from the config), yes }.
 * Returns { deleted, orphans, failed, young }: tags actually deleted (orphans first), the old orphans found (deleted only
 * with yes), the deletes that failed, and the orphans left because they are under a day old.
 */
export async function prune(rawCtx, opts = {}) {
	const ctx = prepare(rawCtx)
	const { cfg, log } = ctx
	const yes = !!opts.yes
	if (opts.keep !== undefined && !(Number.isInteger(opts.keep) && opts.keep >= 0)) throw new Error('--keep needs a whole number of snapshots, 0 or more.')
	const keep = { ...cfg.keep, recent: opts.keep ?? cfg.keep.recent }

	// Both refusals come before the lock, so a refused run leaves no staging folder behind.
	requirePrivate(ctx)
	requireCloneOfRepo(ctx)
	const body = async () => {
		// Other devices' manifests first: a snapshot another device just listed must not look unlisted here.
		// Only a real run commits and pushes (syncManifest); a preview just pulls.
		if (yes) syncManifest(ctx)
		else refreshForPreview(ctx)

		const mine = ownManifest(ctx)
		const now = ctx.nowMs()
		const resuming = stagedTags(ctx)
		const otherListed = new Set(allManifests(ctx).filter((m) => m.device !== cfg.device).flatMap((m) => m.items.map((i) => i.release)))

		// Snapshots to prune: selectPrune works on this device's items only, and returns whole snapshots.
		const ids = new Set(selectPrune(mine.items, now, keep))
		const byRelease = new Map()
		for (const it of mine.items) if (ids.has(it.id)) byRelease.set(it.release, [...(byRelease.get(it.release) ?? []), it])
		const snapshots = []
		for (const [tag, items] of byRelease) {
			const whole = mine.items.filter((i) => i.release === tag).every((i) => ids.has(i.id))
			if (!/^snap-/.test(tag) || !whole) continue // a videos-NNNN release, or one that also holds something kept
			if (resuming.has(tag)) log(`left ${tag}: a backup that was interrupted is resuming it (${RELEASE_HOW})`)
			else if (otherListed.has(tag)) log(`left ${tag}: another device's manifest lists it`)
			else snapshots.push({ tag, items, date: items.map((i) => i.date).sort().at(-1), size: sum(items.flatMap((i) => i.parts.map((p) => p.size))) })
		}
		snapshots.sort((a, b) => String(a.date).localeCompare(String(b.date)))

		// Orphans: this device's snapshot releases that no manifest lists.
		let orphans = []
		let young = []
		let storageError = null
		const draft = {}
		try {
			const releases = await ctx.storage.listReleases()
			const found = findOrphans(releases.map((r) => ({ tagName: r.tag, createdAt: r.createdAt })), allManifests(ctx), now)
			const listed = new Set(allManifests(ctx).flatMap((m) => m.items.map((i) => i.release)))
			const own = (t) => deviceOfTag(t) === cfg.device
			for (const r of releases) draft[r.tag] = !!r.draft
			orphans = found.filter(own)
			young = releases.filter((r) => own(r.tag) && !listed.has(r.tag) && !found.includes(r.tag)).map((r) => r.tag)
			for (const t of [...orphans, ...young]) if (resuming.has(t)) log(`left ${t}: a backup that was interrupted is resuming it (${RELEASE_HOW})`)
			orphans = orphans.filter((t) => !resuming.has(t))
			young = young.filter((t) => !resuming.has(t))
			// A published release passed its checks: it is a whole backup whose listing is gone, not a half-done upload.
			const published = [...orphans, ...young].filter((t) => !draft[t])
			if (!mine.items.some((i) => i.kind === 'database') && published.length) throw new Error(`This device's manifest lists no database, but ${published.length} published snapshot release(s) of this device exist (${published.slice(0, 3).join(', ')}${published.length > 3 ? ', ...' : ''}). That looks like a lost or emptied manifest, not old backups, so nothing was deleted. Restore the manifest from the vault repository's history, then run again.`)
		} catch (e) {
			if (e.message.startsWith("This device's manifest lists no database")) throw e
			storageError = e.message
			log(`Could not read the releases (${`${e.message}`.slice(0, 200)}), so orphan releases were not looked for.`)
		}
		const orphanSize = {}
		for (const t of orphans) {
			try {
				orphanSize[t] = sum((await ctx.storage.listAssets(t)).map((a) => a.size))
			} catch {
				orphanSize[t] = null
			}
		}

		if (keep.recent < 1) {
			const newest = mine.items.filter((i) => i.kind === 'database' && i.verifiedAt).sort((a, b) => String(b.date).localeCompare(String(a.date)))[0]
			if (newest) log(`The newest verified snapshot is always kept (${newest.release}), whatever --keep says.`)
		}
		for (const t of orphans) log(`orphan   ${t}  ${draft[t] ? 'draft' : 'published'}  ${orphanSize[t] === null ? 'size unknown (its files could not be listed)' : formatBytes(orphanSize[t])}  no manifest lists it, older than a day`)
		for (const t of young) log(`left     ${t}  ${draft[t] ? 'draft' : 'published'}  no manifest lists it, but it is under a day old (a backup may be running)`)
		for (const s of snapshots) log(`snapshot ${s.tag}  ${s.date.slice(0, 10)}  ${formatBytes(s.size)}  ${s.items.map((i) => i.name).join(', ')}`)
		const known = sum(snapshots.map((s) => s.size)) + sum(orphans.map((t) => orphanSize[t] ?? 0))
		const unknown = orphans.filter((t) => orphanSize[t] === null).length
		const frees = `${formatBytes(known)}${unknown ? ` plus ${unknown} orphan(s) of unknown size` : ''}`
		if (!snapshots.length && !orphans.length) {
			log(`Nothing to delete${storageError ? ' (the releases could not be read)' : ''}.`)
			return { deleted: [], orphans, failed: [], young }
		}
		if (!yes) {
			log(`Would free ${frees} by deleting ${snapshots.length} snapshot(s) and ${orphans.length} orphan(s). Run again with --yes to delete.`)
			return { deleted: [], orphans, failed: [], young }
		}

		const deleted = []
		const failed = []
		const attempt = async (tag) => {
			try {
				await ctx.storage.deleteRelease(tag)
				deleted.push(tag)
				return true
			} catch (e) {
				failed.push({ tag, error: e.message })
				log(`could not delete ${tag}: ${`${e.message}`.slice(0, 200)}. Its manifest items stay.`)
				return false
			}
		}
		let changed = false
		try {
			for (const tag of orphans) if (await attempt(tag)) log(`deleted orphan ${tag}`)
			for (const s of snapshots) {
				if (!(await attempt(s.tag))) continue
				const gone = new Set(s.items.map((i) => i.id))
				mine.items = mine.items.filter((i) => !gone.has(i.id))
				writeManifest(join(ctx.clone, manifestRel(cfg.device)), mine) // saved at once, so a later crash leaves no item for a deleted release
				changed = true
				log(`deleted ${s.tag}`)
			}
		} finally {
			if (changed) syncManifest(ctx)
		}
		log(`Done: ${deleted.length} deleted, ${failed.length} failed. Freed up to ${frees}.`)
		return { deleted, orphans, failed, young }
	}
	return yes ? withLock(ctx, body) : body()
}

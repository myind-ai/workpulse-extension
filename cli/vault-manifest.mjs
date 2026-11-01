// The vault's config, manifest and prune planning. Pure except readManifest and writeManifest.
// A manifest holds names and numbers only, never content. Reuses validDevice and fileSecretsIn from library.mjs.
import { isAbsolute } from 'node:path'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { extraPackPath, memoryDbPath, sessionsPackPath } from './claude-files.mjs'
import { fileSecretsIn, validDevice } from './library.mjs'

export const DEFAULT_KEEP = { recent: 5, months: 3 }
const ITEM_KEYS = ['id', 'kind', 'name', 'size', 'sha256', 'date', 'release', 'encrypted', 'keyFp', 'parts', 'verifiedAt']
const PART_KEYS = ['asset', 'size', 'sha256']

/** Databases that come with a switch instead of a line in vault.databases, so the order of turning things on doesn't matter. */
const switchedOnDatabases = (cfg) => [
	...(cfg.memory === true ? [memoryDbPath(), sessionsPackPath()] : []),
	...(cfg.backup?.claudeDocs === true ? [extraPackPath('claude-docs')] : []),
	...(cfg.backup?.projectMemory === true ? [extraPackPath('project-memory')] : []),
]

/** cfg.vault -> the settings the vault uses, or null when there is no vault. Throws a clear message on bad values. */
export function parseVaultConfig(cfg) {
	const v = cfg?.vault
	if (!v) return null
	if (typeof v.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(v.repo)) throw new Error('vault.repo must look like "owner/name"')
	const device = v.device ?? cfg.device
	if (!validDevice(device)) throw new Error('vault.device (or device) must be a plain name: letters, digits, dot, dash, underscore')
	// It goes into a release's tag, and GitHub would refuse that only at publish, after the uploads.
	if (/\.\.|^\.|\.$|\.lock$/.test(device)) throw new Error('vault.device (or device) must also fit in a git tag: no "..", no dot at either end, no ".lock" ending')
	const paths = (key) => {
		const list = v[key] ?? []
		if (!Array.isArray(list)) throw new Error(`vault.${key} must be a list of folders or files`)
		for (const p of list) if (typeof p !== 'string' || !isAbsolute(p)) throw new Error(`vault.${key} needs absolute paths (got a relative one)`)
		return list
	}
	const count = (n, fallback, key) => {
		if (n === undefined) return fallback
		if (!Number.isInteger(n) || n < 0) throw new Error(`vault.keep.${key} must be a whole number, 0 or more`)
		return n
	}
	const listed = paths('databases')
	const switched = switchedOnDatabases(cfg)
	return {
		repo: v.repo,
		device,
		videos: paths('videos'),
		databases: [...new Set([...listed, ...switched])],
		defaultDatabases: switched.filter((p) => !listed.includes(p)), // not there yet is a note for these; one you listed still stops the run
		keep: { recent: count(v.keep?.recent, DEFAULT_KEEP.recent, 'recent'), months: count(v.keep?.months, DEFAULT_KEEP.months, 'months') },
		keyBackedUpAt: typeof v.keyBackedUpAt === 'string' ? v.keyBackedUpAt : null,
		keyBackedUpFp: typeof v.keyBackedUpFp === 'string' ? v.keyBackedUpFp : null,
	}
}

export const bareName = (n) => typeof n === 'string' && n !== '' && n !== '.' && n !== '..' && !/[\/\\\0]/.test(n)

/** Throws when the manifest could not be safely written or trusted. Messages name the item by id and kind, never its name. */
function check(m) {
	if (!m || m.version !== 1 || !Array.isArray(m.items)) throw new Error('vault manifest: not a version 1 manifest')
	for (const it of m.items) {
		const who = `item ${it?.id} (${it?.kind})`
		if (!bareName(it?.name)) throw new Error(`vault manifest: ${who} has a name that is not a bare filename`)
		const strings = [it.id, it.name, it.release, it.keyFp, ...(it.parts ?? []).map((p) => p.asset)].filter((s) => typeof s === 'string')
		if (strings.some((s) => fileSecretsIn(s).length)) throw new Error(`vault manifest: ${who} looks like it holds a secret; nothing was written`)
	}
}

const ordered = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]))
const stable = (m) => ({ version: 1, device: m.device, items: m.items.map((it) => ({ ...ordered(it, ITEM_KEYS), parts: (it.parts ?? []).map((p) => ordered(p, PART_KEYS)) })) })

/** The manifest at path, or null when the file is absent. */
export function readManifest(path) {
	let text
	try {
		text = readFileSync(path, 'utf8')
	} catch (e) {
		if (e.code === 'ENOENT') return null
		throw e
	}
	const m = JSON.parse(text)
	check(m)
	return m
}

/** Writes the manifest with a stable key order, through a temp file and a rename. Refuses on a secret or a bad name. */
export function writeManifest(path, m) {
	check(m)
	mkdirSync(dirname(path), { recursive: true })
	const tmp = `${path}.partial`
	try {
		writeFileSync(tmp, JSON.stringify(stable(m), null, '\t') + '\n')
		renameSync(tmp, path)
	} catch (e) {
		rmSync(tmp, { force: true })
		throw e
	}
}

const ms = (t) => (t instanceof Date ? t.getTime() : typeof t === 'number' ? t : Date.parse(t))
const monthOf = (t) => new Date(ms(t)).toISOString().slice(0, 7)

/**
 * Ids to delete. One device's items; databases only (videos are never pruned). Items sharing a `release` are one
 * snapshot, kept or pruned whole. Kept: the newest `recent` verified snapshots, the newest verified snapshot of each of the
 * last `months` calendar months (this one included), and always the newest verified snapshot (the last good one).
 * A snapshot with any unverified item is not verified. An unverified snapshot newer than the newest verified one is
 * kept (a run may be in progress); an older one is pruned.
 */
export function selectPrune(items, now, keep = DEFAULT_KEEP) {
	const snaps = new Map()
	for (const it of items) {
		if (it.kind !== 'database') continue
		const s = snaps.get(it.release) ?? { ids: [], date: 0, verified: true }
		s.ids.push(it.id)
		s.date = Math.max(s.date, ms(it.date))
		if (!it.verifiedAt) s.verified = false
		snaps.set(it.release, s)
	}
	const all = [...snaps.values()].sort((a, b) => b.date - a.date)
	const good = all.filter((s) => s.verified)
	const kept = new Set(good.slice(0, keep.recent))
	if (good[0]) kept.add(good[0])
	const d = new Date(ms(now))
	const wanted = new Set()
	for (let i = 0; i < keep.months; i++) wanted.add(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7))
	const seen = new Set()
	for (const s of good) {
		const m = monthOf(s.date)
		if (wanted.has(m) && !seen.has(m)) (seen.add(m), kept.add(s))
	}
	const newestGood = good[0]?.date ?? -Infinity
	return all.filter((s) => !kept.has(s) && !(!s.verified && s.date > newestGood)).flatMap((s) => s.ids)
}

const DAY = 24 * 3600e3

/** Tags of `snap-` releases that no manifest lists and that are older than 24 hours (a younger one may be mid-run). */
export function findOrphans(releases, manifests, now = Date.now()) {
	const listed = new Set(manifests.flatMap((m) => m.items.map((it) => it.release)))
	return releases.filter((r) => r.tagName.startsWith('snap-') && !listed.has(r.tagName) && ms(now) - ms(r.createdAt) > DAY).map((r) => r.tagName)
}

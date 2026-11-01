// The saved library (bridge/library/<type>/<folder>/…), read from the Git tree
// the Brain poll already fetches. Pure: no chrome, no fetch. Only meta is kept;
// file text is read on demand and never stored.

import { LIBRARY_FILES, ROOT } from './bridge'

export interface LibraryItem {
	/** `bridge/library/<type>/<folder>` */
	path: string
	type: string
	folder: string
	/** The readable files this folder holds (the allowlist), with blob shas. */
	files: { name: string; sha: string }[]
	/** The sha of the meta.json that `title` and the rest were read from. */
	metaSha?: string
	title?: string
	by?: string
	url?: string
	savedAt?: string
	words?: number
}

const PREFIX = `${ROOT}/library/`
const META = 'meta.json'
const STAGES = ['notes.md', 'article.md', 'transcript.md', 'transcript.txt', 'description.md']

/** Group the tree's library files by folder. Meta already read is kept while its sha has not moved. */
export function libraryFromTree(tree: { path: string; sha: string }[], previous: LibraryItem[] = []): LibraryItem[] {
	const before = new Map(previous.map((p) => [p.path, p]))
	const groups = new Map<string, LibraryItem>()
	for (const f of tree) {
		if (!f.path.startsWith(PREFIX)) continue
		const parts = f.path.slice(PREFIX.length).split('/')
		if (parts.length !== 3 || parts.some((p) => !p)) continue
		const [type, folder, name] = parts
		if (!(LIBRARY_FILES as readonly string[]).includes(name)) continue
		const path = `${PREFIX}${type}/${folder}`
		let item = groups.get(path)
		if (!item) groups.set(path, (item = { path, type, folder, files: [] }))
		item.files.push({ name, sha: f.sha })
	}
	return [...groups.values()]
		.map((item) => {
			item.files.sort((a, b) => a.name.localeCompare(b.name))
			const old = before.get(item.path)
			const metaSha = item.files.find((f) => f.name === META)?.sha
			return old && metaSha && old.metaSha === metaSha ? { ...item, metaSha, title: old.title, by: old.by, url: old.url, savedAt: old.savedAt, words: old.words } : item
		})
		.sort((a, b) => a.path.localeCompare(b.path))
}

const text = (v: unknown, max = 300): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)

const httpUrl = (v: unknown): string | undefined => {
	const s = text(v, 2000)
	if (!s) return undefined
	try {
		const u = new URL(s)
		return u.protocol === 'http:' || u.protocol === 'https:' ? s : undefined
	} catch {
		return undefined
	}
}

/** Read a folder's meta.json. Bad JSON gives the folder's title and still records the sha, so it is not fetched again. */
export function applyMeta(item: LibraryItem, raw: string, sha: string): LibraryItem {
	let m: Record<string, unknown> = {}
	try {
		const parsed: unknown = JSON.parse(raw)
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) m = parsed as Record<string, unknown>
	} catch {
		// keep the fallback
	}
	const words = typeof m.words === 'number' && Number.isFinite(m.words) && m.words >= 0 ? Math.round(m.words) : undefined
	return {
		...item,
		metaSha: sha,
		title: text(m.title, 200) ?? titleFromFolder(item.folder),
		by: text(m.channel, 120) ?? text(m.uploader, 120),
		url: httpUrl(m.webpage_url),
		savedAt: text(m.saved_at, 40),
		words,
	}
}

/** `2026-10-29_Some-title_abc123` becomes `Some title`. */
export function titleFromFolder(folder: string): string {
	let parts = folder.split('_')
	if (parts.length > 1 && /^\d{4}-\d{2}-\d{2}$/.test(parts[0])) parts = parts.slice(1)
	if (parts.length > 1) parts = parts.slice(0, -1)
	return parts.join(' ').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() || folder
}

/** The order to read a folder's files in. Never meta.json or .owner. */
export function readingOrder(files: { name: string }[]): string[] {
	const have = new Set(files.map((f) => f.name))
	return STAGES.filter((n) => have.has(n))
}

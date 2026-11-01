// The library: videos and articles saved with the youtube-learning skill, listed from the repository's
// Git tree (titles only) and opened one at a time. Reading, not editing: each folder has one writer,
// so the scope here is list, open, see the source, and manage the lessons that came out of it.
//
// Checked before writing: `BrainView` (list + side column, `EntryCard`, `PAGE`, the not-connected card),
// `ui/Markdown`, `SourceChip`/`SourceFilter`, `rankTitles` and `.wp-brain`: all reused; nothing here
// draws a lesson, a chip or a filter of its own.

import { useEffect, useMemo, useState } from 'react'

import { brainHash, matchBrain, rankTitles } from '@/core/brain-query'
import { enabled } from '@/core/features'
import { libraryKey, sourceOf, SOURCE_TYPES, urlHost, type BridgeEntry, type SavedUrl, type SourceType } from '@/core/bridge'
import { readingOrder, titleFromFolder, type LibraryItem } from '@/core/library'
import { istDate, prettyDate } from '@/core/time'
import { call } from '@/lib/rpc'
import { Art } from '@/ui/Art'
import { Busy } from '@/ui/Busy'
import { Fold } from '@/ui/Fold'
import { useAction, useLive } from '@/ui/hooks'
import { Markdown } from '@/ui/Markdown'
import { SourceChip, SourceFilter, type SourceChoice } from '@/ui/SourceChip'

import { EntryCard } from './BrainView'

const PAGE = 40
/** More than this is shown as plain text, cut here: a 2 MB parse would freeze the page. */
export const RENDER_MAX = 200_000

const titleOf = (i: LibraryItem) => i.title ?? titleFromFolder(i.folder)
const sourceType = (i: LibraryItem): SourceType | undefined => ((SOURCE_TYPES as readonly string[]).includes(i.type) ? (i.type as SourceType) : undefined)
const savedMs = (i: LibraryItem) => {
	const t = i.savedAt ? Date.parse(i.savedAt) : NaN
	if (!Number.isNaN(t)) return t
	const d = Date.parse(i.folder.slice(0, 10))
	return Number.isNaN(d) ? 0 : d
}
const when = (i: LibraryItem) => (savedMs(i) ? prettyDate(istDate(savedMs(i))) : '')
const libraryHash = (path: string) => `#/library/${encodeURIComponent(path)}`
const decode = (v?: string) => {
	if (!v) return undefined
	try {
		return decodeURIComponent(v)
	} catch {
		return v
	}
}
const texts = (i: LibraryItem) => readingOrder(i.files).join(', ')

/** Where the file lives on GitHub, for a text too large to show whole. */
export function githubUrl(repo: string, branch: string, path: string, name: string): string {
	const rest = [...path.split('/'), name].map(encodeURIComponent).join('/')
	return `https://github.com/${repo}/blob/${branch ? encodeURIComponent(branch) : 'HEAD'}/${rest}`
}

export function LibraryView({ arg }: { arg?: string }) {
	const { data, error, reload } = useLive(() => call('bridgeLibrary'))
	const { data: brain, reload: reloadBrain } = useLive(() => call('bridge'))
	const sync = useAction()
	const open = decode(arg)

	// Look at the repository when this page opens; the folders' titles then fill in over a few calls.
	// Until the first look has answered, an empty list means "not asked yet", not "nothing saved".
	const [polled, setPolled] = useState(false)
	useEffect(() => {
		// A failed look is stored, not broadcast: read it back, or the page would say "nothing saved".
		void call('pollBridge')
			.catch(() => undefined)
			.then(() => Promise.all([reload(), reloadBrain()]))
			.then(() => setPolled(true))
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])
	const waiting = data?.items.some((i) => i.files.some((f) => f.name === 'meta.json' && f.sha !== i.metaSha)) ?? false
	const [tries, setTries] = useState(0)
	useEffect(() => {
		if (!waiting || tries >= 20) return
		const t = setTimeout(() => (setTries(tries + 1), void reload()), 600)
		return () => clearTimeout(t)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [waiting, tries, data])

	const items = data?.items ?? []
	const lessons = brain?.entries ?? []
	const item = open ? items.find((i) => i.path === open) : undefined
	const failed = sync.error || error || brain?.error

	return (
		<div className="wp-stack">
			<header className="wp-page-head">
				<div>
					<span className="wp-eyebrow">Saved with the youtube-learning skill, in your own repository</span>
					<h1 className="wp-h1">Library</h1>
					<p className="wp-muted wp-small" style={{ maxWidth: 600, margin: 0 }}>
						Videos and articles you saved, with their notes and transcripts. Read here; the lessons taken from each one are in the <a href="#/brain">Brain</a>.
					</p>
				</div>
				<div className="wp-row-wrap">
					<button className="wp-btn wp-btn-sm wp-btn-primary" disabled={sync.busy || !data?.ready} onClick={() => sync.run(async () => void (await call('pollBridge', true), await reload(), await reloadBrain()))}>
						<Busy busy={sync.busy} doing="Syncing…">
							Sync now
						</Busy>
					</button>
				</div>
			</header>

			{enabled('BRAIN') && enabled('BRIDGE_SYNC') && data?.ready && <SavedToRead saved={brain?.saved ?? []} onSent={reloadBrain} />}

			{sync.busy && <Art name="reading" size={48} delay={400} />}
			{failed && <div className="wp-banner wp-small">{failed}</div>}
			{data?.truncated && (
				<div className="wp-banner wp-small">The repository’s file tree is too large for GitHub to list in full, so some library folders may be missing from this page.</div>
			)}

			{data && !data.ready ? (
				<div className="wp-card wp-stack-sm">
					<Art name="empty-journal" size={96} />
					<strong>Connect a repository first.</strong>
					<span className="wp-muted wp-small">
						The library is read from the same private repository your backup uses. Set it up in <a href="#/settings/backup">Settings → Backup</a> (a fine-grained token with Contents: Read and write on that one
						repository).
					</span>
				</div>
			) : data && !items.length && !polled ? (
				<div className="wp-card" data-testid="library-loading">
					<Art name="reading" size={48} />
					<span className="wp-muted wp-small">Looking in your repository…</span>
				</div>
			) : data && !items.length && failed ? (
				<div className="wp-card wp-stack-sm">
					<Art name="empty-notes" size={96} />
					<strong data-testid="library-failed">Could not read your repository.</strong>
					<span className="wp-muted wp-small">So this page cannot say what is saved. The reason is above; once it is sorted, press Sync now.</span>
				</div>
			) : data && !items.length ? (
				<div className="wp-card wp-stack-sm">
					<Art name="empty-notes" size={96} />
					<strong data-testid="library-empty">Nothing saved yet.</strong>
					<span className="wp-muted wp-small">
						Saving the notes and transcripts to your repository is off by default. Turn it on with <code>"library": true</code> in <code>brain.json</code>, then share a YouTube or Instagram link with the
						youtube-learning skill.
					</span>
				</div>
			) : open ? (
				item ? (
					<Opened item={item} lessons={lessons} repo={brain?.repo ?? ''} branch={brain?.branch ?? ''} onChanged={reloadBrain} />
				) : (
					<div className="wp-card wp-stack-sm">
						<span className="wp-muted">That folder is not in the library{data ? ' (yet). Sync, then try again.' : '.'}</span>
						<a className="wp-link" href="#/library">
							← All saved items
						</a>
					</div>
				)
			) : (
				<List items={items} lessons={lessons} loading={!data} />
			)}
		</div>
	)
}

const SAVED_STATE: Record<string, string> = { waiting: 'Waiting to be read', claimed: 'Being read', done: 'Read', failed: 'Failed' }

/** Pages sent to the inbox for `wp-brain queue`, with where each one is. A failed page says why, so it is never silent. */
function SavedToRead({ saved, onSent }: { saved: SavedUrl[]; onSent: () => void }) {
	const [url, setUrl] = useState('')
	const [said, setSaid] = useState('')
	const { busy, error, run } = useAction()
	const send = () =>
		run(async () => {
			const r = await call('bridgeSaveUrl', url.trim())
			setSaid(r.duplicate === 'queue' ? 'Already saved and waiting to be read.' : r.duplicate === 'brain' ? 'A lesson already comes from this page.' : 'Saved. Say "process my queue" to Claude when you want it read.')
			if (!r.duplicate) setUrl('')
			onSent()
		})
	return (
		<Fold title="Saved to read" count={saved.length} open={saved.some((s) => s.state === 'failed')}>
			<div className="wp-stack-sm">
				<div className="wp-row">
					<input className="wp-input wp-grow" aria-label="Page address to save" placeholder="https://… a page to read later" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && url.trim() && void send()} />
					<button className="wp-btn wp-btn-sm wp-btn-primary" disabled={busy || !url.trim()} onClick={send}>
						Save to Brain
					</button>
				</div>
				{said && <div className="wp-ok-text wp-small">{said}</div>}
				{error && <div className="wp-error wp-small">{error}</div>}
				{saved.length === 0 && <span className="wp-muted wp-small">Nothing sent from this browser yet. Only the address and title go, when you press the button.</span>}
				{saved.map((s) => (
					<div key={s.id} className="wp-small" data-testid="saved-row">
						<strong>{s.title || urlHost(s.url)}</strong> <span className="wp-muted">· {SAVED_STATE[s.state]}</span>
						{s.state === 'failed' && <div className="wp-error">{s.why || 'The reader gave no reason.'}</div>}
					</div>
				))}
			</div>
		</Fold>
	)
}

function List({ items, lessons, loading }: { items: LibraryItem[]; lessons: BridgeEntry[]; loading: boolean }) {
	const [source, setSource] = useState<SourceChoice>('all')
	const [query, setQuery] = useState('')
	const [show, setShow] = useState(PAGE)

	const counts = useMemo(() => {
		const by: Partial<Record<SourceType | 'none', number>> = {}
		for (const i of items) {
			const t = sourceType(i) ?? 'none'
			by[t] = (by[t] ?? 0) + 1
		}
		return by
	}, [items])
	const lessonCount = useMemo(() => {
		const by = new Map<string, number>()
		for (const e of lessons) {
			const lib = sourceOf(e)?.library
			if (lib) by.set(libraryKey(lib).toLowerCase(), (by.get(libraryKey(lib).toLowerCase()) ?? 0) + 1)
		}
		return by
	}, [lessons])
	const found = useMemo(() => {
		const pool = items.filter((i) => source === 'all' || (sourceType(i) ?? 'none') === source).sort((a, b) => savedMs(b) - savedMs(a) || b.folder.localeCompare(a.folder))
		return query.trim() ? rankTitles(pool, query, titleOf) : pool
	}, [items, source, query])
	const shown = found.slice(0, show)

	return (
		<>
			<div className="wp-row-wrap">
				<SourceFilter value={source} counts={counts} onChange={(v) => (setSource(v), setShow(PAGE))} />
				<input className="wp-input wp-grow" style={{ minWidth: 180 }} placeholder="Search titles" aria-label="Search titles" value={query} onChange={(e) => (setQuery(e.target.value), setShow(PAGE))} />
			</div>
			<span className="wp-muted wp-small">
				Searches titles. To search inside notes: <code>wp-brain search</code>
			</span>
			<div className="wp-stack-sm">
				{loading ? (
					<Art name="reading" size={48} delay={400} />
				) : !shown.length ? (
					<div className="wp-card wp-muted">Nothing matches that.</div>
				) : (
					shown.map((i) => {
						const n = lessonCount.get(libraryKey(i.path).toLowerCase()) ?? 0
						return (
							<article key={i.path} className="wp-card wp-stack-sm">
								<div className="wp-between wp-small">
									<span className="wp-row-wrap">
										<SourceChip source={{ type: sourceType(i) ?? 'site', url: i.url, title: i.title, by: i.by }} />
										{i.by && <span className="wp-muted">{i.by}</span>}
									</span>
									<span className="wp-muted">{when(i)}</span>
								</div>
								<a className="wp-link" href={libraryHash(i.path)}>
									<strong>{titleOf(i)}</strong>
								</a>
								<span className="wp-muted wp-small">
									{n} {n === 1 ? 'lesson' : 'lessons'} · {texts(i) || 'no texts'}
									{i.words ? ` · ${i.words.toLocaleString()} words` : ''}
								</span>
							</article>
						)
					})
				)}
				{shown.length < found.length && (
					<button className="wp-btn wp-btn-sm" onClick={() => setShow(show + PAGE)}>
						Show {Math.min(PAGE, found.length - shown.length)} more of {found.length - shown.length}
					</button>
				)}
			</div>
		</>
	)
}

function Opened({ item, lessons, repo, branch, onChanged }: { item: LibraryItem; lessons: BridgeEntry[]; repo: string; branch: string; onChanged: () => void }) {
	const names = readingOrder(item.files)
	const [name, setName] = useState(names[0])
	// Text is held here only: never in storage, and gone when the page is.
	const [loaded, setLoaded] = useState<Record<string, string>>({})
	const [failed, setFailed] = useState<Record<string, string>>({})
	const key = `${item.path}/${name}`

	useEffect(() => setName(readingOrder(item.files)[0]), [item.path]) // eslint-disable-line react-hooks/exhaustive-deps
	useEffect(() => {
		if (!name || key in loaded) return
		let stale = false
		call('bridgeLibraryFile', item.path, name).then(
			(r) => !stale && (setLoaded((l) => ({ ...l, [key]: r.text })), setFailed((f) => ({ ...f, [key]: '' }))),
			(e) => !stale && setFailed((f) => ({ ...f, [key]: (e as Error).message })),
		)
		return () => {
			stale = true
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key])

	const mine = useMemo(() => {
		const f = { tags: [], has: [], library: libraryKey(item.path).toLowerCase() }
		return lessons.filter((e) => matchBrain(e, f))
	}, [lessons, item.path])
	const text = loaded[key]
	const big = text !== undefined && text.length > RENDER_MAX
	const type = sourceType(item)

	return (
		<>
			<div>
				<a className="wp-link wp-small" href="#/library">
					← All saved items
				</a>
			</div>
			<div className="wp-brain">
				<div className="wp-stack-sm">
					<h2 className="wp-h2" style={{ margin: 0 }}>
						{titleOf(item)}
					</h2>
					{names.length > 1 && (
						<span className="wp-row-wrap" role="group" aria-label="Text">
							{names.map((n) => (
								<button key={n} className={n === name ? 'wp-btn wp-btn-sm wp-btn-soft' : 'wp-btn wp-btn-sm'} aria-pressed={n === name} onClick={() => setName(n)}>
									{n}
								</button>
							))}
						</span>
					)}
					{!name ? (
						<div className="wp-card wp-muted">This folder holds no readable text.</div>
					) : failed[key] ? (
						<div className="wp-banner wp-small">{failed[key]}</div>
					) : text === undefined ? (
						<div className="wp-card">
							<Art name="reading" size={48} delay={400} />
							<span className="wp-muted wp-small">Opening {name}…</span>
						</div>
					) : big ? (
						<div className="wp-card wp-stack-sm">
							<div className="wp-banner wp-small">
								This text is {Math.round(text.length / 1000).toLocaleString()} KB. The first {RENDER_MAX / 1000} KB is shown as plain text.{' '}
								{repo && (
									<a className="wp-link" href={githubUrl(repo, branch, item.path, name)} target="_blank" rel="noreferrer">
										Open on GitHub
									</a>
								)}
							</div>
							<pre className="wp-lib-pre" data-testid="library-pre">
								{text.slice(0, RENDER_MAX)}
							</pre>
						</div>
					) : (
						<div className="wp-card" data-testid="library-text">
							<Markdown text={text} />
						</div>
					)}
				</div>
				<aside className="wp-stack-sm">
					<div className="wp-card wp-stack-sm wp-small">
						<span className="wp-eyebrow">Source</span>
						<SourceChip source={{ type: type ?? 'site', url: item.url, title: item.title, by: item.by }} />
						{item.by && <span>by {item.by}</span>}
						<span className="wp-muted">
							{[when(item) && `saved ${when(item)}`, item.words ? `${item.words.toLocaleString()} words` : ''].filter(Boolean).join(' · ') || 'No details saved'}
						</span>
						<span className="wp-muted">Library files have one writer, so they are read-only here.</span>
					</div>
					<span className="wp-eyebrow">
						{mine.length} {mine.length === 1 ? 'lesson' : 'lessons'} from this
					</span>
					{mine.map((e) => (
						<EntryCard
							key={e.id}
							e={e}
							onTicket={(k) => void (location.hash = brainHash({ ticket: k }))}
							onProject={(p) => void (location.hash = brainHash({ project: p }))}
							onChanged={onChanged}
						/>
					))}
				</aside>
			</div>
		</>
	)
}

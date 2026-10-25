// Notes you left on a page.
//
// You find something on a staging page at four o'clock — a total that ignores
// the discount, a form that accepts a blank, a thing to check before release.
// Today that becomes a line in a scratch file with no URL attached, or nothing
// at all. The page is where the problem is, so the page is where the note goes.
//
// All of it works on your own, on this machine, with nothing set up. Handing a
// note to the team is a separate, later, deliberate act — and the note stays
// yours either way.

import { useEffect, useState } from 'react'

import { clipLength, clipName, clipSize, type Clip } from '@/core/clip'
import { getBlob } from '@/lib/blobs'
import { ago } from '@/core/links'
import { call } from '@/lib/rpc'
import { ConfirmButton } from '@/ui/Confirm'
import { Icon } from '@/ui/Icon'
import { TicketPicker } from '@/ui/TicketPicker'
import { useAction, useLive } from '@/ui/hooks'
import { Art } from '@/ui/Art'

export function NotesView() {
	const { data: draft, reload: reloadDraft } = useLive(() => call('pageNoteDraft'))
	const { data: pages, reload } = useLive(() => call('notedPages'))
	const [open, setOpen] = useState<string | null>(null)
	const [big, setBig] = useState<string | null>(null)

	return (
		<div className="wp-stack">
			{/* Any picture, full size, over everything. */}
			{big && <Lightbox src={big} onClose={() => setBig(null)} />}

			<header className="wp-page-head">
				<div>
					<span className="wp-eyebrow">Where you found it</span>
					<h1 className="wp-h1">Notes on pages</h1>
					<p className="wp-muted wp-small" style={{ maxWidth: 560, margin: 0 }}>
						Right-click any page → <strong>note this page</strong>, or <span className="wp-kbd">⌥⇧K</span> → <strong>This page</strong>. It comes back when you open that
						page again — and you can hand any one of them to the team later.
					</p>
				</div>
			</header>

			{draft && <Composer draft={draft} onDone={async () => void (await reloadDraft(), await reload())} />}

			{!pages?.length ? (
				<div className="wp-card wp-muted">
					<Art name="empty-notes" size={96} />
					Nothing noted yet. The first one is usually a bug on a staging page you will not remember by Thursday.
				</div>
			) : (
				pages.map((p) => (
					<section key={p.key} className="wp-card wp-stack-sm">
						{/* The row itself opens it. A button that says "Read 3" beside a
						    title that does the same thing is one control too many. */}
						<div className="wp-between">
							<button className="wp-action wp-grow" style={{ textAlign: 'left', minWidth: 0 }} onClick={() => setOpen(open === p.key ? null : p.key)} aria-expanded={open === p.key}>
								<span aria-hidden>{open === p.key ? '▾' : '▸'}</span> <strong>{p.title}</strong>
								<span className="wp-muted"> · {p.total} note{p.total === 1 ? '' : 's'}</span>
								<div className="wp-muted wp-small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingLeft: 14 }}>
									{p.url}
								</div>
							</button>
							<span className="wp-row">
								{!!p.open && <span className="wp-chip wp-chip-warn">{p.open} open</span>}
								<a className="wp-icon-btn" href={p.url} target="_blank" rel="noreferrer" title="Open this page in a new tab" aria-label="Open this page">
									<Icon name="external" size={14} />
								</a>
							</span>
						</div>
						{open === p.key && <OnePage url={p.url} onChanged={reload} onZoom={setBig} />}
					</section>
				))
			)}
		</div>
	)
}

/**
 * A recording, played where it sits.
 *
 * The video is in the blob store rather than in the note — megabytes through
 * the notes list, on every read, for something the list never shows. It is
 * fetched when somebody actually asks to watch it.
 *
 * Read straight out of IndexedDB and played from an object URL. This page is
 * the same origin as the worker, so routing it through a message would only
 * mean base64 — a third larger again, and past what a message can carry long
 * before an hour of video.
 */
/**
 * MediaRecorder writes no duration into the webm header.
 *
 * It cannot: it is still recording when it writes the header, so the length is
 * not known yet. Every player therefore reports `Infinity`, shows no timeline
 * and refuses to seek — which for a twenty-minute recording means the only way
 * to reach minute twelve is to watch eleven. Seeking past the end once makes
 * the browser scan the file and work the real duration out, after which the
 * scrubber behaves like any other video's.
 */
function fixDuration(v: HTMLVideoElement) {
	if (Number.isFinite(v.duration) && v.duration > 0) return
	const done = () => {
		v.removeEventListener('timeupdate', done)
		v.currentTime = 0
	}
	v.addEventListener('timeupdate', done)
	v.currentTime = 1e101
}

function ClipPlayer({ clip, noteId }: { clip: Clip; noteId: string }) {
	const [src, setSrc] = useState<string | null>(null)
	const [link, setLink] = useState(clip.url ?? '')
	const { busy, error, run } = useAction()
	useEffect(() => () => void (src && URL.revokeObjectURL(src)), [src])

	const open = () =>
		run(async () => {
			const blob = await getBlob(clip.id)
			if (!blob) throw new Error('That recording is no longer kept on this machine.')
			setSrc(URL.createObjectURL(blob))
		})

	if (!src)
		return (
			<>
				<button className="wp-clip-open" disabled={busy} title={`Play the ${clipLength(clip.ms)} recording`} onClick={open}>
					<Icon name="play" size={14} />
					<span>
						{clipLength(clip.ms)} recording <span className="wp-muted">· {clipSize(clip.bytes)}</span>
					</span>
				</button>
				{error && <div className="wp-error wp-small">{error}</div>}
			</>
		)

	return (
		<div className="wp-stack">
			<video className="wp-clip" src={src} controls autoPlay playsInline onLoadedMetadata={(e) => fixDuration(e.currentTarget)} />
			<div className="wp-row wp-small">
				{/* A plain link, not chrome.downloads: this is an extension page,
				    the object URL is already in hand, and a download permission on
				    the install prompt would be a price paid for a Save button. */}
				<a className="wp-link wp-row" href={src} download={`${clipName(clip)}.webm`} title="Save this recording to your computer">
					<Icon name="download" size={12} /> Save · {clipSize(clip.bytes)}
				</a>
				{link ? (
					<a className="wp-link wp-row" href={link} target="_blank" rel="noreferrer" title="The uploaded copy — paste this into the ticket">
						<Icon name="external" size={12} /> Link
					</a>
				) : (
					<button
						className="wp-action wp-muted wp-row"
						disabled={busy}
						title="Upload to your backup repository as a release asset, and get a URL to paste into the ticket"
						onClick={() => run(async () => setLink((await call('shareClip', noteId)).url))}
					>
						<Icon name="github" size={12} /> Upload
					</button>
				)}
			</div>
			{error && <div className="wp-error wp-small">{error}</div>}
		</div>
	)
}

/** One picture, as large as the window allows. Escape or a click closes it. */
function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
	useEffect(() => {
		const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
		document.addEventListener('keydown', esc)
		return () => document.removeEventListener('keydown', esc)
	}, [onClose])
	return (
		<div className="wp-lightbox" onClick={onClose} role="dialog" aria-label="Screenshot">
			<img src={src} alt="The page as it was captured" />
			<span className="wp-muted wp-small">Click anywhere, or press Escape</span>
		</div>
	)
}

/** The notes on one page, with what can be done to each. */
export function OnePage({ url, onChanged, onZoom }: { url: string; onChanged?: () => Promise<unknown>; onZoom?: (src: string) => void }) {
	const { data, reload } = useLive(() => call('notesOnPage', url), [url])
	const { data: team } = useLive(() => call('teamState'))
	const [filing, setFiling] = useState<string | null>(null)
	const [naming, setNaming] = useState<string | null>(null)
	const [name, setName] = useState('')
	const { busy, error, run } = useAction()
	const now = Date.now()
	if (!data?.notes.length) return <span className="wp-muted wp-small">Nothing on this page.</span>

	const after = async () => {
		await reload()
		await onChanged?.()
	}

	return (
		<div className="wp-stack-sm wp-small">
			{data.notes.map((n) => (
				<div key={n.localId ?? n.number} className="wp-card-flat wp-stack-sm">
					<div className="wp-between">
						<span className="wp-row" style={{ minWidth: 0 }}>
							<strong>{n.source === 'team' ? n.author : 'You'}</strong>
							<span className="wp-muted">{ago(n.at, now)}</span>
							{n.state === 'closed' && <span className="wp-chip wp-chip-ok">dealt with</span>}
							{n.number && <span className="wp-chip">shared · #{n.number}</span>}
							{/* Which ticket it is filed under — and the same key is in the
							    filename of its screenshot, so one search finds both. */}
							{n.ticketId && data.tickets[n.ticketId] && (
								<a className="wp-chip wp-chip-accent" href={`#/links/${n.ticketId}`} title="Open this ticket">
									{data.tickets[n.ticketId]}
								</a>
							)}
						</span>

						{/* Icons, each saying what it does on hover — the words were
						    taking more room than the note. */}
						{n.localId && (
							<span className="wp-row">
								<button
									className="wp-icon-btn"
									disabled={busy}
									title={n.state === 'closed' ? 'Put it back on the list' : 'Mark it dealt with — it is kept either way'}
									aria-label={n.state === 'closed' ? 'Put it back' : 'Mark dealt with'}
									onClick={() => run(async () => void (await call('noteDone', n.localId!, n.state !== 'closed'), await after()))}
								>
									<Icon name="check" size={14} />
								</button>
								<button
									className="wp-icon-btn"
									disabled={busy}
									title="Rename this note — the page's own title is rarely yours"
									aria-label="Rename this note"
									onClick={() => {
										setNaming(naming === n.localId ? null : n.localId!)
										setName(n.title)
									}}
								>
									<Icon name="pencil" size={14} />
								</button>
								<button
									className="wp-icon-btn"
									disabled={busy}
									title="File it under a ticket, so it turns up with that work"
									aria-label="File under a ticket"
									onClick={() => setFiling(filing === n.localId ? null : n.localId!)}
								>
									<Icon name="group" size={14} />
								</button>
								{!n.number &&
									(team?.repo ? (
										<button
											className="wp-icon-btn"
											disabled={busy}
											title="Hand it to the team — it becomes an issue in the shared repository"
											aria-label="Share with the team"
											onClick={() => run(async () => void (await call('shareNote', n.localId!), await after()))}
										>
											<Icon name="github" size={14} />
										</button>
									) : (
										<a className="wp-icon-btn" href="#/team" title="Set up a team, then you can hand notes over" aria-label="Set up a team">
											<Icon name="github" size={14} />
										</a>
									))}
								<ConfirmButton
									className="wp-icon-btn"
									question="Delete this note?"
									confirmLabel="Delete it"
									disabled={busy}
									onConfirm={() => run(async () => void (await call('deletePageNote', n.localId!), await after()))}
								>
									<Icon name="trash" size={14} />
								</ConfirmButton>
							</span>
						)}
					</div>

					{naming === n.localId ? (
						<div className="wp-row">
							<input
								className="wp-input wp-sm wp-grow"
								autoFocus
								value={name}
								onChange={(e) => setName(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === 'Escape') setNaming(null)
									if (e.key === 'Enter' && name.trim()) void run(async () => void (await call('renameNote', n.localId!, name), setNaming(null), await after()))
								}}
							/>
							<button className="wp-btn wp-btn-sm wp-btn-primary" disabled={busy || !name.trim()} onClick={() => run(async () => void (await call('renameNote', n.localId!, name), setNaming(null), await after()))}>
								Rename
							</button>
						</div>
					) : (
						<strong>{n.title}</strong>
					)}

					<div style={{ whiteSpace: 'pre-wrap' }}>{n.text}</div>

					{/* The picture itself, not a disclosure triangle in front of it. */}
					{n.shot && (
						<button className="wp-shot-thumb" onClick={() => onZoom?.(n.shot!)} title="See it full size">
							<img src={n.shot} alt="The page as it was captured" />
						</button>
					)}

					{/* And the recording, played where it is rather than downloaded. */}
					{n.clip && n.localId && <ClipPlayer clip={n.clip} noteId={n.localId} />}

					{filing === n.localId && (
						<div className="wp-card">
							<TicketPicker
								url={n.url}
								text={n.text}
								onPick={(ticketId) => run(async () => void (await call('noteToTicket', n.localId!, ticketId), setFiling(null), await after()))}
								onCancel={() => setFiling(null)}
							/>
						</div>
					)}

					{!!n.replies?.length && <div className="wp-muted">{n.replies.map((r) => `${r.author}: ${r.text}`).join(' · ')}</div>}
				</div>
			))}
			{error && <div className="wp-error">{error}</div>}
		</div>
	)
}

/** Which ticket this note belongs to, if any. */
function Ticket({ noteId, url, onChanged }: { noteId: string; url?: string; onChanged: () => Promise<unknown> }) {
	const { data: tickets } = useLive(() => call('ticketList'))
	// The ticket it is probably about, worked out from the address — so the
	// common case is one click and the dropdown is for the rest.
	const { data: likely } = useLive(() => (url ? call('ticketFor', url) : Promise.resolve(null)), [url])
	const [open, setOpen] = useState(false)
	const { busy, run } = useAction()
	if (!tickets?.length) return null

	if (!open)
		return (
			<span className="wp-row">
				{likely && (
					<button
						className="wp-action"
						disabled={busy}
						title={`Because ${likely.why}`}
						onClick={() => run(async () => void (await call('noteToTicket', noteId, likely.id), await onChanged()))}
					>
						<Icon name="group" size={12} /> File under {likely.name}
					</button>
				)}
				<button className="wp-action wp-muted" onClick={() => setOpen(true)} title="File this under a ticket">
					{likely ? 'another ticket…' : (
						<>
							<Icon name="group" size={12} /> File under a ticket
						</>
					)}
				</button>
			</span>
		)

	return (
		<select
			className="wp-select wp-sm"
			style={{ maxWidth: 220 }}
			autoFocus
			defaultValue=""
			disabled={busy}
			onBlur={() => setOpen(false)}
			onChange={(e) => e.target.value && run(async () => void (await call('noteToTicket', noteId, e.target.value), setOpen(false), await onChanged()))}
		>
			<option value="">Pick a ticket…</option>
			{tickets.map((t) => (
				<option key={t.id} value={t.id}>
					{t.name}
				</option>
			))}
		</select>
	)
}

/** The composer, opened from the right-click menu with the screenshot taken. */
function Composer({ draft, onDone }: { draft: { url: string; title?: string; where?: string; shot?: string }; onDone: () => Promise<unknown> }) {
	const [text, setText] = useState('')
	// `null` means dropped on purpose; undefined means "whatever the draft had".
	const [shot, setShot] = useState<string | null | undefined>(undefined)
	const pic = shot === undefined ? draft.shot : shot
	const { busy, error, run } = useAction()

	return (
		<section className="wp-card wp-stack">
			<div>
				<span className="wp-eyebrow">On this page</span>
				<h2 className="wp-h2">{draft.title ?? draft.url}</h2>
				<div className="wp-muted wp-small" style={{ wordBreak: 'break-all' }}>{draft.url}</div>
			</div>
			<textarea
				className="wp-textarea"
				rows={4}
				autoFocus
				placeholder="What is wrong, or what to remember about this page. It comes back when you open it again."
				value={text}
				onChange={(e) => setText(e.target.value)}
				onPaste={(e) => {
					// Your own crop — ⌘⇧4, Snip — beats anything the browser can take
					// of itself, and pasting is where anyone would try to put it.
					const file = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'))?.getAsFile()
					if (!file) return
					e.preventDefault()
					const reader = new FileReader()
					reader.onload = () => setShot(String(reader.result))
					reader.readAsDataURL(file)
				}}
			/>
			{draft.where && (
				<div className="wp-small">
					<span className="wp-eyebrow">What you had selected</span>
					<div className="wp-muted">{draft.where}</div>
				</div>
			)}
			{/* Taken for you when the menu took it; replaced by anything you paste;
			    dropped in one click if the words are the whole point. */}
			{pic ? (
				<div className="wp-stack-sm">
					<span className="wp-eyebrow">What was captured — the visible page, as it was</span>
					<img src={pic} alt="The page as it was captured" style={{ width: '100%', borderRadius: 10, border: '1px solid var(--wp-border)' }} />
					<span className="wp-row wp-small">
						<button className="wp-action wp-muted" onClick={() => setShot(null)}>
							Drop the picture
						</button>
						<span className="wp-muted">or paste your own into the box above</span>
					</span>
				</div>
			) : (
				<span className="wp-muted wp-small">No picture. Paste one into the box above — ⌘⇧4 on a Mac, Snip on Windows.</span>
			)}
			{error && <div className="wp-error">{error}</div>}
			<div className="wp-row">
				<button
					className="wp-btn wp-btn-primary"
					disabled={busy || !text.trim()}
					onClick={() =>
						run(async () => {
							await call('noteOnPage', { url: draft.url, title: draft.title, text, where: draft.where, shot: pic ?? undefined })
							await call('clearPageNoteDraft')
							setText('')
							await onDone()
						})
					}
				>
					Keep it
				</button>
				<span className="wp-muted wp-small">Stays on this machine. You can hand it to the team afterwards.</span>
				<button className="wp-action wp-muted" disabled={busy} onClick={() => run(async () => void (await call('clearPageNoteDraft'), await onDone()))}>
					Throw it away
				</button>
			</div>
		</section>
	)
}

/**
 * The notes left on this ticket's pages.
 *
 * A bug found on a staging page belongs with the ticket it is about, not in a
 * separate list nobody opens — so once a note is filed under one, this is where
 * it turns up.
 */
export function TicketPageNotes({ ticketId }: { ticketId: string }) {
	const { data, reload } = useLive(() => call('ticketNotes', ticketId), [ticketId])
	const [big, setBig] = useState<string | null>(null)
	const { busy, run } = useAction()
	const now = Date.now()
	if (!data?.length) return null

	return (
		<section className="wp-card wp-stack-sm">
			{big && <Lightbox src={big} onClose={() => setBig(null)} />}
			<span className="wp-eyebrow">Found on this ticket's pages</span>
			{data.map((n) => (
				<div key={n.id} className="wp-card-flat wp-stack-sm wp-small">
					<div className="wp-between">
						<span className="wp-grow" style={{ minWidth: 0 }}>
							<strong>{n.title}</strong> <span className="wp-muted">· {ago(n.at, now)}</span>
							{n.doneAt && <span className="wp-chip wp-chip-ok" style={{ marginLeft: 6 }}>dealt with</span>}
						</span>
						<span className="wp-row">
							<a className="wp-btn wp-btn-sm wp-btn-ghost" href={n.url} target="_blank" rel="noreferrer" title={n.url}>
								<Icon name="external" size={12} />
							</a>
							<button
								className="wp-icon-btn"
								disabled={busy}
								title="Take it out of this ticket — the note itself is kept"
								aria-label="Take it out of this ticket"
								onClick={() => run(async () => void (await call('noteToTicket', n.id, ''), await reload()))}
							>
								<Icon name="move" size={14} />
							</button>
						</span>
					</div>
					<div style={{ whiteSpace: 'pre-wrap' }}>{n.text}</div>
					{n.shot && (
						<button className="wp-shot-thumb" onClick={() => setBig(n.shot!)} title="See it full size">
							<img src={n.shot} alt="The page as it was captured" />
						</button>
					)}
					{n.shotDropped && <span className="wp-muted">The screenshot was let go to keep the disk sane — the words are all here.</span>}
				</div>
			))}
		</section>
	)
}

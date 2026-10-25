// What you learned and what you got wrong, by day. The record Jira cannot hold:
// nobody is appraised on this, so it can be honest — and it exports, so you
// decide what ever leaves this machine.

import { useMemo, useState } from 'react'

import { brainLearnings, fromBrain } from '@/core/bridge-learn'
import { fileName, learningsCsv, learningsMarkdown } from '@/core/export'
import { enabled } from '@/core/features'
import { KIND_LABEL, matchLearning, repeats, type LearnKind, type Learning, type TagCount } from '@/core/learn'
import { ticketKey, type TicketRow } from '@/core/links'
import { addDays, istDate, prettyDate } from '@/core/time'
import { call } from '@/lib/rpc'
import { useAction, useLive } from '@/ui/hooks'
import { Markdown } from '@/ui/Markdown'
import { NoteEditor } from '@/ui/NoteEditor'
import { TagPicker } from '@/ui/TagPicker'
import { DateField } from '@/ui/TimeField'
import { Art } from '@/ui/Art'

const PAGE = 30
const KINDS: LearnKind[] = ['learning', 'mistake', 'howto']
const KIND_COLOUR: Record<LearnKind, string> = { learning: 'var(--wp-ok)', mistake: 'var(--wp-danger)', howto: 'var(--wp-accent)' }

/** Offers the text as a file. An extension page may do this; a blob needs no host. */
function download(name: string, text: string, type: string) {
	const url = URL.createObjectURL(new Blob([text], { type }))
	const a = document.createElement('a')
	a.href = url
	a.download = name
	a.click()
	setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function JournalView() {
	const { data: local, reload } = useLive(() => call('learnings'))
	const { data: localAgain } = useLive(() => call('learnRepeats'))
	const { data: known } = useLive(() => call('learnTags'))
	const { data: tickets } = useLive(() => call('ticketList'))
	// What Claude Code recorded in the Brain, in the same list: one place for
	// every mistake, so "keeps coming back" counts all of them.
	const brainOn = enabled('BRAIN') && enabled('BRIDGE_SYNC')
	const { data: brain } = useLive(() => (brainOn ? call('bridge') : Promise.resolve(null)))
	const [withBrain, setWithBrain] = useState(true)
	const fromCli = useMemo(
		() => (brain?.ready ? brainLearnings(brain.entries, (tickets ?? []).map((t) => ({ id: t.id, key: ticketKey(t.name) }))) : []),
		[brain, tickets],
	)
	const items = useMemo(() => (local ? [...local, ...(withBrain ? fromCli : [])].sort((a, b) => b.at - a.at) : local), [local, fromCli, withBrain])
	const again = useMemo(() => (withBrain && fromCli.length && items ? repeats(items, Date.now()) : localAgain), [withBrain, fromCli, items, localAgain])
	const [openTag, setOpenTag] = useState<string | null>(null)
	const [query, setQuery] = useState('')
	const [kind, setKind] = useState<LearnKind | 'all'>('all')
	const [adding, setAdding] = useState(false)
	const [editing, setEditing] = useState<string | null>(null)
	const [show, setShow] = useState(PAGE)
	const today = istDate(Date.now())

	const found = useMemo(() => (items ?? []).filter((l) => (kind === 'all' || l.kind === kind) && matchLearning(l, query)), [items, query, kind])
	// Thirty notes at a time. A hundred days of notes is the point of keeping
	// them, and also more Markdown than any screen needs rendered at once.
	const shown = found.slice(0, show)
	const days = [...new Set(shown.map((l) => l.date))].sort((a, b) => b.localeCompare(a))

	return (
		<div className="wp-stack">
			<header className="wp-page-head">
				<div>
					<span className="wp-eyebrow">Private to this machine</span>
					<h1 className="wp-h1">Learnings &amp; mistakes</h1>
					<p className="wp-muted wp-small" style={{ maxWidth: 520, margin: 0 }}>
						One line a day about what you learned or would not repeat. Private to this machine — tag it with <code>#ci</code>, <code>#mysql</code>, and find it again in six months.
					</p>
				</div>
				<div className="wp-row">
					{/* The export takes everything the filter matches, not the page of
					    it that happens to be drawn. */}
					<button className="wp-btn wp-btn-sm" disabled={!found.length} onClick={() => download(fileName('learnings', 'md', today), learningsMarkdown(found), 'text/markdown')}>
						Export .md {found.length !== items?.length ? `(${found.length})` : ''}
					</button>
					<button className="wp-btn wp-btn-sm" disabled={!found.length} onClick={() => download(fileName('learnings', 'csv', today), learningsCsv(found), 'text/csv')}>
						Export .csv
					</button>
				</div>
			</header>

			{/* The third time is the one worth knowing about. */}
			{!!again?.length && (
				<div className="wp-card wp-stack-sm">
					<span className="wp-row-wrap wp-small">
						<span className="wp-eyebrow" style={{ marginRight: 4 }}>
							Keeps coming back
						</span>
						{again.slice(0, 6).map((r) => (
							<button
								key={r.tag}
								className={openTag === r.tag ? 'wp-chip wp-chip-accent' : 'wp-chip wp-chip-warn'}
								onClick={() => setOpenTag(openTag === r.tag ? null : r.tag)}
								aria-expanded={openTag === r.tag}
							>
								#{r.tag} ×{r.count}
							</button>
						))}
					</span>
					{/* The count is the warning; what you wrote the last two times is
					    the part that stops it happening again. */}
					{openTag && <Behind tag={openTag} onSearch={() => setQuery(openTag)} />}
				</div>
			)}

			<div className="wp-row-wrap">
				<button className="wp-btn wp-btn-sm wp-btn-primary" onClick={() => setAdding(true)} disabled={adding}>
					+ Add a note
				</button>
				<span className="wp-row">
					{(['all', ...KINDS] as const).map((k) => (
						<button key={k} className={kind === k ? 'wp-btn wp-btn-sm wp-btn-soft' : 'wp-btn wp-btn-sm'} onClick={() => setKind(k)} aria-pressed={kind === k}>
							{k === 'all' ? 'Everything' : KIND_LABEL[k]}
						</button>
					))}
				</span>
				{!!fromCli.length && (
					<button className={withBrain ? 'wp-btn wp-btn-sm wp-btn-soft' : 'wp-btn wp-btn-sm'} aria-pressed={withBrain} onClick={() => setWithBrain(!withBrain)} title="Learnings and mistakes from the Brain — Claude Code and your other devices">
						Brain {fromCli.length}
					</button>
				)}
				<input className="wp-input wp-grow" style={{ minWidth: 180 }} placeholder="Search a word or a #tag…" value={query} onChange={(e) => setQuery(e.target.value)} />
			</div>

			{!!known?.length && (
				<div className="wp-row-wrap wp-small">
					{known.slice(0, 18).map((t) => (
						<button key={t.tag} className={query === t.tag ? 'wp-chip wp-chip-accent' : 'wp-chip'} onClick={() => setQuery(query === t.tag ? '' : t.tag)}>
							#{t.tag} <span className="wp-muted">{t.count}</span>
						</button>
					))}
					{!!query && (
						<button className="wp-action" onClick={() => setQuery('')}>
							clear
						</button>
					)}
				</div>
			)}

			{adding && <Editor today={today} known={known ?? []} onDone={() => setAdding(false)} onSaved={reload} />}

			{!!items?.length && (
				<div className="wp-between wp-small wp-muted">
					<span>{found.length === items.length ? `${items.length} notes` : `${found.length} of ${items.length}`}</span>
					<span>{shown.length < found.length ? `showing ${shown.length}` : ''}</span>
				</div>
			)}

			{!items?.length && !adding ? (
				<div className="wp-card wp-muted">
					<Art name="empty-journal" size={96} />
					Nothing yet. At the end of a day, WorkPulse asks once — a line here is worth more in three months than the same line in a ticket comment nobody reads again.
				</div>
			) : !shown.length ? (
				<div className="wp-card wp-muted">Nothing matches that.</div>
			) : (
				days.map((date) => (
					<section key={date} className="wp-stack-sm">
						<span className="wp-eyebrow">{date === today ? 'Today' : date === addDays(today, -1) ? 'Yesterday' : prettyDate(date)}</span>
						{shown
							.filter((l) => l.date === date)
							.map((l) =>
								fromBrain(l) ? (
									<BrainNote key={l.id} note={l} tickets={tickets ?? []} onTag={setQuery} />
								) : editing === l.id ? (
									<Editor key={l.id} today={today} known={known ?? []} note={l} onDone={() => setEditing(null)} onSaved={reload} />
								) : (
									<Note key={l.id} note={l} tickets={tickets ?? []} onEdit={() => setEditing(l.id)} onSaved={reload} onTag={setQuery} />
								),
							)}
					</section>
				))
			)}

			{found.length > shown.length && (
				<button className="wp-btn" onClick={() => setShow(show + PAGE)}>
					Show {Math.min(PAGE, found.length - shown.length)} more of {found.length - shown.length}
				</button>
			)}
		</div>
	)
}

/**
 * A line Claude Code recorded. Read-only here: it lives in the Brain, written by
 * another device, and editing it in place would mean writing into a file this
 * browser does not own. The Brain page is where to add to it.
 */
function BrainNote({ note, tickets, onTag }: { note: Learning; tickets: TicketRow[]; onTag: (t: string) => void }) {
	const ticket = tickets.find((w) => w.id === note.ticketId)
	return (
		<div className="wp-card wp-stack-sm">
			<div className="wp-between">
				<span className="wp-row wp-small">
					<span className="wp-dot" style={{ background: KIND_COLOUR[note.kind] }} />
					<strong>{KIND_LABEL[note.kind]}</strong>
					<span className="wp-chip wp-chip-accent">Brain</span>
					{note.tags.map((t) => (
						<button key={t} className="wp-chip" onClick={() => onTag(t)}>
							#{t}
						</button>
					))}
				</span>
				<span className="wp-row wp-small">
					{ticket && (
						<a className="wp-chip" href={`#/links/${ticket.id}`} title="Open this ticket">
							{ticket.name}
						</a>
					)}
					<a className="wp-link" href="#/brain">
						In the Brain →
					</a>
				</span>
			</div>
			<Markdown text={note.text} />
		</div>
	)
}

function Note({ note, tickets, onEdit, onSaved, onTag }: { note: Learning; tickets: TicketRow[]; onEdit: () => void; onSaved: () => Promise<unknown>; onTag: (t: string) => void }) {
	const { busy, run } = useAction()
	const [linking, setLinking] = useState(false)
	const ticket = tickets.find((w) => w.id === note.ticketId)
	return (
		<div className="wp-card wp-stack-sm">
			<div className="wp-between">
				<span className="wp-row wp-small">
					<span className="wp-dot" style={{ background: KIND_COLOUR[note.kind] }} />
					<strong>{KIND_LABEL[note.kind]}</strong>
					{note.tags.map((t) => (
						<button key={t} className="wp-chip" onClick={() => onTag(t)}>
							#{t}
						</button>
					))}
				</span>
				<span className="wp-row wp-small">
					{/* Half of what you learn only turns out to belong to a ticket later,
					    so this is editable for as long as the note exists. The picker is
					    only built when you open it: a hundred notes each holding a
					    hundred options is ten thousand elements nobody asked for. */}
					{linking ? (
						<select
							className="wp-select wp-sm"
							style={{ maxWidth: 200 }}
							autoFocus
							value={note.ticketId ?? ''}
							disabled={busy}
							onBlur={() => setLinking(false)}
							onChange={(e) => run(async () => void (await call('linkLearning', note.id, e.target.value || null), setLinking(false), await onSaved()))}
						>
							<option value="">No ticket</option>
							{tickets.map((w) => (
								<option key={w.id} value={w.id}>
									{w.name}
								</option>
							))}
						</select>
					) : (
						<button className={ticket ? 'wp-chip' : 'wp-action wp-muted'} onClick={() => setLinking(true)} title="Link this to a ticket">
							{ticket ? ticket.name : '+ ticket'}
						</button>
					)}
					{ticket && !linking && (
						<a className="wp-link" href={`#/links/${ticket.id}`} title="Open this ticket">
							→
						</a>
					)}
					<button className="wp-action" onClick={onEdit}>
						Edit
					</button>
					<button className="wp-action wp-action-danger wp-muted" disabled={busy} onClick={() => run(async () => void (await call('deleteLearning', note.id), await onSaved()))}>
						Delete
					</button>
				</span>
			</div>
			<Markdown text={note.text} />
		</div>
	)
}

function Editor({ note, today, known, onDone, onSaved }: { note?: Learning; today: string; known: TagCount[]; onDone: () => void; onSaved: () => Promise<unknown> }) {
	const [text, setText] = useState(note?.text ?? '')
	const [kind, setKind] = useState<LearnKind>(note?.kind ?? 'learning')
	const [date, setDate] = useState(note?.date ?? today)
	const { busy, error, run } = useAction()

	const save = () =>
		run(async () => {
			await call('saveLearning', { id: note?.id, text, kind, date })
			await onSaved()
			onDone()
		})

	return (
		<div className="wp-card wp-stack-sm">
			<div
				onKeyDown={(e) => {
					if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && text.trim()) void save()
					if (e.key === 'Escape') onDone()
				}}
			>
				<NoteEditor value={text} onChange={setText} autoFocus />
			</div>
			<TagPicker text={text} onChange={setText} known={known} />
			{error && <div className="wp-error wp-small">{error}</div>}
			<div className="wp-between wp-small">
				<span className="wp-row">
					{KINDS.map((k) => (
						<button key={k} className={kind === k ? 'wp-btn wp-btn-sm wp-btn-soft' : 'wp-btn wp-btn-sm'} onClick={() => setKind(k)} aria-pressed={kind === k}>
							{KIND_LABEL[k]}
						</button>
					))}
					<DateField label="The day this belongs to" value={date} max={today} onChange={(v) => setDate(v || today)} width={140} />
				</span>
				<span className="wp-row">
					<button className="wp-btn wp-btn-sm wp-btn-ghost" onClick={onDone}>
						Cancel
					</button>
					<button className="wp-btn wp-btn-sm wp-btn-primary" disabled={busy || !text.trim()} onClick={save}>
						Save
					</button>
				</span>
			</div>
			<span className="wp-muted wp-small">⌘↵ saves · a tag is how this comes back to you in six months</span>
		</div>
	)
}

/** The notes behind a repeating mistake, oldest first. */
function Behind({ tag, onSearch }: { tag: string; onSearch: () => void }) {
	const { data } = useLive(() => call('learnBehind', tag), [tag])
	if (!data?.length) return null
	return (
		<div className="wp-stack-sm wp-small">
			{data.map((l) => (
				<div key={l.id} className="wp-card-flat">
					<span className="wp-muted">{l.date}</span>
					<Markdown text={l.text} />
				</div>
			))}
			<button className="wp-action" onClick={onSearch}>
				Show everything tagged #{tag}
			</button>
		</div>
	)
}

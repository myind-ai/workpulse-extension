// Every ticket's links and notes. Two layouts over the same data: the list, and
// one ticket's own page — which is what opens at the head of its tab group.

import { useEffect, useMemo, useState } from 'react'

import { addedTogether, ago, labelFor, matchesRow, SORT_LABEL, sortTickets, ticketKey, type TicketRow, type TicketSort } from '@/core/links'
import { call } from '@/lib/rpc'
import type { Workspace } from '@/lib/store'
import { useAction, useLive } from '@/ui/hooks'
import { Icon } from '@/ui/Icon'
import { Menu, type MenuItem } from '@/ui/Menu'
import { Undo } from '@/ui/Undo'

import { TicketBrain } from './TicketBrain'
import { TicketLearnings } from './TicketLearnings'
import { TicketPageNotes } from './Notes'
import { TicketNotes } from './TicketNotes'
import { Art } from '@/ui/Art'

const PAGE = 20

export function LinksView({ id }: { id?: string }) {
	// The list runs on the light projection: at a hundred tickets the full
	// records — every link, every note — are a payload a list cannot use.
	const [withArchived, setWithArchived] = useState(false)
	const { data: rows, reload } = useLive(() => call('ticketList', withArchived), [withArchived])
	const [query, setQuery] = useState('')
	const [sort, setSort] = useState<TicketSort>('activity')
	const [show, setShow] = useState(PAGE)
	const [open, setOpen] = useState<string | null>(null)
	const [canName, setCanName] = useState(true)

	useEffect(() => {
		void chrome.permissions.contains({ permissions: ['tabGroups'] }).then(setCanName)
	}, [])

	const shown = useMemo(() => sortTickets((rows ?? []).filter((w) => matchesRow(w, query)), sort), [rows, query, sort])

	if (id) {
		if (!rows) return <div className="wp-muted">Loading…</div>
		return <TicketPage id={id} />
	}

	return (
		<div className="wp-stack">
			<header className="wp-page-head">
				<div>
					<span className="wp-eyebrow">Your work</span>
					<h1 className="wp-h1">Tickets &amp; links</h1>
					<p className="wp-muted wp-small" style={{ maxWidth: 520, margin: 0 }}>The PR, the dev deploy, the stage link, the test cases — kept under the ticket, with a label each and the day's notes.</p>
				</div>
				<input className="wp-input" style={{ maxWidth: 260 }} placeholder="Search PAY-2433, “stage”, a URL…" value={query} onChange={(e) => setQuery(e.target.value)} />
			</header>

			{/* Chrome groups the tabs either way; putting the ticket's name on the
			    group is the part that needs asking for. */}
			{!canName && !!rows?.length && (
				<div className="wp-banner">
					<span className="wp-grow">Chrome can label each group with the ticket name.</span>
					<button className="wp-btn wp-btn-sm" onClick={() => void chrome.permissions.request({ permissions: ['tabGroups'] }).then(setCanName)}>
						Allow naming
					</button>
				</div>
			)}

			{!!rows?.length && (
				<div className="wp-between wp-small">
					<span className="wp-row">
						<span className="wp-muted">Sort</span>
						{(Object.keys(SORT_LABEL) as TicketSort[]).map((k) => (
							<button key={k} className={sort === k ? 'wp-btn wp-btn-sm wp-btn-soft' : 'wp-btn wp-btn-sm'} onClick={() => setSort(k)} aria-pressed={sort === k}>
								{SORT_LABEL[k]}
							</button>
						))}
					</span>
					<span className="wp-row">
						<button className={withArchived ? 'wp-action' : 'wp-action wp-muted'} onClick={() => setWithArchived(!withArchived)}>
							{withArchived ? 'Hide archived' : 'Show archived'}
						</button>
						<span className="wp-muted">{shown.length === rows.length ? `${rows.length} tickets` : `${shown.length} of ${rows.length}`}</span>
					</span>
				</div>
			)}

			{/* One for the page. It used to render inside every ticket row — the
			    same global button, N times over, with its text squeezing the
			    titles beside it. */}
			<Undo onUndone={reload} />

			{!rows?.length ? (
				<div className="wp-card wp-muted">
					<Art name="empty-links" size={96} />
					Nothing saved yet. In the widget, tick the tabs for what you are on, pick <strong>A new ticket…</strong>, and name it after the ticket —{' '}
					<code>PAY-2433 financing button</code>. Opening it again brings the tabs back as one named Chrome group, with this ticket's page at the front.
				</div>
			) : !shown.length ? (
				<div className="wp-card wp-muted">Nothing matches “{query}”.</div>
			) : (
				<>
					{shown.slice(0, show).map((w) => (
						<Row key={w.id} row={w} expanded={open === w.id} onToggle={() => setOpen(open === w.id ? null : w.id)} reload={reload} others={(rows ?? []).filter((o) => o.id !== w.id)} />
					))}
					{/* Twenty at a time: search and sort run over all of them, so the
					    one you want is reachable without drawing a hundred rows. */}
					{shown.length > show && (
						<button className="wp-btn" onClick={() => setShow(show + PAGE)}>
							Show {Math.min(PAGE, shown.length - show)} more of {shown.length - show}
						</button>
					)}
				</>
			)}
		</div>
	)
}

const Gone = () => (
	<div className="wp-card wp-muted">
		That ticket is no longer saved. <a className="wp-link" href="#/links">See all tickets</a>.
	</div>
)

/** Name, key chip and counts — the same heading in the list and on the page. */
/**
 * Name, key chip and counts — the same heading in the list and on the page, and
 * the same place the name is edited. Renaming anywhere else leaves the old name
 * sitting on the row while you type the new one.
 */
function Title({
	name,
	links,
	notes,
	at,
	now,
	renaming,
	onRenamed,
	onCancel,
	id,
}: {
	name: string
	links: number
	notes: number
	at: number
	now: number
	renaming?: boolean
	id?: string
	onRenamed?: () => Promise<unknown>
	onCancel?: () => void
}) {
	const [text, setText] = useState(name)
	const { busy, run } = useAction()

	useEffect(() => {
		if (renaming) setText(name)
	}, [renaming, name])

	if (renaming && id) {
		const save = () =>
			run(async () => {
				const next = text.trim()
				if (next && next !== name) await call('renameWorkspace', id, next)
				onCancel?.()
				await onRenamed?.()
			})
		return (
			<input
				className="wp-input wp-sm wp-grow"
				autoFocus
				value={text}
				disabled={busy}
				aria-label="Ticket name"
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter') void save()
					if (e.key === 'Escape') onCancel?.()
				}}
				onBlur={save}
			/>
		)
	}
	return <Name name={name} links={links} notes={notes} at={at} now={now} />
}

function Name({ name, links, notes, at, now }: { name: string; links: number; notes: number; at: number; now: number }) {
	const key = ticketKey(name)
	const rest = key ? name.replace(key, '').replace(/^[\s·:-]+/, '') || name : name
	return (
		<>
			{key && <span className="wp-chip wp-chip-accent">{key}</span>} <strong>{rest}</strong>
			<span className="wp-muted">
				{' '}
				· {links} link{links === 1 ? '' : 's'}
				{!!notes && ` · ${notes} note${notes === 1 ? '' : 's'}`} · saved {ago(at, now)}
			</span>
		</>
	)
}

function Actions({
	id,
	name,
	links,
	notes,
	reload,
	compact,
	onRename,
	others,
	archived,
}: {
	id: string
	name: string
	links: number
	notes: number
	reload: () => Promise<unknown>
	compact?: boolean
	onRename: () => void
	/** The other tickets, for merging into one of them. */
	others: TicketRow[]
	archived?: boolean
}) {
	const [merging, setMerging] = useState(false)
	const [said, setSaid] = useState('')
	// Asked in the page, where the button was — never in a browser dialog.
	const [deleting, setDeleting] = useState(false)
	const [copying, setCopying] = useState<string | null>(null)
	const [into, setInto] = useState('')
	const { busy, error, run } = useAction()

	const addOpenTabs = () =>
		run(async () => {
			const tabs = (await chrome.tabs.query({ lastFocusedWindow: true }))
				.filter((t) => t.url && /^https?:/.test(t.url))
				.map((t) => ({ title: t.title ?? t.url!, url: t.url! }))
			await call('addToWorkspace', id, tabs)
			await reload()
		})

	const remove = () =>
		run(async () => {
			await call('deleteWorkspace', id)
			if (compact) location.hash = '#/links'
			else await reload()
		})

	// Two things you do all day stay as themselves; the rest have names.
	const menu: MenuItem[] = [
		{ icon: 'pencil', label: 'Rename', title: 'Rename this ticket', onPick: onRename },
		...(others.length ? [{ icon: 'layers' as const, label: 'Merge into…', title: 'Fold this ticket into another one', onPick: () => setMerging(!merging) }] : []),
		{ icon: 'copy', label: 'Copy links to a new ticket', title: 'Start a new ticket from these links — a release checklist, an incident set', onPick: () => setCopying(`${name} (copy)`) },
		{
			icon: archived ? 'bookmark' : 'archive',
			label: archived ? 'Put back in the list' : 'Archive',
			title: archived ? 'Put it back in the list' : 'Done with it — keeps everything, leaves the list',
			onPick: () => run(async () => void (await call('archiveTicket', id, !archived), await reload())),
		},
		{ icon: 'trash', label: 'Delete', title: 'Delete this ticket and its notes', danger: true, onPick: () => setDeleting(true), },
	]

	return (
		<>
			<span className="wp-row">
				{/* Opening is the grouping: the ticket's page, then its links, in one
				    labelled Chrome group. */}
				<button className="wp-btn wp-btn-sm wp-btn-soft" disabled={busy} title={`Open this page and all ${links} links as a tab group`} onClick={() => run(() => call('openWorkspace', id))}>
					<Icon name="group" size={13} /> Open group
				</button>
				<button className="wp-icon-btn" disabled={busy} title="Add every open tab in this window, skipping ones already here" aria-label="Add this window's tabs" onClick={addOpenTabs}>
					<Icon name="plus" size={14} />
				</button>
				<Menu items={menu} disabled={busy} label={`More for ${name}`} />
			</span>

			{deleting && (
				<span className="wp-confirm wp-small" style={{ flexBasis: '100%' }}>
					<span className="wp-muted">
						Delete <strong>{name}</strong> with its {links} link{links === 1 ? '' : 's'} and {notes} note{notes === 1 ? '' : 's'}? Archiving keeps all of it.
					</span>
					<button className="wp-btn wp-btn-sm wp-btn-danger" disabled={busy} onClick={() => (setDeleting(false), remove())}>
						Delete it
					</button>
					<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => run(async () => void (setDeleting(false), await call('archiveTicket', id, true), await reload()))}>
						Archive instead
					</button>
					<button className="wp-action wp-muted" onClick={() => setDeleting(false)}>
						Cancel
					</button>
				</span>
			)}

			{copying != null && (
				<span className="wp-row wp-small" style={{ flexBasis: '100%' }}>
					<span className="wp-muted">Name it</span>
					<input
						className="wp-input wp-sm wp-grow"
						autoFocus
						value={copying}
						onChange={(e) => setCopying(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Escape') setCopying(null)
							if (e.key === 'Enter' && copying.trim()) void run(async () => void (await call('duplicateTicket', id, copying.trim()), setCopying(null), await reload()))
						}}
					/>
					<button className="wp-btn wp-btn-sm wp-btn-primary" disabled={busy || !copying.trim()} onClick={() => run(async () => void (await call('duplicateTicket', id, copying.trim()), setCopying(null), await reload()))}>
						Create
					</button>
					<button className="wp-action wp-muted" onClick={() => setCopying(null)}>
						Cancel
					</button>
				</span>
			)}

			{merging && (
				<div className="wp-row-wrap wp-small" style={{ flexBasis: '100%' }}>
					<span className="wp-muted">Merge this into</span>
					<select
						className="wp-select wp-sm"
						style={{ maxWidth: 240 }}
						defaultValue=""
						disabled={busy}
						value={into}
						onChange={(e) => setInto(e.target.value)}
					>
						<option value="">Pick the one to keep…</option>
						{others.map((o) => (
							<option key={o.id} value={o.id}>
								{o.name}
							</option>
						))}
					</select>
					<button className="wp-action wp-muted" onClick={() => (setMerging(false), setInto(''))}>
						Cancel
					</button>

					{/* Picking is not doing: the consequence is said before it happens,
					    and the name of what disappears is in the sentence. */}
					{!!into && (
						<span className="wp-confirm" style={{ flexBasis: '100%' }}>
							<span className="wp-muted">
								Its {links} link{links === 1 ? '' : 's'} and {notes} note{notes === 1 ? '' : 's'} move into <strong>{others.find((o) => o.id === into)?.name}</strong>, and{' '}
								<strong>{name}</strong> is removed.
							</span>
							<button
								className="wp-btn wp-btn-sm wp-btn-primary"
								disabled={busy}
								onClick={() =>
									run(async () => {
										const r = await call('mergeTickets', id, into)
										setSaid(`Merged into ${r.name} — ${r.links} link${r.links === 1 ? '' : 's'}, ${r.notes} note${r.notes === 1 ? '' : 's'}${r.duplicates ? `, ${r.duplicates} already there` : ''}.`)
										setMerging(false)
										setInto('')
										if (compact) location.hash = `#/links/${into}`
										else await reload()
									})
								}
							>
								Merge them
							</button>
						</span>
					)}
				</div>
			)}
			{said && <div className="wp-ok-text wp-small">{said}</div>}
			{error && <div className="wp-error wp-small">{error}</div>}
		</>
	)
}

function Row({ row, expanded, onToggle, reload, others }: { row: TicketRow; expanded: boolean; onToggle: () => void; reload: () => Promise<unknown>; others: TicketRow[] }) {
	const now = Date.now()
	const [renaming, setRenaming] = useState(false)
	return (
		<section className="wp-card wp-stack-sm">
			<div className="wp-between">
				{renaming ? (
					<Title id={row.id} name={row.name} links={row.links} notes={row.notes} at={row.at} now={now} renaming onRenamed={reload} onCancel={() => setRenaming(false)} />
				) : (
					<button className="wp-action wp-action-text wp-grow" style={{ textAlign: 'left', minWidth: 0 }} onClick={onToggle} aria-expanded={expanded}>
						<span aria-hidden>{expanded ? '▾' : '▸'}</span> <Title name={row.name} links={row.links} notes={row.notes} at={row.at} now={now} />
						{row.archived && <span className="wp-chip" style={{ marginLeft: 6 }}>archived</span>}
					</button>
				)}
				<Actions id={row.id} name={row.name} links={row.links} notes={row.notes} reload={reload} onRename={() => setRenaming(true)} others={others} archived={row.archived} />
			</div>
			<div className="wp-muted wp-small">
				{row.latestNote ? row.latestNote : `changed ${ago(row.updatedAt, now)}`}
				{row.lastOpenedAt != null && <span> · opened {ago(row.lastOpenedAt, now)}</span>}
			</div>

			{/* The links and notes are fetched only for the row you opened. */}
			{expanded && <Detail id={row.id} onChanged={reload} />}
		</section>
	)
}

/** One ticket's links and notes, loaded on demand. */
function Detail({ id, onChanged }: { id: string; onChanged: () => Promise<unknown> }) {
	const { data: space, reload } = useLive(() => call('ticket', id), [id])
	const both = async () => void (await reload(), await onChanged())
	if (!space) return <span className="wp-muted wp-small">Loading…</span>
	return (
		<>
			<div className="wp-stack-sm wp-small wp-scroll">
				<Links space={space} reload={both} />
			</div>
			<TicketNotes space={space} onSaved={both} />
			<a className="wp-link wp-small" href={`#/links/${id}`}>
				Open this ticket's page →
			</a>
		</>
	)
}

/** One ticket, as a page: what opens at the head of its tab group. */
function TicketPage({ id }: { id: string }) {
	const { data: space, reload } = useLive(() => call('ticket', id), [id])
	const { data: all } = useLive(() => call('ticketList', true))
	const [renaming, setRenaming] = useState(false)
	const now = Date.now()

	useEffect(() => {
		// The tab itself should say which ticket — it is the first tab in the group.
		if (!space) return
		document.title = `${space.name} · WorkPulse`
		return () => {
			document.title = 'WorkPulse'
		}
	}, [space?.name])

	if (space === null) return <Gone />
	if (!space) return <div className="wp-muted">Loading…</div>
	return (
		<div className="wp-stack">
			<a className="wp-link wp-small" href="#/links">
				← All tickets
			</a>
			<header className="wp-between">
				<h1 className="wp-h1" style={{ minWidth: 0, flex: '1 1 auto' }}>
					<Title
						id={space.id}
						name={space.name}
						links={space.tabs.length}
						notes={space.notes?.length ?? 0}
						at={space.at}
						now={now}
						renaming={renaming}
						onRenamed={reload}
						onCancel={() => setRenaming(false)}
					/>
				</h1>
				<Actions
					id={space.id}
					name={space.name}
					links={space.tabs.length}
					notes={space.notes?.length ?? 0}
					reload={reload}
					compact
					onRename={() => setRenaming(true)}
					others={(all ?? []).filter((o) => o.id !== space.id)}
					archived={space.archivedAt != null}
				/>
			</header>
			{space.note && <p className="wp-muted wp-small" style={{ maxWidth: 520, margin: 0 }}>{space.note}</p>}

			<Estimate space={space} onSaved={reload} />

			<section className="wp-card wp-stack-sm">
				<span className="wp-eyebrow">Links</span>
				<div className="wp-stack-sm wp-small">
					<Links space={space} reload={reload} />
				</div>
			</section>

			<section className="wp-card">
				<TicketNotes space={space} onSaved={reload} />
			</section>

			<section className="wp-card">
				<TicketLearnings ticketId={space.id} />
			</section>

			<TicketBrain name={space.name} />

			{/* What you found on this ticket's pages, with the screenshots. */}
			<TicketPageNotes ticketId={space.id} />
		</div>
	)
}

/**
 * How long you think it will take. One optional field, asked once.
 *
 * Nothing chases it and nothing scores it. The hours come from what you log
 * against the ticket anyway, so after five or so tickets WorkPulse can say the
 * only useful thing — how much longer your work really takes than you say —
 * which is a number nobody has about themselves and every planning meeting
 * wants.
 */
function Estimate({ space, onSaved }: { space: Workspace; onSaved: () => Promise<unknown> }) {
	const [hours, setHours] = useState('')
	const { busy, run } = useAction()
	const saved = space.estimateMinutes ?? 0
	const save = (minutes: number) => run(async () => void (await call('setEstimate', space.id, minutes), setHours(''), await onSaved()))

	if (saved)
		return (
			<div className="wp-row wp-small">
				<span className="wp-muted">
					You thought <strong>{fmtHours(saved)}</strong>.
				</span>
				<button className="wp-action wp-muted" disabled={busy} onClick={() => save(0)}>
					forget that
				</button>
			</div>
		)

	return (
		<div className="wp-row wp-small">
			<span className="wp-muted">How long do you think?</span>
			<input
				className="wp-input wp-sm wp-num"
				style={{ width: 70 }}
				type="number"
				min={0}
				step={0.5}
				placeholder="hrs"
				value={hours}
				disabled={busy}
				onChange={(e) => setHours(e.target.value)}
				onKeyDown={(e) => e.key === 'Enter' && Number(hours) > 0 && save(Math.round(Number(hours) * 60))}
				aria-label="Hours you think this will take"
			/>
			<button className="wp-btn wp-btn-sm" disabled={busy || !(Number(hours) > 0)} onClick={() => save(Math.round(Number(hours) * 60))}>
				Save
			</button>
			<span className="wp-muted">Optional. It is never shown to anyone and nothing chases you about it.</span>
		</div>
	)
}

const fmtHours = (min: number) => (min % 60 === 0 ? `${min / 60}h` : `${(min / 60).toFixed(1)}h`)

function Links({ space, reload }: { space: Workspace; reload: () => Promise<unknown> }) {
	const { data: all } = useLive(() => call('ticketList'))
	const [moving, setMoving] = useState<string | null>(null)
	const { busy, run } = useAction()
	const now = Date.now()
	const others = (all ?? []).filter((o) => o.id !== space.id)
	const batch = addedTogether(space.tabs)
	return (
		<>
			{/* The batch that went in at once, offered back as one thing — because
			    "add every tab in this window" on the wrong ticket is the accident,
			    and a minute later nothing else tells them apart. */}
			{batch && (
				<div className="wp-between wp-small wp-card-flat">
					<span className="wp-muted">
						<strong>{batch.urls.length} links</strong> went in together, {ago(batch.at, now)}.
					</span>
					<button
						className="wp-action wp-action-danger"
						disabled={busy}
						title="Take out exactly those, and leave the rest"
						onClick={() => run(async () => void (await call('removeLinks', space.id, batch.urls), await reload()))}
					>
						Take those out
					</button>
				</div>
			)}
			{!space.tabs.length && <span className="wp-muted">No links yet — paste one below, or take the whole window with the button above.</span>}
			{space.tabs.map((t) => (
				<div key={t.url} className="wp-between">
					<span className="wp-grow" style={{ minWidth: 0 }}>
						<Field space={space} url={t.url} field="note" value={t.note} onSaved={reload} />{' '}
						<Field space={space} url={t.url} field="title" value={t.title} onSaved={reload} />
						{t.addedAt && <span className="wp-muted"> · added {ago(t.addedAt, now)}</span>}
					</span>
					<span className="wp-row">
						<a className="wp-btn wp-btn-sm wp-btn-ghost" href={t.url} target="_blank" rel="noreferrer" title={t.url}>
							Open
						</a>
						{/* Filed under the wrong ticket: moved, not retyped. */}
						{moving === t.url ? (
							<select
								className="wp-select wp-sm"
								style={{ maxWidth: 190 }}
								autoFocus
								defaultValue=""
								disabled={busy}
								onBlur={() => setMoving(null)}
								onChange={(e) =>
									e.target.value &&
									run(async () => void (await call('moveLink', space.id, e.target.value, t.url), setMoving(null), await reload()))
								}
							>
								<option value="">Move it to…</option>
								{others.map((o) => (
									<option key={o.id} value={o.id}>
										{o.name}
									</option>
								))}
							</select>
						) : (
							<Menu
								label="More for this link"
								disabled={busy}
								items={[
									{ icon: 'copy', label: 'Copy the address', onPick: () => void navigator.clipboard.writeText(t.url) },
									...(others.length ? [{ icon: 'move' as const, label: 'Move to another ticket…', onPick: () => setMoving(t.url) }] : []),
									{
										icon: 'trash',
										label: 'Remove from this ticket',
										danger: true,
										onPick: () => run(async () => void (await call('removeLink', space.id, t.url), await reload())),
									},
								]}
							/>
						)}
					</span>
				</div>
			))}
			<AddLink space={space} reload={reload} />
		</>
	)
}

/** Paste a link the ticket picks up later — the stage URL, the build, a doc. */
function AddLink({ space, reload }: { space: Workspace; reload: () => Promise<unknown> }) {
	const [url, setUrl] = useState('')
	const [name, setName] = useState('')
	const { busy, error, run } = useAction()

	const add = () =>
		run(async () => {
			await call('addToWorkspace', space.id, [{ title: name.trim() || url.trim(), url: url.trim() }])
			setUrl('')
			setName('')
			await reload()
		})

	return (
		<div className="wp-stack-sm">
			<div className="wp-row">
				<input
					className="wp-input wp-grow"
					placeholder="Paste a link — https://stage.acme.com/orders"
					value={url}
					onChange={(e) => setUrl(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && url.trim()) void add()
					}}
				/>
				<input
					className="wp-input"
					style={{ maxWidth: 160 }}
					placeholder="Call it… (optional)"
					value={name}
					onChange={(e) => setName(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && url.trim()) void add()
					}}
				/>
				<button className="wp-btn wp-btn-sm" disabled={busy || !url.trim()} onClick={add}>
					Add
				</button>
			</div>
			{error && <div className="wp-error wp-small">{error}</div>}
		</div>
	)
}

/**
 * A link's label and its name, both edited the same way: click the text, type,
 * Enter. A page title from six weeks ago rarely says what the link was for.
 */
function Field({ space, url, field, value, onSaved }: { space: Workspace; url: string; field: 'title' | 'note'; value?: string; onSaved: () => Promise<unknown> }) {
	const [editing, setEditing] = useState(false)
	const [text, setText] = useState(value ?? '')
	const { busy, run } = useAction()

	const save = () => run(async () => void (await call('editLink', space.id, url, { [field]: text }), setEditing(false), await onSaved()))

	if (editing)
		return (
			<input
				className="wp-input wp-sm"
				style={{ width: field === 'title' ? 280 : 150, display: 'inline-block' }}
				autoFocus
				placeholder={field === 'title' ? 'What to call this link' : (labelFor(url) ?? 'merged on dev')}
				value={text}
				disabled={busy}
				onChange={(e) => setText(e.target.value)}
				onBlur={save}
				onKeyDown={(e) => {
					if (e.key === 'Enter') save()
					if (e.key === 'Escape') setEditing(false)
				}}
			/>
		)

	if (field === 'note')
		return (
			<button className={value ? 'wp-chip' : 'wp-action wp-muted'} onClick={() => setEditing(true)} title="What is this link for?">
				{value || '+ label'}
			</button>
		)
	return (
		<button className="wp-action" style={{ maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }} onClick={() => setEditing(true)} title="Rename this link">
			{value}
		</button>
	)
}

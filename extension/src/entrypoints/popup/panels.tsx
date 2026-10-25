// The widget's other tabs. Each one answers its question in a glance and keeps
// a way out to the full page for the things a 340px column cannot do well —
// editing rows, writing a regularisation reason, the whole month.

import { useEffect, useState } from 'react'

import type { TodayState } from '@/background/commands'
import { duplicates, site, type OpenTab } from '@/core/focus'
import { clipLength, MAX_SECONDS } from '@/core/clip'
import { heartColour, pitch } from '@/core/brand'
import { KIND_LABEL, tagsOf, type LearnKind } from '@/core/learn'
import { matchesRow, suggest } from '@/core/links'
import { fmtMinutes, istTime, prettyDate } from '@/core/time'
import { call } from '@/lib/rpc'
import { useAction, useLive, useNow } from '@/ui/hooks'
import { AUTHOR, AUTHOR_URL, SOURCE_URL, SPONSOR_URL } from '@/entrypoints/dashboard/views/Support'
import { Fold } from '@/ui/Fold'
import { TagPicker } from '@/ui/TagPicker'
import { Icon } from '@/ui/Icon'
import { Undo } from '@/ui/Undo'

function Head({ title, onOpen }: { title: string; onOpen: () => void }) {
	return (
		<div className="wp-between">
			<span className="wp-eyebrow">{title}</span>
			{/* An icon, labelled for anyone who hovers or uses a screen reader:
			    "Full page" was the widest thing in every panel header. */}
			<button className="wp-icon-btn" onClick={onOpen} title={`Open ${title} in the dashboard`} aria-label={`Open ${title} in the dashboard`}>
				<Icon name="dashboard" size={14} />
			</button>
		</div>
	)
}

/** Today's time logs: what is written down, and the one button that sends it. */
export function TimesheetPanel({ onOpen }: { onOpen: () => void }) {
	const { data: r, reload } = useLive(() => call('review'))
	const { busy, error, run } = useAction()
	if (!r) return <div className="wp-muted wp-small">Loading…</div>

	const unsynced = r.entries.filter((e) => e.kind === 'work' && !e.synced)
	const minutes = unsynced.reduce((a, e) => a + e.minutes, 0)

	return (
		<div className="wp-card wp-stack-sm">
			<Head title="Today's timesheet" onOpen={onOpen} />
			<div className="wp-between">
				<span className="wp-big">{fmtMinutes(r.loggedMinutes)}</span>
				<span className="wp-muted wp-small" style={{ textAlign: 'right' }}>
					{unsynced.length ? `${fmtMinutes(minutes)} not sent yet` : 'all sent to Zoho'}
				</span>
			</div>

			{r.rows.length ? (
				<div className="wp-stack-sm wp-small wp-scroll-sm">
					{r.rows.map((row, i) => (
						<div key={i} className="wp-between">
							<span className="wp-grow" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.description}>
								{row.jobName}
							</span>
							<span className="wp-num wp-muted">{fmtMinutes(row.minutes)}</span>
						</div>
					))}
				</div>
			) : (
				<div className="wp-muted wp-small">Nothing logged yet today.</div>
			)}

			<div className="wp-row-wrap">
				{r.canPush && !!r.rows.length ? (
					<button className="wp-btn wp-btn-sm wp-btn-primary" disabled={busy} onClick={onOpen}>
						Send {r.rows.length} row{r.rows.length === 1 ? '' : 's'} →
					</button>
				) : null}
				<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => run(async () => void (await call('logNow'), window.close()))}>
					Log an hour
				</button>
				{!!r.pendingDays.length && <span className="wp-chip wp-chip-warn">{r.pendingDays.length} earlier day{r.pendingDays.length === 1 ? '' : 's'} unlogged</span>}
			</div>
			{error && <div className="wp-error wp-small">{error}</div>}
			<button className="wp-action wp-small" style={{ alignSelf: 'flex-start' }} onClick={() => void reload()}>
				refresh
			</button>
		</div>
	)
}

/** Open work, and a box to add more without leaving the popup. */
export function TasksPanel({ onOpen }: { onOpen: () => void }) {
	const { data, reload } = useLive(() => call('tasks'))
	const [title, setTitle] = useState('')
	const [find, setFind] = useState('')
	const { busy, error, run } = useAction()
	if (!data) return <div className="wp-muted wp-small">Loading…</div>

	const all = data.tasks.filter((t) => t.status !== 'done' && t.kind !== 'note')
	// Twenty open tasks is normal and a list of twenty in a popup is not.
	const open = find.trim() ? all.filter((t) => `${t.key ?? ''} ${t.title}`.toLowerCase().includes(find.trim().toLowerCase())) : all

	return (
		<div className="wp-card wp-stack-sm">
			<Head title={`Tasks (${all.length})`} onOpen={onOpen} />

			<div className="wp-row">
				<input
					className="wp-input wp-grow"
					placeholder="Add a task…"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && title.trim()) void run(async () => void (await call('createTask', { title }), setTitle(''), await reload()))
					}}
				/>
				<button className="wp-btn wp-btn-sm" disabled={busy || !title.trim()} onClick={() => run(async () => void (await call('createTask', { title }), setTitle(''), await reload()))}>
					<Icon name="plus" />
				</button>
			</div>

			{all.length > 6 && (
				<div className="wp-row">
					<input className="wp-input wp-sm wp-grow" placeholder="Find a task…" value={find} onChange={(e) => setFind(e.target.value)} />
					{!!find && (
						<button className="wp-action wp-small" onClick={() => setFind('')}>
							clear
						</button>
					)}
				</div>
			)}

			{open.length ? (
				<div className="wp-stack-sm wp-small wp-scroll-sm">
					{open.map((t) => (
						<div key={t.uid} className="wp-between">
							<span className="wp-grow" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
								{t.key && <span className="wp-muted">{t.key} · </span>}
								{t.title}
								{t.remindAt != null && <span className="wp-muted"> · {istTime(t.remindAt)}</span>}
							</span>
							<span className="wp-row">
								{data.timer?.task.uid === t.uid ? (
									<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => run(async () => void (await call('stopTimer'), await reload()))}>
										<Icon name="stop" />
									</button>
								) : (
									<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => run(async () => void (await call('startTimer', t.uid), await reload()))}>
										<Icon name="play" />
									</button>
								)}
								<button className="wp-btn wp-btn-sm wp-btn-soft" disabled={busy} onClick={() => run(async () => void (await call('answerTask', t.uid, 'done'), await reload()))}>
									<Icon name="check" />
								</button>
							</span>
						</div>
					))}
				</div>
			) : (
				<div className="wp-muted wp-small">{find.trim() ? `No task matches “${find}”.` : 'Nothing open. Add one above, or save a link from the toolbar.'}</div>
			)}
			{error && <div className="wp-error wp-small">{error}</div>}
		</div>
	)
}

/** The days that will cost you, and the one thing to do about each. */
export function IssuesPanel({ s, onOpen }: { s: TodayState; onOpen: () => void }) {
	const { busy, error, run } = useAction()

	return (
		<div className="wp-card wp-stack-sm">
			<Head title={`Regularisation (${s.issues.length})`} onOpen={onOpen} />
			{s.issues.length ? (
				<div className="wp-stack-sm wp-small wp-scroll-sm">
					{s.issues.map((i) => (
						<div key={i.date} className="wp-between">
							<span className="wp-grow" style={{ minWidth: 0 }}>
								<strong>{prettyDate(i.date).slice(4)}</strong>
								<div className="wp-muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
									{i.detail}
								</div>
							</span>
							<button className="wp-btn wp-btn-sm" disabled={busy} onClick={onOpen}>
								Fix
							</button>
						</div>
					))}
				</div>
			) : (
				<div className="wp-muted wp-small">Nothing to fix. WorkPulse checks every morning.</div>
			)}
			<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => run(() => call('scanNow'))}>
				Check again
			</button>
			{error && <div className="wp-error wp-small">{error}</div>}
		</div>
	)
}

/** The three settings worth changing mid-day; the rest is a click away. */
export function SettingsPanel({ s, onOpen }: { s: TodayState; onOpen: () => void }) {
	const { busy, error, run } = useAction()
	const save = (patch: Record<string, unknown>) => run(() => call('saveSettings', patch))

	return (
		<div className="wp-card wp-stack-sm">
			<Head title="Settings" onOpen={onOpen} />
			<div className="wp-between wp-small">
				<span>Prompt every</span>
				<span className="wp-row">
					{[30, 45, 60, 90].map((m) => (
						<button key={m} className={s.settings.promptInterval === m ? 'wp-btn wp-btn-sm wp-btn-soft' : 'wp-btn wp-btn-sm'} disabled={busy} onClick={() => save({ promptInterval: m })}>
							{m}m
						</button>
					))}
				</span>
			</div>
			<label className="wp-between wp-small" style={{ cursor: 'pointer' }}>
				<span>Chime with reminders</span>
				<input type="checkbox" checked={s.settings.sound} disabled={busy} onChange={(e) => save({ sound: e.target.checked })} />
			</label>
			<div className="wp-between wp-small">
				<span className="wp-muted">
					Shift {s.settings.shiftStart}–{s.settings.shiftEnd} · {s.settings.minHours}h a day
				</span>
				<button className="wp-action" onClick={onOpen}>
					change
				</button>
			</div>
			{error && <div className="wp-error wp-small">{error}</div>}
		</div>
	)
}

/**
 * The tabs you have open, and a way to close them without losing them — the
 * reason tabs pile up is not laziness, it is that closing one feels like
 * deleting it.
 */
export function TabsPanel({ onOpen }: { onOpen: () => void }) {
	const [tabs, setTabs] = useState<OpenTab[] | null>(null)
	const [picked, setPicked] = useState<Set<number>>(new Set())
	const [said, setSaid] = useState('')
	const [name, setName] = useState('')
	const [find, setFind] = useState('')
	const [findSpace, setFindSpace] = useState('')
	// One destination, named: a new ticket, one you already have, or just today.
	const [dest, setDest] = useState('new')
	const [closeAfter, setCloseAfter] = useState(true)
	// The light projection: the widget shows six rows and never needs the notes.
	const { data: spaces, reload: reloadSpaces } = useLive(() => call('ticketList'))
	const { busy, error, run } = useAction()

	const load = () =>
		// `lastFocusedWindow`, not `currentWindow`: the popup is its own window, so
		// `currentWindow` can answer with the popup and leave the list as it was.
		void chrome.tabs.query({ lastFocusedWindow: true }).then((list) => {
			const open = list
				.filter((t) => t.id != null && t.url && /^https?:/.test(t.url))
				.map((t) => ({ id: t.id!, title: t.title ?? t.url!, url: t.url!, pinned: !!t.pinned, audible: !!t.audible, active: !!t.active }))
			setTabs(open)
			setPicked((p) => (p.size ? new Set([...p].filter((id) => open.some((t) => t.id === id))) : new Set(duplicates(open).map((t) => t.id))))
		})

	// Tabs close and open while this is on the screen — including the ones this
	// panel just closed. Without listening, the list shows what was there before.
	useEffect(() => {
		load()
		let timer: ReturnType<typeof setTimeout> | undefined
		const again = () => {
			clearTimeout(timer)
			timer = setTimeout(load, 80)
		}
		chrome.tabs.onRemoved.addListener(again)
		chrome.tabs.onCreated.addListener(again)
		chrome.tabs.onUpdated.addListener(again)
		chrome.tabs.onActivated.addListener(again)
		return () => {
			clearTimeout(timer)
			chrome.tabs.onRemoved.removeListener(again)
			chrome.tabs.onCreated.removeListener(again)
			chrome.tabs.onUpdated.removeListener(again)
			chrome.tabs.onActivated.removeListener(again)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])
	if (!tabs) return <div className="wp-muted wp-small">Loading…</div>

	const dupes = duplicates(tabs)
	const here = tabs.find((t) => t.active)
	// A window with thirty tabs is exactly when this panel is needed, and exactly
	// when a flat list stops being usable.
	const hay = (t: OpenTab) => `${t.title} ${t.url}`.toLowerCase()
	const listed = find.trim() ? tabs.filter((t) => hay(t).includes(find.trim().toLowerCase())) : tabs
	// The ticket whose key is in this page's address comes first in the list.
	const hinted = here ? suggest(here.url, here.title, spaces ?? []) : []
	const ordered = [...hinted, ...(spaces ?? []).filter((w) => !hinted.some((h) => h.id === w.id))]
	const shownSpaces = findSpace.trim() ? ordered.filter((w) => matchesRow(w, findSpace)) : ordered
	const fileHere = (id: string) =>
		run(async () => {
			if (!here) return
			await call('addToWorkspace', id, [{ title: here.title, url: here.url }])
			setSaid('Filed this page.')
			await reloadSpaces()
		})
	const chosen = tabs.filter((t) => picked.has(t.id))
	const closable = chosen.filter((t) => !t.pinned && !t.active)

	/**
	 * One flow for every destination: pick the tabs, say where they go, say
	 * whether to close them. The old pair of "keep" buttons never said where
	 * anything went, which is why it needed explaining.
	 */
	const add = () =>
		run(async () => {
			const links = chosen.map((t) => ({ title: t.title, url: t.url }))
			const where =
				dest === 'new'
					? `“${(await call('saveWorkspace', { name, tabs: links })).name}”`
					: dest === 'today'
						? "today's links"
						: `“${(spaces ?? []).find((w) => w.id === dest)?.name ?? 'the ticket'}”`
			if (dest === 'today') await call('saveTabs', links, [])
			else if (dest !== 'new') await call('addToWorkspace', dest, links)
			if (closeAfter && closable.length) await call('closeTabs', closable.map((t) => t.id))
			setSaid(`Added ${links.length} to ${where}${closeAfter && closable.length ? `, closed ${closable.length}` : ''}.`)
			setName('')
			setPicked(new Set())
			await reloadSpaces()
			load()
		})

	const ready = !!chosen.length && (dest !== 'new' || !!name.trim())

	return (
		<div className="wp-card wp-stack-sm">
			<Head title={`Open tabs (${tabs.length})`} onOpen={onOpen} />

			{/* The one line worth having above the fold: what to press. */}
			<div className="wp-between wp-small">
				<span className={dupes.length ? 'wp-warn-text' : 'wp-muted'}>
					{dupes.length ? `${dupes.length} duplicate${dupes.length === 1 ? '' : 's'}` : `${tabs.length} tabs open`}
					{chosen.length ? ` · ${chosen.length} picked` : ''}
				</span>
				<span className="wp-row">
					{!!dupes.length && (
						<button className="wp-action" onClick={() => setPicked(new Set(dupes.map((t) => t.id)))}>
							pick duplicates
						</button>
					)}
					{!!chosen.length && (
						<button className="wp-action wp-muted" onClick={() => setPicked(new Set())}>
							clear
						</button>
					)}
				</span>
			</div>

			<Fold title="Choose tabs" count={tabs.length} open={tabs.length <= 12}>
				<div className="wp-row">
					<input className="wp-input wp-sm wp-grow" placeholder="Filter these tabs…" value={find} onChange={(e) => setFind(e.target.value)} />
					{!!find && (
						<button className="wp-action wp-small" onClick={() => setFind('')}>
							clear
						</button>
					)}
				</div>

				<div className="wp-stack-sm wp-small wp-scroll-sm">
					{!listed.length && <span className="wp-muted">No tab matches “{find}”.</span>}
					{listed.map((t) => (
					<label key={t.id} className="wp-row" style={{ cursor: 'pointer' }}>
						<input
							type="checkbox"
							checked={picked.has(t.id)}
							onChange={(e) =>
								setPicked((p) => {
									const next = new Set(p)
									if (e.target.checked) next.add(t.id)
									else next.delete(t.id)
									return next
								})
							}
						/>
						<span className="wp-grow" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.url}>
							{t.title}
							<span className="wp-muted"> · {site(t.url)}</span>
						</span>
						{t.pinned && <span className="wp-chip">pinned</span>}
						{t.active && <span className="wp-chip">this one</span>}
					</label>
					))}
				</div>
			</Fold>

			<div className="wp-stack-sm" style={{ paddingTop: 8, borderTop: '1px solid var(--wp-border)' }}>
				<div className="wp-row">
					<label className="wp-label wp-small" htmlFor="wp-dest" style={{ flex: 'none' }}>
						Add to
					</label>
					<select id="wp-dest" className="wp-select wp-grow" value={dest} onChange={(e) => setDest(e.target.value)}>
						<option value="new">A new ticket…</option>
						{!!spaces?.length && (
							<optgroup label="Tickets">
								{/* Capped: a destination list is for choosing, not browsing —
								    and the search above finds the rest. */}
								{ordered.slice(0, 30).map((w) => (
									<option key={w.id} value={w.id}>
										{w.name} ({w.links})
									</option>
								))}
							</optgroup>
						)}
						<option value="today">Today's links only</option>
					</select>
				</div>

				{dest === 'new' && (
					<input
						className="wp-input"
						placeholder="Name it after the ticket — PAY-3017 debugging"
						value={name}
						onChange={(e) => setName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' && ready) void add()
						}}
					/>
				)}

				<div className="wp-between">
					<label className="wp-row wp-small" style={{ cursor: 'pointer' }}>
						<input type="checkbox" checked={closeAfter} onChange={(e) => setCloseAfter(e.target.checked)} />
						<span>Close them after adding{closable.length ? ` (${closable.length})` : ''}</span>
					</label>
					<button className="wp-btn wp-btn-sm wp-btn-primary" disabled={busy || !ready} onClick={add}>
						Add {chosen.length || ''}
					</button>
				</div>
			</div>

			<div className="wp-between wp-small">
				<span className={said ? 'wp-ok-text' : 'wp-muted'}>
					{said || (chosen.length ? `${chosen.length} selected` : 'Tick the tabs to keep — duplicates are ticked for you')}
				</span>
				{/* "Add every tab in this window" on the wrong ticket is the accident
				    worth being able to take back. */}
				<Undo onUndone={reloadSpaces} />
			</div>

			{!!spaces?.length && (
				<Fold title="Come back to" count={spaces.length} open={ordered.length <= 4}>
					<div className="wp-stack-sm wp-small">
						{spaces.length > 5 && (
							<input className="wp-input wp-sm" placeholder="Find a ticket…" value={findSpace} onChange={(e) => setFindSpace(e.target.value)} />
						)}
						{/* A ticket's links turn up over days — the PR today, the stage
						    deploy on Thursday. Filing this page under its ticket while you
						    are on it is the only version of this anyone keeps doing. */}
						{!shownSpaces.length && <span className="wp-muted">No ticket matches that.</span>}
						{shownSpaces.slice(0, 6).map((w) => (
						<div key={w.id} className="wp-between">
							<span className="wp-grow" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={w.latestNote ?? w.name}>
								<strong>{w.name}</strong>
								<span className="wp-muted"> · {w.links} tabs</span>
							</span>
							{/* Three icons rather than three words: at 340px the names ate
							    the ticket they belonged to, and every row said them again. */}
							<span className="wp-row">
								<button
									className="wp-icon-btn"
									disabled={busy || !here}
									title={here ? `Add this page to ${w.name}` : 'Nothing to add'}
									aria-label={`Add this page to ${w.name}`}
									onClick={() => fileHere(w.id)}
								>
									<Icon name="plus" size={14} />
								</button>
								<button
									className="wp-icon-btn"
									disabled={busy}
									title={`Open ${w.links} tabs as a group`}
									aria-label={`Open ${w.name} as a tab group`}
									onClick={() => run(async () => void (await call('openWorkspace', w.id), window.close()))}
								>
									<Icon name="group" size={14} />
								</button>
								{/* Renaming, relabelling and deleting live on the ticket's page,
								    where there is room to see what you are changing. */}
								<button
									className="wp-icon-btn"
									disabled={busy}
									title={`Open ${w.name} in the dashboard`}
									aria-label={`Open ${w.name} in the dashboard`}
									onClick={() => run(() => call('openDashboard', `links/${w.id}`))}
								>
									<Icon name="dashboard" size={14} />
								</button>
							</span>
						</div>
					))}
					</div>
				</Fold>
			)}
			{error && <div className="wp-error wp-small">{error}</div>}
		</div>
	)
}

/**
 * A learning or a mistake, from wherever you are. The end-of-day question
 * catches what you remember; this catches it while it is still annoying you,
 * which is when it is worth writing.
 */
export function LearnPanel({ onOpen }: { onOpen: () => void }) {
	const [text, setText] = useState('')
	const [kind, setKind] = useState<LearnKind>('learning')
	const [said, setSaid] = useState('')
	const { data: known } = useLive(() => call('learnTags'))
	const { data: again } = useLive(() => call('learnRepeats'))
	const { data: spaces } = useLive(() => call('ticketList'))
	const [ticketId, setTicketId] = useState('')
	const { busy, error, run } = useAction()

	const save = () =>
		run(async () => {
			await call('saveLearning', { text, kind, ticketId: ticketId || undefined })
			setSaid(`Saved. ${tagsOf(text).map((t) => `#${t}`).join(' ')}`)
			setText('')
		})

	return (
		<div className="wp-card wp-stack-sm">
			<Head title="Learned something?" onOpen={onOpen} />

			{/* What keeps coming back, in front of you while you write. */}
			{!!again?.length && (
				<div className="wp-row-wrap wp-small">
					<span className="wp-muted">Keeps coming back:</span>
					{again.slice(0, 3).map((r) => (
						<span key={r.tag} className="wp-chip wp-chip-warn">
							#{r.tag} ×{r.count}
						</span>
					))}
				</div>
			)}

			<textarea
				className="wp-textarea"
				rows={3}
				placeholder="The index was missing again — check the migration first #mysql"
				value={text}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && text.trim()) void save()
				}}
			/>

			<TagPicker text={text} onChange={setText} known={known ?? []} />

			<div className="wp-row-wrap wp-small">
				{(['learning', 'mistake', 'howto'] as LearnKind[]).map((k) => (
					<button key={k} className={kind === k ? 'wp-btn wp-btn-sm wp-btn-soft' : 'wp-btn wp-btn-sm'} onClick={() => setKind(k)} aria-pressed={kind === k}>
						{KIND_LABEL[k]}
					</button>
				))}
				{!!spaces?.length && (
					<select className="wp-select wp-sm wp-grow" value={ticketId} onChange={(e) => setTicketId(e.target.value)}>
						<option value="">No ticket</option>
						{spaces.map((w) => (
							<option key={w.id} value={w.id}>
								{w.name}
							</option>
						))}
					</select>
				)}
			</div>

			<div className="wp-between">
				<span className={said ? 'wp-ok-text wp-small' : 'wp-muted wp-small'}>{said || 'Private to this machine · ⌘↵ saves'}</span>
				<button className="wp-btn wp-btn-sm wp-btn-primary" disabled={busy || !text.trim()} onClick={save}>
					Save
				</button>
			</div>
			{error && <div className="wp-error wp-small">{error}</div>}
		</div>
	)
}

/**
 * One line at the foot of the widget, different every hour.
 *
 * It is here rather than on a reminder card on purpose: the widget is something
 * you open, and a line you chose to look at can ask for something. A card that
 * interrupts your work has not earned the right to sell you anything, which is
 * also why `core/ask.ts` refuses to show the bigger ask while anything is owed.
 *
 * It is one line and it never animates. There is no ✕: the one it had set
 * "never" globally and for good, so one click took the line off every surface
 * in the app — which is how a footer ends up on some screens and not others.
 * The bigger ask in Settings is still refusable for ever; this line is not an
 * ask, it is a credit.
 */
export function Pitch() {
	const now = useNow(60_000)

	const p = pitch(now, { source: SOURCE_URL, sponsor: SPONSOR_URL, author: AUTHOR_URL, name: AUTHOR })
	return (
		<div className="wp-between wp-small wp-pitch" style={{ paddingTop: 4, borderTop: '1px solid var(--wp-border)' }}>
			<span className="wp-muted" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
				{p.kind === 'sponsor' && <span style={{ color: heartColour(now) }}>♥ </span>}
				{p.text}
			</span>
			<span className="wp-row">
				<a className="wp-link wp-muted" href={SOURCE_URL} target="_blank" rel="noreferrer" title="WorkPulse on GitHub" aria-label="WorkPulse on GitHub">
					<Icon name="github" size={13} />
				</a>
				<a className="wp-link" href={p.href} target="_blank" rel="noreferrer" style={{ color: heartColour(now) }}>
					{p.cta}
				</a>
				<a className="wp-link" href={SPONSOR_URL} target="_blank" rel="noreferrer" title="Sponsor WorkPulse" aria-label="Sponsor WorkPulse" style={{ color: heartColour(now) }}>
					♥
				</a>
			</span>
		</div>
	)
}

/**
 * What the team has said about the page you are on.
 *
 * This is the half of the feature that makes the other half worth doing: a note
 * is only useful if it finds the next person to open that page. So the widget
 * asks about the current tab and shows what is there — with the reply and the
 * close in the same place, because a note nobody can answer is a complaint.
 */
/**
 * A recording, for the things a picture cannot show.
 *
 * "It only happens on the second click", "the spinner never stops", "watch what
 * the total does" — a screenshot shows none of those, and all of them are what
 * a bug report is actually about.
 *
 * Chrome's own picker chooses what to record: a whole screen, one application's
 * window, or one tab. Half of what makes a bug video worth watching happens
 * outside the tab, so the choice has to be yours.
 *
 * Press Record, do the thing, press Stop. No length to choose up front, because
 * nobody knows in advance how long the bug takes to happen.
 */
const MIC_KEY = 'wp-clip-mic'

function Record({ url, onDone }: { url?: string; onDone: () => Promise<unknown> }) {
	const { data: going, reload } = useLive(() => call('clipNow'))
	const now = useNow(1000)
	const { busy, error, run } = useAction()
	// Remembered, because whether you narrate is a habit, not a per-recording
	// decision. localStorage rather than settings: the widget is a new document
	// every time it opens, and this never needs to leave it.
	const [mic, setMic] = useState(() => localStorage.getItem(MIC_KEY) !== 'off')
	if (!url || !/^https?:/.test(url)) return null

	if (going) {
		const ran = Math.max(0, Math.round((now - going.startedAt) / 1000))
		return (
			<span className="wp-row wp-small">
				<span className="wp-chip wp-chip-danger">
					<span className="wp-dot" /> {clipLength(ran * 1000)}
				</span>
				<button className="wp-action wp-muted" disabled={busy} onClick={() => run(async () => void (await call('stopClip'), await reload(), await onDone()))}>
					stop
				</button>
			</span>
		)
	}

	return (
		<>
			<button
				className="wp-action wp-muted"
				disabled={busy}
				title="Record a screen, a window or a tab until you press stop"
				onClick={() =>
					run(async () => {
						// Asked for here, and only here. Chrome grants an optional
						// permission during a user gesture on an extension page —
						// the click that got us here. The service worker has no
						// gesture to offer, so asking from there always failed.
						const allowed = await chrome.permissions.request({ permissions: ['desktopCapture'] }).catch(() => false)
						if (!allowed) throw new Error('Chrome needs permission to record the screen, and it was not given.')
						// The microphone is granted to the extension, not to this
						// window: asking once here is what lets the recorder — which
						// has no window and so can show no prompt — use it later.
						// Refusing is allowed; the recording simply has no narration.
						if (mic)
							await navigator.mediaDevices
								.getUserMedia({ audio: true })
								.then((s) => s.getTracks().forEach((t) => t.stop()))
								.catch(() => undefined)
						const r = await call('startClip', MAX_SECONDS, mic)
						// An empty reason is a cancelled picker, which is a decision
						// rather than a failure and needs nothing said about it.
						if (!r.ok) {
							if (r.why) throw new Error(r.why)
							return
						}
						await reload()
						// The popup closing is what lets you use the thing you are
						// recording; the recording carries on without it.
						window.close()
					})
				}
			>
				<Icon name="play" size={12} /> Record
			</button>
			<button
				className="wp-action wp-muted"
				title={mic ? 'Narration on — your voice is recorded too' : 'Narration off — screen and page sound only'}
				onClick={() => {
					const next = !mic
					setMic(next)
					localStorage.setItem(MIC_KEY, next ? 'on' : 'off')
				}}
			>
				<Icon name={mic ? 'mic' : 'mic-off'} size={12} />
			</button>
			{error && <span className="wp-error wp-small">{error}</span>}
		</>
	)
}

/**
 * "This page is PAY-3110, and you have not saved it."
 *
 * Offered where the page is already being looked at, rather than behind a
 * right-click — and read from the tab's own title and address, so the page
 * itself is never touched: nothing injected, nothing scanned, no listener left
 * behind to leak. The right-click menu stays, because it scans the text
 * properly for the pages whose title says nothing.
 *
 * The three recent tickets are there so the destination is confirmed rather
 * than assumed. Saving somewhere you did not mean is the accident this whole
 * corner of the app keeps trying to prevent.
 */
function TicketOffer({ onSaved }: { onSaved: () => Promise<unknown> }) {
	const { data, reload } = useLive(() => call('pageTicketOffer'))
	const { busy, error, run } = useAction()
	const [said, setSaid] = useState('')
	if (!data) return null

	const after = async (msg: string) => {
		setSaid(msg)
		await Promise.all([reload(), onSaved()])
	}

	return (
		<div className="wp-card-flat wp-stack-sm wp-small">
			{said ? (
				<span className="wp-ok-text">{said}</span>
			) : (
				<>
					<span>
						This page is <b>{data.key}</b>
						{data.saved ? <span className="wp-muted"> — already a ticket, but this page is not under it.</span> : <span className="wp-muted"> — not saved yet.</span>}
					</span>
					<div className="wp-row-wrap">
						{data.saved ? (
							<button
								className="wp-btn wp-btn-sm wp-btn-primary"
								disabled={busy}
								onClick={() => run(async () => void (await call('addToWorkspace', data.saved!.id, [data.page]), await after(`Added to ${data.saved!.name}`)))}
							>
								Add to {data.key}
							</button>
						) : (
							<button
								className="wp-btn wp-btn-sm wp-btn-primary"
								disabled={busy}
								onClick={() => run(async () => void (await call('ticketFromKey', data.key, data.page), await after(`Started ${data.key}`)))}
							>
								Start {data.key}
							</button>
						)}
						{/* Somewhere else, if the key is not where it belongs. */}
						{data.recent.map((t) => (
							<button
								key={t.id}
								className="wp-action wp-muted"
								disabled={busy}
								title={`Add this page to ${t.name} — ${t.links} link${t.links === 1 ? '' : 's'}`}
								onClick={() => run(async () => void (await call('addToWorkspace', t.id, [data.page]), await after(`Added to ${t.name}`)))}
							>
								{t.name.length > 22 ? `${t.name.slice(0, 21)}…` : t.name}
							</button>
						))}
					</div>
				</>
			)}
			{error && <span className="wp-error">{error}</span>}
		</div>
	)
}

export function PageNotesPanel() {
	const { data: tab } = useLive(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0] ?? null)
	const url = tab?.url ?? ''
	const { data, reload } = useLive(() => (url ? call('notesOnPage', url) : Promise.resolve({ open: 0, closed: 0, notes: [], tickets: {} })), [url])
	const [replyTo, setReplyTo] = useState<number | null>(null)
	const [adding, setAdding] = useState(false)
	const [shot, setShot] = useState(true)
	const [text, setText] = useState('')
	const { busy, error, run } = useAction()

	// Writing one is offered wherever reading them is: the moment you notice
	// something is the moment the widget happens to be open.
	const add = () =>
		run(async () => {
			if (!tab?.url) return
			// Taken for you: the page is behind the popup, which is exactly the
			// moment the evidence is on screen.
			const pic = shot === false ? null : await call('capturePage', tab.url, true).catch(() => null)
			await call('noteOnPage', { url: tab.url, title: tab.title, text, shot: pic ?? undefined })
			setText('')
			setAdding(false)
			setShot(true)
			await reload()
		})

	if (!data?.notes.length && !adding)
		return url && /^https?:/.test(url) ? (
			<div className="wp-row wp-small">
				<button className="wp-action wp-muted" onClick={() => setAdding(true)}>
					<Icon name="pencil" size={12} /> Note this page
				</button>
				<Record url={url} onDone={reload} />
			</div>
		) : null

	return (
		<div className="wp-card wp-stack-sm">
			<div className="wp-between">
				<span className="wp-eyebrow wp-row">
					<Icon name="bulb" size={13} /> On this page
				</span>
				<span className="wp-row wp-small">
					<Record url={url} onDone={reload} />
					<span className="wp-muted">{data?.open ?? 0} open</span>
					<button className="wp-action wp-muted" onClick={() => setAdding(!adding)} title="Write one about this page">
						<Icon name="plus" size={12} />
					</button>
				</span>
			</div>

			{/* Read from the tab's title and address — the page itself is never
			    touched, so there is nothing to leak and nothing to slow down. */}
			<TicketOffer onSaved={reload} />

			{adding && (
				<div className="wp-row">
					<input
						className="wp-input wp-sm wp-grow"
						autoFocus
						placeholder="What is worth remembering about this page…"
						value={text}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Escape') setAdding(false)
							if (e.key === 'Enter' && text.trim()) void add()
						}}
					/>
					<button className="wp-btn wp-btn-sm wp-btn-primary" disabled={busy || !text.trim()} onClick={add}>
						Keep
					</button>
				</div>
			)}
			{adding && (
				<label className="wp-row wp-small wp-muted" style={{ cursor: 'pointer' }}>
					<input type="checkbox" checked={shot} onChange={(e) => setShot(e.target.checked)} />
					<span>with a picture of this page</span>
				</label>
			)}
			{(data?.notes ?? []).slice(0, 4).map((n) => (
				<div key={n.localId ?? n.number} className="wp-card-flat wp-stack-sm wp-small">
					<div>
						<strong>{n.author}</strong> <span className="wp-muted">· {n.state === 'closed' ? 'dealt with' : n.number ? `shared · #${n.number}` : 'yours'}</span>
						<div>{n.text.slice(0, 220)}</div>
					</div>
					{!!n.replies?.length && <div className="wp-muted">{n.replies.length} repl{n.replies.length === 1 ? 'y' : 'ies'} · latest: {n.replies.at(-1)!.text.slice(0, 80)}</div>}
					{n.source === 'me' ? (
						<div className="wp-row">
							<button className="wp-action wp-muted" disabled={busy} onClick={() => run(async () => void (await call('noteDone', n.localId!, n.state !== 'closed'), await reload()))}>
								{n.state === 'closed' ? 'Put it back' : 'Dealt with'}
							</button>
							{!n.number && (
								<button className="wp-action wp-muted" disabled={busy} onClick={() => run(async () => void (await call('shareNote', n.localId!), await reload()))}>
									Share with the team
								</button>
							)}
						</div>
					) : replyTo === n.number ? (
						<div className="wp-row">
							<input className="wp-input wp-grow" autoFocus placeholder="Reply…" value={text} onChange={(e) => setText(e.target.value)} />
							<button
								className="wp-btn wp-btn-sm wp-btn-primary"
								disabled={busy || !text.trim()}
								onClick={() =>
									run(async () => {
										await call('replyToNote', n.number!, text)
										setText('')
										setReplyTo(null)
										await reload()
									})
								}
							>
								Send
							</button>
						</div>
					) : (
						<div className="wp-row">
							<button className="wp-action" onClick={() => setReplyTo(n.number ?? null)}>
								Reply
							</button>
							<button
								className="wp-action wp-muted"
								disabled={busy}
								onClick={() => run(async () => void (await call('closeNote', n.number!, url, n.state === 'closed' ? 'open' : 'closed'), await reload()))}
							>
								{n.state === 'closed' ? 'Reopen' : 'Mark sorted'}
							</button>
						</div>
					)}
				</div>
			))}
			{error && <div className="wp-error wp-small">{error}</div>}
		</div>
	)
}

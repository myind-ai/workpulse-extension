// Toolbar popup. One question at a time: what should I do right now?
//
// The day's state becomes a single primary action (core/focus.ts), one line of
// numbers, and one thing to answer. Everything else — the other buttons, the
// forced reminders, the links — lives behind "More", so the common case is a
// glance and one click.

import { useEffect, useState } from 'react'

import { BREAKERS } from '@/core/cost'
import { focus } from '@/core/focus'
import { isWorkDay } from '@/core/rules'
import { fmtMinutes, istTime, prettyDate } from '@/core/time'
import { call } from '@/lib/rpc'
import { Brand } from '@/ui/Brand'
import { Capture } from '@/ui/Capture'
import { Icon, type IconName } from '@/ui/Icon'

import { DayBar, DayStrip } from '@/ui/DayBar'
import { Palette } from '@/ui/Palette'
import { isPaletteKey } from '@/ui/palette-open'

import { IssuesPanel, LearnPanel, PageNotesPanel, Pitch, SettingsPanel, TabsPanel, TasksPanel, TimesheetPanel } from './panels'
import { useAction, useLive, useNow } from '@/ui/hooks'
import { Art } from '@/ui/Art'

const MODE_LABEL = { reminder: 'Reminder', timelogs: 'Time logs', full: 'Full' } as const

const FOCUS_ICON: Record<string, IconName> = { confirm: 'check', checkin: 'clock', log: 'pencil', wrapup: 'list', checkout: 'clock', resting: 'check', off: 'check' }

/**
 * Four buttons, not seven.
 *
 * Every panel behind them is worth having, but a row of seven unlabelled icons
 * is a row of seven guesses — and the two people press all day were no easier
 * to find than the one they press twice a year. Today is the day; Work is the
 * things you put down and pick up; Timesheet is what it all turns into.
 */
const NAV: { tab: Tab; icon: IconName; label: string }[] = [
	{ tab: 'home', icon: 'grid', label: 'Today — the day so far' },
	{ tab: 'work', icon: 'bookmark', label: 'Work — open tabs, tickets, tasks and learnings' },
	{ tab: 'review', icon: 'list', label: "Timesheet — today's entries and anything owing" },
	{ tab: 'settings', icon: 'cog', label: 'Settings' },
]

type Tab = 'home' | 'work' | 'review' | 'settings'

/** The panels inside Work, which is the only tab with more than one. */
type WorkPane = 'tabs' | 'tasks' | 'learn'
const WORK: { pane: WorkPane; label: string }[] = [
	{ pane: 'tabs', label: 'Open tabs' },
	{ pane: 'tasks', label: 'Tasks' },
	{ pane: 'learn', label: 'Learned' },
]

/** Which dashboard page each widget section belongs to. */
const VIEW_FOR: Record<Tab, string> = { home: 'today', work: 'links', review: 'review', settings: 'settings' }

/** The primary button runs the command its state calls for. */
const ACTION: Record<string, { method: string; args?: unknown[] } | null> = {
	confirm: null, // filled in below: needs the direction
	checkin: { method: 'checkIn' },
	log: { method: 'logNow' },
	wrapup: { method: 'openDashboard', args: ['review'] },
	checkout: { method: 'checkOut' },
	resting: null,
	off: null,
}

/**
 * The run of days, and the one that is about to stop being fixable.
 *
 * In the widget this is two lines: the reward on the left, and on the right the
 * only deadline in the app that is not of its own invention — Zoho locks a day
 * after a week.
 */
function Run() {
	const { data: p } = useLive(() => call('pulse'))
	if (!p) return null
	return (
		<>
			<div className="wp-between wp-small">
				<span className="wp-row">
					<DayStrip days={p.strip} today={p.today} />
				</span>
				<span className={p.streak.days ? 'wp-ok-text' : 'wp-muted'}>{p.streak.days ? `${p.streak.days} day${p.streak.days === 1 ? '' : 's'} clean` : 'no run yet'}</span>
			</div>
			{!!p.owed.length && (
				<a className="wp-link wp-warn-text wp-small" href="#" onClick={() => void call('openDashboard', `review/${p.owed[0].date}`).then(() => window.close())}>
					{p.owed[0].date} is {Math.round(p.owed[0].minutes / 60)}h short — {p.owed[0].locks}
				</a>
			)}
		</>
	)
}

/**
 * Deep work, in the widget.
 *
 * Starting one asks a single question — what is this block for — because a
 * block you named is one you notice yourself leaving. It is skippable: a
 * required field at the moment someone finally has momentum is the worst place
 * for one.
 */
function Deep({ now, suggest, taskUid }: { now: number; suggest?: string; taskUid?: string }) {
	const { data: f, reload } = useLive(() => call('focusNow'))
	const [intent, setIntent] = useState('')
	const [open, setOpen] = useState(false)
	const { busy, run } = useAction()

	const start = (minutes: number) =>
		run(async () => {
			await call('startFocus', minutes, taskUid, intent.trim() || suggest)
			setIntent('')
			setOpen(false)
			await reload()
		})

	if (f) {
		const left = Math.max(0, Math.round((f.session.endsAt - now) / 60_000))
		return (
			<div className="wp-card wp-stack-sm">
				<div className="wp-between">
					<span className="wp-eyebrow wp-row">
						<Icon name="play" /> Focusing
					</span>
					<span className="wp-num wp-big" style={{ fontSize: 20 }}>
						{left}m
					</span>
				</div>
				<div className="wp-focus-art">
					<Art name="focus" size={64} />
				</div>
				{(f.session.intent || f.task) && <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.session.intent ?? f.task}</div>}
				<div className="wp-bar">
					<span className="wp-bar-fill wp-bar-gap" style={{ width: `${Math.round(f.progress * 100)}%` }} />
				</div>
				<div className="wp-between wp-small">
					<span className="wp-muted">Nothing will interrupt{f.session.extended ? ` · +${f.session.extended * 10}m` : ''}</span>
					<span className="wp-row">
						<button className="wp-action" disabled={busy} onClick={() => run(async () => void (await call('extendFocus', 10), await reload()))}>
							+10 min
						</button>
						<button className="wp-action wp-muted" disabled={busy} onClick={() => run(async () => void (await call('endFocus', true), window.close()))}>
							End
						</button>
					</span>
				</div>
				{/* Said once, because it is the thing people do not believe until
				    they have seen it hold. */}
				{!!f.session.strayed?.length && <span className="wp-muted wp-small">{f.session.strayed.length} detour{f.session.strayed.length === 1 ? '' : 's'} so far.</span>}

				{/* One tap, naming what pulled you out. It does not end the block
				    and it does not scold — all that happens is the thing gets a
				    name, which is the only way anybody ever defends a desk. */}
				<div className="wp-row-wrap wp-small" style={{ marginTop: 2 }}>
					<span className="wp-faint">Broke it?</span>
					{BREAKERS.map((b) => (
						<button key={b} className="wp-action wp-muted" disabled={busy} onClick={() => run(async () => void (await call('noteInterruption', b), await reload()))}>
							{b}
						</button>
					))}
					{!!f.session.broke?.length && <span className="wp-faint">· {f.session.broke.length} noted</span>}
				</div>
			</div>
		)
	}

	if (!open)
		return (
			<div className="wp-row-wrap wp-small">
				<span className="wp-muted wp-row">
					<Icon name="play" /> Focus:
				</span>
				{[25, 50, 90].map((m) => (
					<button key={m} className="wp-action" disabled={busy} onClick={() => (suggest ? void start(m) : (setOpen(true), setIntent('')))}>
						{m} min
					</button>
				))}
				<span className="wp-muted">{suggest ? `on ${suggest.slice(0, 26)}` : 'quiet, then one question'}</span>
			</div>
		)

	return (
		<div className="wp-card wp-stack-sm">
			<span className="wp-eyebrow">What is this block for?</span>
			<input
				className="wp-input wp-sm"
				autoFocus
				placeholder="the retry bug · the migration · PAY-2433"
				value={intent}
				onChange={(e) => setIntent(e.target.value)}
				onKeyDown={(e) => e.key === 'Enter' && void start(50)}
			/>
			{/* Never an empty box: deep work is only deep if it goes on the thing
			    that matters, and the thing that matters is already written down. */}
			<Ideas onPick={setIntent} />
			<div className="wp-row wp-small">
				{[25, 50, 90].map((m) => (
					<button key={m} className="wp-btn wp-btn-sm" disabled={busy} onClick={() => start(m)}>
						{m} min
					</button>
				))}
				<button className="wp-action wp-muted" onClick={() => setOpen(false)}>
					Cancel
				</button>
			</div>
		</div>
	)
}

/** Today's goal, last night's plan, what is marked high — one tap each. */
function Ideas({ onPick }: { onPick: (text: string) => void }) {
	const { data } = useLive(() => call('blockIdeas'))
	if (!data?.length) return null
	return (
		<div className="wp-row-wrap wp-small">
			{data.map((i) => (
				<button key={i.text} className="wp-chip wp-chip-accent" style={{ cursor: 'pointer', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }} title={i.why} onClick={() => onPick(i.text)}>
					{i.text}
				</button>
			))}
		</div>
	)
}

export function Popup() {
	const { data: s, error: loadError } = useLive(() => call('state'))
	const { data: taskData, reload: reloadTasks } = useLive(() => call('tasks'))
	const { busy, error, run } = useAction()
	const [more, setMore] = useState(false)
	const [saving, setSaving] = useState(false)
	const [tab, setTab] = useState<Tab>('home')
	const [pane, setPane] = useState<WorkPane>('tabs')
	const [palette, setPalette] = useState(false)
	const [here, setHere] = useState<{ title: string; url: string } | undefined>()

	// The same box, in the widget itself. It used to be a button that opened the
	// box in whatever tab was behind the popup — which fell back to opening the
	// dashboard whenever that tab would not take an injection, and so did
	// exactly what the icon next to it already did.
	useEffect(() => {
		void chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => t?.url && setHere({ title: t.title ?? t.url, url: t.url }))
		const onKey = (e: KeyboardEvent) => {
			if (!isPaletteKey(e)) return
			e.preventDefault()
			setPalette((p) => !p)
		}
		document.addEventListener('keydown', onKey, true)
		return () => document.removeEventListener('keydown', onKey, true)
	}, [])
	const now = useNow(15_000)

	const go = (view: string) => run(async () => {
		await call('openDashboard', view)
		window.close()
	})
	/** The dashboard, on whatever section the widget is showing. */
	const open = () => go(VIEW_FOR[tab])
	const act = (method: string, ...args: unknown[]) => run(async () => {
		await call(method as 'tickNow', ...(args as []))
		window.close()
	})

	if (!s) return <div className="wp-root wp-pop" style={{ padding: 16 }}>{loadError ?? 'Loading…'}</div>

	const f = focus({
		now,
		day: s.day,
		settings: s.settings,
		loggedMinutes: s.loggedMinutes,
		awaiting: s.awaiting,
		isWorkDay: isWorkDay(s.today, s.settings.workDays),
	})
	const primary = f.kind === 'confirm' ? { method: 'confirmAttendance', args: [s.awaiting] } : ACTION[f.kind]
	const timer = s.timer
	const ask = (taskData?.ask ?? []).filter(() => !timer)[0]
	const alerts = s.issues.length + s.pendingDays.length

	return (
		<div className="wp-root wp-pop" style={{ padding: 14, width: 340 }}>
			{palette && <Palette onClose={() => setPalette(false)} page={here} />}
			<div className="wp-stack-sm">
				<div className="wp-between">
					<Brand />
					<span className="wp-muted wp-small">{prettyDate(s.today).slice(4)}</span>
				</div>

				{/* The widget's own tabs: a glance at the timesheet, tasks or what
				    needs regularising should not cost a page load. Each panel keeps a
				    way out to the full page for the work a 340px column cannot do. */}
				<div className="wp-row" style={{ gap: 4 }}>
					{NAV.map((n) => (
						<button
							key={n.tab}
							className={tab === n.tab ? 'wp-btn wp-btn-sm wp-grow wp-btn-soft' : 'wp-btn wp-btn-sm wp-grow'}
							style={{ justifyContent: 'center', position: 'relative' }}
							title={n.label}
							aria-label={n.label}
							aria-pressed={tab === n.tab}
							onClick={() => {
								setTab(n.tab)
								setSaving(false)
							}}
						>
							<Icon name={n.icon} />
							{n.tab === 'review' && !!(s.issues.length + s.pendingDays.length) && <span className="wp-badge">{s.issues.length + s.pendingDays.length}</span>}
						</button>
					))}
					<button className="wp-btn wp-btn-sm wp-grow" style={{ justifyContent: 'center' }} onClick={() => setSaving(!saving)} title="Keep a link, a note or a to-do" aria-label="Save something">
						<Icon name={saving ? 'check' : 'bookmark'} />
					</button>
					{/* The dashboard, always one click away and always on the section
					    you are already looking at. */}
					<button
						className="wp-btn wp-btn-sm wp-grow"
						style={{ justifyContent: 'center' }}
						onClick={open}
						title="Open the dashboard on this section"
						aria-label="Open the dashboard on this section"
					>
						<Icon name="dashboard" />
					</button>

				</div>

				{saving && (
					<div className="wp-card">
						<Capture onSaved={() => void reloadTasks()} />
					</div>
				)}

				{tab !== 'home' && (
					<>
						{/* Work holds three things you reach for; one strip chooses
						    between them, rather than three icons in the row above. */}
						{tab === 'work' && (
							<>
								<div className="wp-seg" style={{ width: '100%' }}>
									{WORK.map((w) => (
										<button key={w.pane} className="wp-grow" aria-pressed={pane === w.pane} onClick={() => setPane(w.pane)}>
											{w.label}
										</button>
									))}
								</div>
								{pane === 'tabs' && <TabsPanel onOpen={open} />}
								{pane === 'tasks' && <TasksPanel onOpen={open} />}
								{pane === 'learn' && <LearnPanel onOpen={open} />}
							</>
						)}
						{tab === 'review' && (
							<>
								<TimesheetPanel onOpen={open} />
								{/* Days that will cost you belong beside the timesheet, not
								    behind an icon of their own. */}
								{!!(s.issues.length + s.pendingDays.length) && <IssuesPanel s={s} onOpen={() => void call('openDashboard', 'issues').then(() => window.close())} />}
							</>
						)}
						{tab === 'settings' && <SettingsPanel s={s} onOpen={open} />}
					</>
				)}

				{tab === 'home' && (
				<>
				{/* What the team said about the page you are on. Nothing at all when
				    there is no team, or nothing has been said. */}
				<PageNotesPanel />
				{/* The promise the name makes: a block of quiet, then one question. */}
				<Deep now={now} suggest={ask?.title ?? timer?.task.title} taskUid={ask?.uid ?? timer?.task.uid} />

				{/* The day, in one glance. */}
				<div className="wp-card wp-stack-sm">
					<div className="wp-between">
						<span className="wp-big">{fmtMinutes(f.elapsed)}</span>
						<span className="wp-muted wp-small" style={{ textAlign: 'right' }}>
							{s.day.checkedInAt != null ? `in at ${istTime(s.day.checkedInAt)}` : 'not checked in'}
							{s.day.checkedOutAt != null && <div>out at {istTime(s.day.checkedOutAt)}</div>}
						</span>
					</div>

					{/* The same bar as the dashboard and the card: logging an hour
					    moves something you recognise wherever you are looking. */}
					<DayBar logged={s.loggedMinutes} target={s.settings.minHours * 60} elapsed={f.elapsed} />
					<Run />

					{primary ? (
						<button className="wp-btn wp-btn-primary wp-btn-block wp-row" style={{ justifyContent: 'center' }} disabled={busy} onClick={() => act(primary.method, ...(primary.args ?? []))}>
							<Icon name={FOCUS_ICON[f.kind] ?? 'check'} />
							{f.label}
						</button>
					) : (
						<div className="wp-muted wp-small" style={{ textAlign: 'center' }}>{f.label}</div>
					)}

					{/* Ending the day should never be behind a "More" link: it was, and
					    the one thing you look for at 6pm was the one thing hidden. */}
					{s.day.checkedInAt != null && s.day.checkedOutAt == null && f.kind !== 'checkout' && (
						<button className="wp-btn wp-btn-sm wp-btn-block wp-row" style={{ justifyContent: 'center' }} disabled={busy} onClick={() => act('checkOut')}>
							<Icon name="clock" size={13} /> Check out
						</button>
					)}
				</div>

				{/* One thing to answer, never a list that wraps a word per line. */}
				{timer ? (
					<div className="wp-card wp-stack-sm">
						<div className="wp-eyebrow">Working on</div>
						<div className="wp-between">
							<span className="wp-grow" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
								{timer.task.title}
							</span>
							<span className="wp-num wp-muted wp-small">{fmtMinutes(Math.round((now - timer.startedAt) / 60_000))}</span>
						</div>
						<button className="wp-btn wp-btn-sm wp-row" disabled={busy} onClick={() => run(() => call('stopTimer'))}>
							<Icon name="stop" /> Stop the timer
						</button>
					</div>
				) : ask ? (
					<div className="wp-card wp-stack-sm">
						<div className="wp-eyebrow">Still on your list</div>
						<div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
							{ask.key && <span className="wp-muted">{ask.key} · </span>}
							{ask.title}
						</div>
						<div className="wp-row-wrap">
							<button className="wp-btn wp-btn-sm wp-btn-soft" disabled={busy} onClick={() => run(async () => void (await call('answerTask', ask.uid, 'done'), await reloadTasks()))}>
								Done
							</button>
							<button className="wp-btn wp-btn-sm wp-row" disabled={busy} onClick={() => run(async () => void (await call('startTimer', ask.uid), await reloadTasks()))}>
								<Icon name="play" /> Start timing
							</button>
							<button className="wp-btn wp-btn-sm wp-btn-ghost" disabled={busy} onClick={() => run(async () => void (await call('answerTask', ask.uid, 'later'), await reloadTasks()))}>
								Later
							</button>
						</div>
					</div>
				) : null}

				{alerts > 0 && (
					<button className="wp-card-flat wp-between" style={{ border: 0, cursor: 'pointer', font: 'inherit', color: 'inherit' }} onClick={() => go(s.issues.length ? 'issues' : 'review')}>
						<span className="wp-chip wp-chip-warn">{alerts} need{alerts === 1 ? 's' : ''} attention</span>
						<span className="wp-muted wp-small">{s.issues.length ? `${s.issues.length} to regularise` : ''}{s.issues.length && s.pendingDays.length ? ' · ' : ''}{s.pendingDays.length ? `${s.pendingDays.length} day${s.pendingDays.length === 1 ? '' : 's'} unlogged` : ''}</span>
					</button>
				)}

				<button className="wp-action wp-small" style={{ alignSelf: 'flex-start' }} onClick={() => setMore(!more)} aria-expanded={more}>
					{more ? 'Less' : 'More'}
				</button>

				{more && (
					<div className="wp-card wp-stack-sm wp-small">
						<div className="wp-row-wrap">
							{/* Already on the card above; what belongs here is the version
							    for a punch made somewhere else. */}
							{s.day.checkedInAt != null && s.day.checkedOutAt == null && (
								<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => act('confirmAttendance', 'out')}>
									I've already checked out
								</button>
							)}
							{s.day.checkedInAt == null && (
								<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => act('markOff')}>
									Not working today
								</button>
							)}
							<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => act('logNow')}>
								Log an hour
							</button>
							<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => go('review')}>
								Timesheet
							</button>
						</div>

						<div className="wp-row-wrap">
							<span className="wp-muted wp-row">
							<Icon name="bell" /> Force:
						</span>
							{s.day.checkedInAt == null && (
								<button className="wp-action" disabled={busy} onClick={() => act('forceReminder', 'checkin')}>
									check-in
								</button>
							)}
							<button className="wp-action" disabled={busy} onClick={() => act('forceReminder', 'prompt')}>
								log this hour
							</button>
							{s.day.timelogStatus === 'pending' && (
								<button className="wp-action" disabled={busy} onClick={() => act('forceReminder', 'wrapup')}>
									timesheet
								</button>
							)}
						</div>

						<div className="wp-row-wrap">
							<button className="wp-action wp-row" disabled={busy} onClick={() => run(() => call('openZoho'))}>
								<Icon name="external" /> Open Zoho
							</button>
							{s.roleBlocked && (
								<button className="wp-action" disabled={busy} title="Read your Zoho tab and make today agree with it" onClick={() => run(() => call('matchZoho'))}>
									Match Zoho
								</button>
							)}
						</div>

						<div className="wp-between wp-muted">
							<span>{MODE_LABEL[s.settings.zohoMode]} mode</span>
							<button className="wp-action" onClick={() => go('settings')}>
								Settings
							</button>
						</div>
					</div>
				)}

				</>
				)}

				{(error || s.lastError) && <div className="wp-error wp-small">{error ?? s.lastError}</div>}

				{/* The last line, at the foot of the popup whatever is above it. */}
				<Pitch />
			</div>
		</div>
	)
}

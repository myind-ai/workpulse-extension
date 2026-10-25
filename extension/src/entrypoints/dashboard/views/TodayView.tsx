import { focus } from '@/core/focus'
import { kindLabel } from '@/core/leave'
import { DayBar, DayStrip } from '@/ui/DayBar'
import { NotMoving } from './NotMoving'
import { isWorkDay } from '@/core/rules'
import { fmtMinutes, istDate, istTime, prettyDate } from '@/core/time'
import { call } from '@/lib/rpc'
import { Desk } from '@/ui/Desk'
import { Recover } from '@/ui/Recover'

import { Briefing } from './Briefing'
import { Ready } from './Ready'
import { DayShape, Goals } from './Goals'
import { Standup } from './Standup'
import { Support } from './Support'
import { DayActions } from '@/ui/DayActions'
import { useAction, useLive, useNow } from '@/ui/hooks'
import { Art } from '@/ui/Art'

const KIND_CHIP = { work: '', break: 'Break', skipped: 'Skipped' } as const

/**
 * The day so far, and what it is part of.
 *
 * This is the reward half of the habit: a bar that fills, a run of days behind
 * it, and — only when there is one — the day that is about to stop being
 * fixable. The pressure here is real pressure or none at all: Zoho locks a day
 * after a week, and that is a fact with a date on it rather than a progress bar
 * pretending to be a deadline.
 */
function Pulse({ nextIn, interval }: { nextIn: number | null; interval: number }) {
	const { data: p } = useLive(() => call('pulse'))
	const { busy, run } = useAction()
	if (!p) return null

	return (
		<div className="wp-card wp-stack-sm">
			<div className="wp-between">
				<span className="wp-stat">
					<span className="wp-eyebrow">Written down today</span>
					<span className="wp-big">
						{fmtMinutes(p.logged)}
						{!!p.target && <span className="wp-muted" style={{ fontSize: 15, fontWeight: 500 }}> of {fmtMinutes(p.target)}</span>}
					</span>
				</span>
				<span style={{ textAlign: 'right' }}>
					{p.streak.days > 0 ? (
						<>
							<span className="wp-big wp-ok-text">{p.streak.days}</span>
							<div className="wp-muted wp-small">day{p.streak.days === 1 ? '' : 's'} with nothing missing</div>
						</>
					) : (
						<span className="wp-muted wp-small">A day with nothing missing starts a run.</span>
					)}
				</span>
			</div>

			<DayBar logged={p.logged} target={p.target} elapsed={p.elapsed} />
			<DayStrip days={p.strip} today={p.today} />

			<div className="wp-between wp-small">
				<span className="wp-muted">
					{p.gap >= 30 ? (
						<button className="wp-action wp-warn-text" disabled={busy} onClick={() => run(() => call('logNow'))}>
							Log the {fmtMinutes(p.gap)} that is missing
						</button>
					) : p.checkedIn ? (
						'Nothing missing so far.'
					) : (
						'Not checked in yet.'
					)}
				</span>
				<span className="wp-muted">{nextIn == null ? `every ${interval} min` : nextIn <= 0 ? 'asking now' : `next in ${fmtMinutes(nextIn)}`}</span>
			</div>

			{/* The only deadline in the app it did not invent. */}
			{!!p.owed.length && (
				<div className="wp-banner" style={{ background: 'var(--wp-ok-soft)', color: 'var(--wp-warn)' }}>
					<span className="wp-grow">
						<strong>{p.owed[0].date}</strong> is {fmtMinutes(p.owed[0].minutes)} short and {p.owed[0].locks}
						{p.owed.length > 1 ? ` · ${p.owed.length - 1} more day${p.owed.length > 2 ? 's' : ''} owing` : ''}
					</span>
					<a className="wp-btn wp-btn-sm" href={`#/review/${p.owed[0].date}`}>
						Fill it in
					</a>
				</div>
			)}
		</div>
	)
}

export function TodayView() {
	const { data: s } = useLive(() => call('state'))
	const { data: review } = useLive(() => call('review'))
	const { data: saved, reload: reloadSaved } = useLive(() => call('savedFor', istDate(Date.now())))
	const { data: wiring } = useLive(() => call('wiring'))
	const { data: tasks, reload: reloadTasks } = useLive(() => call('tasks'))
	const { busy, error, run } = useAction()
	const now = useNow()
	if (!s) return <div className="wp-muted">Loading…</div>

	const { day } = s
	const jobName = new Map((review?.jobs ?? []).map((j) => [j.id, j.name]))
	const nextIn = s.nextPromptAt != null ? Math.round((s.nextPromptAt - now) / 60_000) : null
	const f = focus({ now, day, settings: s.settings, loggedMinutes: s.loggedMinutes, awaiting: s.awaiting, isWorkDay: isWorkDay(s.today, s.settings.workDays) })

	return (
		<div className="wp-stack" style={{ gap: 20 }}>
			<div className="wp-page-head">
				<div>
					<div className="wp-eyebrow">{prettyDate(s.today)}</div>
					<h1 className="wp-title">Today</h1>
				</div>
				{!day.isOff && (
					<button className="wp-btn wp-btn-ghost" disabled={busy} onClick={() => run(() => call('markOff'))}>
						Mark day off
					</button>
				)}
			</div>

			{/* Above everything, and only when there is something to fix. A day
			    Zoho is reading as an absence outranks anything about today —
			    and it is the one thing a brand-new install can act on. */}
			<Recover />

			{/* Only when there is something on the desk worth naming. */}
			<Desk />

			{/* Zoho's own word for today. Said out loud, because "the app has gone
			    quiet" and "the app is broken" look identical from here. */}
			{(day.isOff || day.offKind) && (
				<div className="wp-banner">
					<span className="wp-grow">
						{day.offKind ? kindLabel(day.offKind) : 'Day off'}
						{day.offKind && day.offKind !== 'half' ? ' — nothing will be asked of you today.' : day.offKind === 'half' ? ' — half the usual hours.' : ''}
					</span>
					{day.isOff && (
						<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => run(() => call('workingToday'))}>
							I'm working today
						</button>
					)}
				</div>
			)}

			{/* Before anything else: does this actually work yet? It takes itself
			    off the page once it does. */}
			<Ready />

			{/* What to do right now, before anything that explains it. One button:
			    check in, log the gap, close the day. */}
			<div className="wp-card">
				<DayActions s={s} />
			</div>

			{/* Then the day, the run behind it, and anything about to stop being
			    fixable — the three things worth knowing, in one card. */}
			<Pulse nextIn={nextIn} interval={s.settings.promptInterval} />

			{/* The morning, which takes itself off the page by lunchtime. */}
			<Briefing />

			{/* What is finished and waiting on somebody else. Compact here — the
			    whole picture is on Your record. */}
			<NotMoving compact />

			{!!tasks?.tasks.filter((t) => t.status !== 'done' && t.kind !== 'note').length && (
				<div className="wp-card wp-stack-sm">
					<div className="wp-between">
						<h2 className="wp-h2">Open tasks</h2>
						<a className="wp-link wp-small" href="#/tasks">
							All tasks
						</a>
					</div>
					<div className="wp-stack-sm wp-small wp-scroll">
						{tasks.tasks
							.filter((t) => t.status !== 'done' && t.kind !== 'note')
							.map((t) => (
								<div key={t.uid} className="wp-between">
									<span className="wp-grow" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
										{t.key && <span className="wp-muted">{t.key} · </span>}
										{t.title}
										{t.spentMinutes > 0 && <span className="wp-muted"> · {fmtMinutes(t.spentMinutes)}</span>}
									</span>
									<span className="wp-row">
										{tasks.timer?.task.uid === t.uid ? (
											<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => run(async () => void (await call('stopTimer'), await reloadTasks()))}>
												Stop
											</button>
										) : (
											<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => run(async () => void (await call('startTimer', t.uid), await reloadTasks()))}>
												Start
											</button>
										)}
										<button className="wp-btn wp-btn-sm wp-btn-soft" disabled={busy} onClick={() => run(async () => void (await call('answerTask', t.uid, 'done'), await reloadTasks()))}>
											Done
										</button>
									</span>
								</div>
							))}
					</div>
				</div>
			)}

			{!!saved?.length && (
				<div className="wp-card wp-stack-sm">
					<h2 className="wp-h2">Saved for today</h2>
					{saved.map((t) => (
						<div key={t.uid} className="wp-between">
							<span className="wp-grow" style={{ minWidth: 0 }}>
								{t.remindAt != null && <span className="wp-chip" style={{ marginRight: 6 }}>{istTime(t.remindAt)}</span>}
								{t.url ? (
									<a className="wp-link" href={t.url} target="_blank" rel="noreferrer">
										{t.title}
									</a>
								) : (
									t.title
								)}
								{t.kind === 'note' && <span className="wp-muted wp-small"> · kept</span>}
							</span>
							<span className="wp-row">
								{t.status !== 'done' && t.kind !== 'note' && (
									<button className="wp-btn wp-btn-sm wp-btn-soft" disabled={busy} onClick={() => run(async () => void (await call('answerTask', t.uid, 'done'), await reloadSaved()))}>
										Done
									</button>
								)}
								<button className="wp-btn wp-btn-sm wp-btn-ghost" disabled={busy} onClick={() => run(async () => void (await call('deleteTask', t.uid), await reloadSaved()))}>
									Remove
								</button>
							</span>
						</div>
					))}
				</div>
			)}

			<div className="wp-card">
				<div className="wp-between" style={{ marginBottom: 6 }}>
					<h2 className="wp-h2">Timeline</h2>
					<a className="wp-link wp-small" href="#/review">
						Review & timesheet
					</a>
				</div>
				{review && review.entries.length ? (
					<div className="wp-timeline wp-scroll">
						{review.entries.map((e) => (
							<div key={e.uid} className="wp-tl-item">
								<span className="wp-num wp-muted">
									{istTime(e.slotStart)} – {istTime(e.slotEnd)}
								</span>
								<span>
									{e.text}
									{e.jobId && <div className="wp-muted wp-small">{jobName.get(e.jobId) ?? e.jobId}</div>}
								</span>
								<span className="wp-row">
									{e.kind !== 'work' && <span className="wp-chip">{KIND_CHIP[e.kind]}</span>}
									{e.kind === 'work' && <span className="wp-num">{fmtMinutes(e.minutes)}</span>}
								</span>
							</div>
						))}
					</div>
				) : (
					<div className="wp-muted">
						<Art name="empty-today" size={96} />
						Nothing logged yet today. The first prompt comes {s.settings.promptInterval} minutes after check-in.</div>
				)}
			</div>
			{/* Everything below here is reference, not the day: folded, in one
			    group, so the page opens on what is happening rather than on nine
			    cards of equal weight. */}
			<Standup />
			<DayShape />
			<Goals />
			<Support />

			{(error || s.lastError) && <div className="wp-error">{error ?? s.lastError}</div>}
		</div>
	)
}

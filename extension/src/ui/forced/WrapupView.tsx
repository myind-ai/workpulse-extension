// The end of the day, said back to you — so closing it is a decision rather than
// a drift. Everything here is derived except two fields: how the goal went, and
// what to start with tomorrow. The second is what the next morning reads back.

import { useState } from 'react'

import type { DayPlan } from '@/core/briefing'
import { fmtMinutes, istTime, prettyDate } from '@/core/time'
import { call } from '@/lib/rpc'
import { Art } from '@/ui/Art'
import { Brand } from '@/ui/Brand'
import { DayStrip } from '@/ui/DayBar'
import { Busy } from '@/ui/Busy'
import { useAction, useLive } from '@/ui/hooks'

const VERDICTS: { id: NonNullable<DayPlan['verdict']>; label: string }[] = [
	{ id: 'done', label: 'Done' },
	{ id: 'partly', label: 'Partly' },
	{ id: 'blocked', label: 'Blocked' },
]

/**
 * The run of complete days, at the end of the day that joins it.
 *
 * It counts days with nothing missing, never days you opened the app — so it
 * cannot be earned by clicking, and leave, holidays and weekends step over it
 * rather than breaking it. A streak you can lose on a beach is a streak that
 * deserves to be ignored.
 */
function Run() {
	const { data: p } = useLive(() => call('pulse'))
	if (!p) return null
	return (
		<>
			<DayStrip days={p.strip} today={p.today} />
			<span className="wp-small wp-muted">
				{p.streak.atRisk && p.gap >= 30 ? (
					<>
						<strong className="wp-warn-text">{fmtMinutes(p.gap)} missing.</strong> Fill it in and today joins {p.streak.days ? `a run of ${p.streak.days}` : 'the run'}.
					</>
				) : p.streak.days ? (
					<>That makes {p.streak.days + 1} days with nothing missing.</>
				) : (
					<>A day with nothing missing starts a run.</>
				)}
			</span>
		</>
	)
}

export function WrapupView({ ctx }: { ctx: { date: string; loggedMinutes: number } }) {
	const { data } = useLive(() => call('dayReview'))
	// The day's own state, not the summary: ending the day must not depend on a
	// second call having come back. It is the card's whole purpose.
	const { data: today } = useLive(() => call('state'))
	const checkedOut = today?.day.checkedOutAt != null
	const [todos, setTodos] = useState<string[]>([])
	const [draft, setDraft] = useState('')
	const [saved, setSaved] = useState(false)
	const { busy, error, run } = useAction()

	const addTodo = (text: string) => {
		const t = text.trim()
		if (!t || todos.includes(t)) return setDraft('')
		setTodos([...todos, t].slice(0, 10))
		setDraft('')
		setSaved(false)
	}

	const save = (list = todos) =>
		run(async () => {
			await call('planTomorrow', list)
			setSaved(true)
		})

	return (
		<div className="wp-stack">
			<div className="wp-between">
				<Brand />
				<span className="wp-eyebrow">{prettyDate(ctx.date)}</span>
			</div>
			<Art name="wrapup" size={88} />

			<div>
				<h1 className="wp-title">Close your day</h1>
				<div className="wp-muted">Nothing here is typed except tomorrow's first task — the rest is what you logged.</div>
			</div>

			{/* The alarm is why this card is up: say what stops it, at the top. */}
			{today?.checkoutRinging && !checkedOut && (
				<div className="wp-banner">
					<span className="wp-grow">
						<strong>Your working day is over.</strong> The alarm rings until you check out.
					</span>
					<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => run(() => call('workingLate'))}>
						Working late
					</button>
				</div>
			)}

			<div className="wp-card-flat wp-stack-sm">
				<div className="wp-between">
					<span className="wp-muted">Logged today</span>
					<span className="wp-big">{fmtMinutes(data?.minutes ?? ctx.loggedMinutes)}</span>
				</div>
				{/* The run this day is about to join, or break. Said once, at the one
				    moment it can still be changed — which is the only moment saying
				    it is worth anything. */}
				<Run />
			</div>

			{/* Time on the clock that never became an entry: the gap that costs you
			    at review time, and the one thing worth fixing before closing. */}
			{!!data?.unlogged && data.unlogged >= 15 && (
				<div className="wp-banner">
					<span className="wp-grow">
						<strong>{fmtMinutes(data.unlogged)}</strong> on the clock never made it into an entry.
					</span>
					<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => run(() => call('logNow'))}>
						Log it
					</button>
				</div>
			)}

			{!!data?.worked.length && (
				<div className="wp-stack-sm wp-small">
					<span className="wp-eyebrow">Today went on</span>
					{data.worked.map((l) => (
						<div key={l.label} className="wp-between">
							<span style={{ minWidth: 0 }}>
								<strong>{l.label}</strong>
								{!!l.said.length && <span className="wp-muted"> — {l.said.join('; ')}</span>}
							</span>
							<span className="wp-num wp-muted">{fmtMinutes(l.minutes)}</span>
						</div>
					))}
				</div>
			)}

			{!!data?.done.length && (
				<div className="wp-stack-sm wp-small">
					<span className="wp-eyebrow">Finished</span>
					{data.done.map((t) => (
						<div key={t}>✓ {t}</div>
					))}
				</div>
			)}

			{/* The goal, if one was set this morning, gets its verdict here. */}
			{data?.goal && (
				<div className="wp-card-flat wp-stack-sm">
					<span className="wp-small">
						<span className="wp-eyebrow">Today's goal</span> <strong>{data.goal}</strong>
					</span>
					<div className="wp-row">
						{VERDICTS.map((v) => (
							<button
								key={v.id}
								className={data.verdict === v.id ? 'wp-btn wp-btn-sm wp-btn-soft' : 'wp-btn wp-btn-sm'}
								disabled={busy}
								aria-pressed={data.verdict === v.id}
								onClick={() => run(() => call('savePlan', ctx.date, { verdict: v.id }))}
							>
								{v.label}
							</button>
						))}
					</div>
				</div>
			)}

			<div className="wp-stack-sm">
				<label className="wp-label" htmlFor="wp-first">
					Tomorrow
				</label>

				{/* A day is rarely one thing. The first is what the morning suggests;
				    the rest are there so they are not carried in your head. */}
				{!!todos.length && (
					<div className="wp-stack-sm wp-small">
						{todos.map((t, i) => (
							<div key={t} className="wp-between">
								<span style={{ minWidth: 0 }}>
									<span className="wp-muted">{i + 1}.</span> {t}
									{i === 0 && <span className="wp-chip" style={{ marginLeft: 6 }}>first</span>}
								</span>
								<button
									className="wp-icon-btn"
									disabled={busy}
									title={`Remove “${t}”`}
									aria-label={`Remove ${t}`}
									onClick={() => {
										setTodos(todos.filter((x) => x !== t))
										setSaved(false)
									}}
								>
									✕
								</button>
							</div>
						))}
					</div>
				)}

				<div className="wp-row">
					<input
						id="wp-first"
						className="wp-input wp-grow"
						placeholder={todos.length ? 'And then…' : (data?.open[0] ?? 'The one thing to pick up first')}
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' && draft.trim()) {
								e.preventDefault()
								addTodo(draft)
							}
						}}
					/>
					<button className="wp-btn wp-btn-sm" disabled={busy || !draft.trim()} onClick={() => addTodo(draft)}>
						Add
					</button>
					<button className="wp-btn wp-btn-sm wp-btn-primary" disabled={busy || !(todos.length || draft.trim())} onClick={() => save(draft.trim() ? [...todos, draft.trim()] : todos)}>
						<Busy busy={busy} doing="Saving…">{saved ? 'Saved' : 'Set for tomorrow'}</Busy>
					</button>
				</div>

				{/* What is already open, so it is one click rather than retyping. */}
				{!!data?.open.length && (
					<div className="wp-row-wrap wp-small">
						{data.open
							.filter((t) => !todos.includes(t))
							.slice(0, 4)
							.map((t) => (
								<button key={t} className="wp-chip" onClick={() => addTodo(t)}>
									+ {t}
								</button>
							))}
					</div>
				)}
			</div>

			{error && <div className="wp-error">{error}</div>}

			{/* The card that exists to end the day had no way to end it. */}
			{!checkedOut ? (
				<div className="wp-row-wrap">
					<button className="wp-btn wp-btn-lg" disabled={busy} onClick={() => run(() => call('checkOut'))}>
						Check out
					</button>
					<button className="wp-btn wp-btn-ghost" disabled={busy} onClick={() => run(() => call('confirmAttendance', 'out'))}>
						I've already checked out
					</button>
				</div>
			) : (
				<div className="wp-ok-text wp-small">
					✓ Checked out{today?.day.checkedOutAt != null ? ` at ${istTime(today.day.checkedOutAt)}` : ''}. The timesheet is the last thing left.
				</div>
			)}

			{/* The card stays until the timesheet is dealt with — and "dealt with"
			    includes doing it in Zoho yourself, which WorkPulse cannot see. Without
			    this the only way to put the card down was to let it ask again
			    tomorrow. */}
			<div className="wp-row-wrap wp-small">
				<button
					className="wp-btn wp-btn-sm"
					disabled={busy}
					title="You filled the timesheet in Zoho yourself"
					onClick={() => run(() => call('markDone', ctx.date))}
				>
					I've already sent the timesheet
				</button>
				<span className="wp-muted">Marks today as logged here too, and closes this.</span>
			</div>

			<div className="wp-between">
				<button className="wp-btn wp-btn-ghost" disabled={busy} onClick={() => run(() => call('snooze'))}>
					Snooze 10 min
				</button>
				<button className="wp-btn wp-btn-primary wp-btn-lg" disabled={busy} onClick={() => run(() => call('goAndDo', 'review'))}>
					Review &amp; send the timesheet
				</button>
			</div>
		</div>
	)
}

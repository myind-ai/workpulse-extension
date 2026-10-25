// Meetings that repeat every week. Not tasks — you cannot finish a standup
// early — so they live here and only ever produce a nudge a few minutes before.

import { useState } from 'react'

import { nextMeetingAt, type Meeting, type MeetingKind } from '@/core/meetings'
import { istDate, istTime, prettyDate } from '@/core/time'
import { call } from '@/lib/rpc'
import { useAction, useLive } from '@/ui/hooks'
import { TimeField } from '@/ui/TimeField'

const DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
const WEEKDAYS = [1, 2, 3, 4, 5]

const blank = { name: '', kind: 'scrum' as MeetingKind, time: '09:45', days: WEEKDAYS, leadMinutes: 5, logMinutes: 0, jobId: '', autoLog: true }

/** What the card arrives with. A scrum gets the three points; the rest get the facts. */
const KINDS: { id: MeetingKind; label: string }[] = [
	{ id: 'scrum', label: 'Scrum / standup' },
	{ id: 'review', label: 'Review / demo' },
	{ id: 'one-to-one', label: 'One-to-one' },
	{ id: 'other', label: 'Something else' },
]

/** "Mon–Fri" reads better than five letters when it is the usual case. */
function saysDays(days: number[]): string {
	const sorted = [...days].sort()
	if (sorted.join() === WEEKDAYS.join()) return 'Mon–Fri'
	if (sorted.length === 7) return 'every day'
	return sorted.map((d) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d - 1]).join(', ')
}

/** "next at 09:40 today", "next Mon 19 Oct, 09:40", "muted". */
function whenNext(m: Meeting, now: number): string {
	if (!m.enabled) return 'muted'
	const at = nextMeetingAt(m, now)
	if (at == null) return 'never — no days picked'
	const date = istDate(at)
	if (date === istDate(now)) return `next at ${istTime(at)} today`
	if (date === istDate(now + 86_400_000)) return `next at ${istTime(at)} tomorrow`
	return `next ${prettyDate(date)}, ${istTime(at)}`
}

/**
 * "It moved to ten past" — today only.
 *
 * The weekly rule is untouched, which is the point: editing the rule means
 * remembering to put it back tomorrow, and nobody does.
 */
function MoveToday({ meeting, busy, onDone }: { meeting: Meeting; busy: boolean; onDone: () => Promise<unknown> }) {
	const [time, setTime] = useState('')
	const { run } = useAction()
	if (time === '')
		return (
			<button className="wp-btn wp-btn-sm" disabled={busy} title="It moved, or it is not happening — today only" onClick={() => setTime(meeting.time)}>
				Today…
			</button>
		)
	return (
		<span className="wp-row">
			<TimeField label={`New time for ${meeting.name}`} value={time} onChange={(v) => v && setTime(v)} width={100} />
			<button className="wp-btn wp-btn-sm wp-btn-primary" disabled={busy} onClick={() => run(async () => void (await call('moveMeeting', meeting.id, time), setTime(''), await onDone()))}>
				Move
			</button>
			<button className="wp-action wp-muted wp-small" disabled={busy} onClick={() => run(async () => void (await call('callOffMeeting', meeting.id), setTime(''), await onDone()))}>
				Not today
			</button>
			<button className="wp-action wp-muted wp-small" onClick={() => setTime('')}>
				Cancel
			</button>
		</span>
	)
}

export function Meetings() {
	const { data: list, reload } = useLive(() => call('meetings'))
	const { data: jobs } = useLive(() => call('jobs'))
	const now = Date.now()
	const today = istDate(now)
	const [form, setForm] = useState(blank)
	const { busy, error, run } = useAction()

	const save = () =>
		run(async () => {
			await call('saveMeeting', form)
			setForm(blank)
			await reload()
		})

	const toggle = (m: Meeting) => run(async () => void (await call('saveMeeting', { ...m, enabled: !m.enabled }), await reload()))

	return (
		<section className="wp-card wp-stack">
			<div className="wp-between">
				<h2 className="wp-h2">Meetings that repeat</h2>
				<span className="wp-muted wp-small">A nudge before each one, once a day</span>
			</div>

			{!!list?.length && (
				<div className="wp-stack-sm wp-small">
					{list.map((m) => (
						<div key={m.id} className="wp-between">
							<span className="wp-grow" style={{ minWidth: 0 }}>
								<strong style={{ opacity: m.enabled ? 1 : 0.55 }}>{m.name}</strong>
								<div className="wp-muted">
									{m.time} · {saysDays(m.days)} · {m.leadMinutes ? `${m.leadMinutes} min before` : 'when it starts'}
									{!!m.logMinutes && <span> · logs {m.logMinutes}m{m.autoLog === false ? ' (asks first)' : ' automatically'}</span>}
									{/* The one thing that answers "is this actually set up?" */}
									<span className={m.enabled ? 'wp-ok-text' : 'wp-muted'}> · {whenNext(m, now)}</span>
								</div>
								{/* Today only, and said out loud — a meeting quietly moved is
								    a meeting you miss. */}
								{m.skippedOn === today && (
									<div className="wp-warn-text">
										Called off today ·{' '}
										<button className="wp-action" disabled={busy} onClick={() => run(async () => void (await call('restoreMeeting', m.id), await reload()))}>
											put it back
										</button>
									</div>
								)}
								{m.movedOn?.date === today && (
									<div className="wp-warn-text">
										Moved to {m.movedOn.time} today ·{' '}
										<button className="wp-action" disabled={busy} onClick={() => run(async () => void (await call('restoreMeeting', m.id), await reload()))}>
											back to {m.time}
										</button>
									</div>
								)}
							</span>
							<span className="wp-row">
								<MoveToday meeting={m} busy={busy} onDone={reload} />
								<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => toggle(m)}>
									{m.enabled ? 'Mute' : 'Unmute'}
								</button>
								<button
									className="wp-btn wp-btn-sm"
									disabled={busy}
									title="Show the reminder now, exactly as it will appear"
									onClick={() => run(() => call('testMeeting', m.id))}
								>
									Test it
								</button>
								<button className="wp-btn wp-btn-sm wp-btn-ghost" aria-label={`Delete ${m.name}`} disabled={busy} onClick={() => run(async () => void (await call('deleteMeeting', m.id), await reload()))}>
									✕
								</button>
							</span>
						</div>
					))}
				</div>
			)}

			<div className="wp-row-wrap">
				<input className="wp-input wp-grow" style={{ minWidth: 160 }} placeholder="Standup, sprint review, 1:1…" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
				<select className="wp-select" style={{ width: 160 }} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as MeetingKind })} aria-label="What kind of meeting">
					{KINDS.map((k) => (
						<option key={k.id} value={k.id}>
							{k.label}
						</option>
					))}
				</select>
				<TimeField label="Time" value={form.time} onChange={(v) => v && setForm({ ...form, time: v })} width={110} />
				<select className="wp-select" style={{ width: 140 }} value={form.leadMinutes} onChange={(e) => setForm({ ...form, leadMinutes: Number(e.target.value) })} aria-label="How early">
					<option value={0}>when it starts</option>
					<option value={2}>2 min before</option>
					<option value={5}>5 min before</option>
					<option value={10}>10 min before</option>
					<option value={15}>15 min before</option>
				</select>
				<div className="wp-row">
					{DAYS.map((d, i) => {
						const n = i + 1
						const on = form.days.includes(n)
						return (
							<button
								key={n}
								className="wp-day-toggle"
								aria-pressed={on}
								aria-label={`Day ${n}`}
								onClick={() => setForm({ ...form, days: on ? form.days.filter((x) => x !== n) : [...form.days, n] })}
							>
								{d}
							</button>
						)
					})}
				</div>
				{/* The same half hour every weekday is work you do; typing it in
				    afterwards is the part people stop doing. */}
				<select
					className="wp-select"
					style={{ width: 150 }}
					value={form.logMinutes}
					onChange={(e) => setForm({ ...form, logMinutes: Number(e.target.value) })}
					aria-label="Put it on the timesheet"
				>
					<option value={0}>don't log it</option>
					{[15, 30, 45, 60, 90].map((n) => (
						<option key={n} value={n}>
							log {n} min
						</option>
					))}
				</select>
				{/* A standup that happens every day is not a question worth asking
				    every day. One that often gets cancelled is. */}
				{!!form.logMinutes && (
					<label className="wp-row wp-small" title="Write it onto the timesheet each day without asking. You can delete the row if it did not happen.">
						<input type="checkbox" checked={form.autoLog !== false} onChange={(e) => setForm({ ...form, autoLog: e.target.checked })} />
						<span>add it without asking</span>
					</label>
				)}
				{!!form.logMinutes && !!jobs?.length && (
					<select className="wp-select" style={{ maxWidth: 180 }} value={form.jobId} onChange={(e) => setForm({ ...form, jobId: e.target.value })} aria-label="Zoho job">
						<option value="">No job</option>
						{jobs.map((j) => (
							<option key={j.id} value={j.id}>
								{j.name}
							</option>
						))}
					</select>
				)}
				<button className="wp-btn wp-btn-primary" disabled={busy || !form.name.trim()} onClick={save}>
					Add
				</button>
			</div>
			{!!form.logMinutes && (
				<span className="wp-muted wp-small">After it finishes, WorkPulse asks whether it happened. Yes puts {form.logMinutes} minutes on today's timesheet at {form.time}.</span>
			)}
			{error && <div className="wp-error">{error}</div>}
		</section>
	)
}

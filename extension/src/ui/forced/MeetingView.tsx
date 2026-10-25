// A meeting about to start. Not a task and not a question: one line, one button,
// and a way to stop it reminding you about this one ever again.

import { useState } from 'react'

import type { Pending } from '@/core/types'
import { fmtMinutes } from '@/core/time'
import { call } from '@/lib/rpc'
import { Art } from '@/ui/Art'
import { Brand } from '@/ui/Brand'
import { TimeField } from '@/ui/TimeField'
import { copyText, useAction, useLive } from '@/ui/hooks'

/**
 * The half of the card that earns its place: what you did, ready to say.
 *
 * A reminder that a meeting is starting is a calendar's job. Arriving with
 * yesterday's work already written out, grouped by ticket, is the thing nobody
 * else can do — you said it an hour at a time, all day, and this hands it back
 * at the one moment you are asked for it.
 */
function Doings({ meetingId }: { meetingId: string }) {
	const { data } = useLive(() => call('meetingBrief', meetingId), [meetingId])
	const [copied, setCopied] = useState(false)
	if (!data?.points.length) return null

	return (
		<div className="wp-card-flat wp-stack-sm" style={{ textAlign: 'left' }}>
			<div className="wp-between">
				<span className="wp-eyebrow">{data.kind === 'scrum' ? 'Your three points' : data.when === 'morning' ? 'Since the last one' : 'Today, so far'}</span>
				<button
					className="wp-action wp-small"
					onClick={async () => {
						await copyText(data.text)
						setCopied(true)
						setTimeout(() => setCopied(false), 1500)
					}}
				>
					{copied ? 'Copied' : 'Copy for the chat'}
				</button>
			</div>
			{/* In the order a scrum goes round, so it can be read straight out. */}
			{data.points.map((p) => (
				<div key={p.heading} className="wp-small">
					<span className="wp-eyebrow">{p.heading}</span>
					<ul className="wp-list">
						{p.lines.slice(0, 5).map((line) => (
							<li key={line}>{line}</li>
						))}
						{p.lines.length > 5 && <li className="wp-muted">and {p.lines.length - 5} more</li>}
					</ul>
				</div>
			))}
			{data.minutes > 0 && <span className="wp-muted wp-small">{fmtMinutes(data.minutes)} logged that day.</span>}
		</div>
	)
}


/** It moved, or it is not happening. Both are today only. */
function Moved({ meetingId, onDone }: { meetingId: string; onDone: () => void }) {
	const [moving, setMoving] = useState(false)
	const [time, setTime] = useState('')
	const { busy, run } = useAction()

	if (moving)
		return (
			<div className="wp-row wp-small">
				<TimeField label="The time it moved to" value={time} onChange={setTime} />
				<button className="wp-btn wp-btn-sm wp-btn-primary" disabled={busy || !time} onClick={() => run(async () => void (await call('moveMeeting', meetingId, time), onDone()))}>
					Moved to this
				</button>
				<button className="wp-action wp-muted" onClick={() => setMoving(false)}>
					Cancel
				</button>
			</div>
		)

	return (
		<div className="wp-row wp-small">
			<button className="wp-action wp-muted" disabled={busy} onClick={() => setMoving(true)}>
				It moved today…
			</button>
			<button className="wp-action wp-muted" disabled={busy} title="Today only — it is back tomorrow" onClick={() => run(async () => void (await call('callOffMeeting', meetingId), onDone()))}>
				Not happening today
			</button>
		</div>
	)
}

export function MeetingView({ pending }: { pending: Pending }) {
	const { busy, error, run } = useAction()
	const [minutes, setMinutes] = useState(pending.logMinutes ?? 0)
	const asking = !!pending.logMinutes

	// After the meeting, the only question worth asking is whether it happened.
	if (asking)
		return (
			<div className="wp-stack">
				<div className="wp-between">
					<Brand />
					<span className="wp-eyebrow">Did it happen?</span>
				</div>

				<div>
					<div className="wp-slot">{pending.title}</div>
					<div className="wp-muted">{pending.body}</div>
				</div>

				<div className="wp-row">
					<label className="wp-label wp-small" htmlFor="wp-meet-min" style={{ flex: 'none' }}>
						Log
					</label>
					<input
						id="wp-meet-min"
						className="wp-input wp-num"
						style={{ width: 90 }}
						type="number"
						min={1}
						max={480}
						value={minutes}
						onChange={(e) => setMinutes(Number(e.target.value))}
					/>
					<span className="wp-muted wp-small">minutes — change it if it ran long or finished early</span>
				</div>

				{error && <div className="wp-error">{error}</div>}

				<div className="wp-between">
					<button className="wp-btn wp-btn-ghost" disabled={busy} onClick={() => run(() => call('skipMeeting', pending.meetingId ?? ''))}>
						It didn't happen
					</button>
					<button className="wp-btn wp-btn-primary" autoFocus disabled={busy || minutes < 1} onClick={() => run(() => call('logMeeting', pending.meetingId ?? '', minutes))}>
						Yes — log {minutes}m
					</button>
				</div>
				<div className="wp-muted wp-small">Goes on today's timesheet at the meeting's own time. Saved here; sent to Zoho when you close the day.</div>
			</div>
		)

	return (
		<div className="wp-stack">
			<div className="wp-between">
				<Brand />
				<span className="wp-eyebrow">Meeting</span>
			</div>

			<div className="wp-row">
				<Art name="meeting" size={64} />
				<div>
					<div className="wp-slot">{pending.title}</div>
					<div className="wp-muted">{pending.body}</div>
				</div>
			</div>

			{/* What you did, so you are not opening three tabs to remember it. */}
			{pending.meetingId && <Doings meetingId={pending.meetingId} />}

			{/* Meetings move. A weekly rule that cannot be bent for one day is a
			    rule people turn off. */}
			{pending.meetingId && <Moved meetingId={pending.meetingId} onDone={() => void call('dismiss')} />}

			{error && <div className="wp-error">{error}</div>}

			<div className="wp-between">
				<button
					className="wp-btn wp-btn-ghost"
					disabled={busy}
					title="Stop reminding me about this meeting"
					onClick={() => run(() => call('muteMeeting', pending.meetingId ?? ''))}
				>
					Mute this meeting
				</button>
				<button className="wp-btn wp-btn-primary" disabled={busy} autoFocus onClick={() => run(() => call('dismiss'))}>
					Got it
				</button>
			</div>
		</div>
	)
}

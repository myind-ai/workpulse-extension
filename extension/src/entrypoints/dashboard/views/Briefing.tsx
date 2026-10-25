// The morning, in one card. Nothing in it is maintained by hand: yesterday comes
// from your entries, what is unfinished from your tasks, and what to start with
// from signals that already exist — including the one thing you did type, which
// is what you decided last night.

import { useState } from 'react'

import { prettyDate, fmtMinutes } from '@/core/time'
import { call } from '@/lib/rpc'
import { useAction, useLive } from '@/ui/hooks'

/** Friday's one line, said back on the first morning of the week. */
function WeekIntention() {
	const { data } = useLive(() => call('weekReview'))
	const { data: held } = useLive(() => call('firstHourHeld'))
	const { busy, run } = useAction()
	const [done, setDone] = useState(false)
	if (!data?.lastIntention && held !== false) return null

	return (
		<div className="wp-lede">
			{data?.lastIntention && (
				<>
					<span className="wp-eyebrow">You said this would make the week better</span>
					<strong>{data.lastIntention}</strong>
				</>
			)}
			{/* The most valuable hour of the day is reliably spent on mail and
			    chat. One tap holds it, for ever. */}
			{held === false && !done && (
				<span className="wp-row wp-small" style={{ marginTop: 6 }}>
					<span className="wp-muted">Your first hour is the best one you get.</span>
					<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => run(async () => void (await call('holdFirstHour', 60), setDone(true)))}>
						Hold it for me
					</button>
				</span>
			)}
			{done && <span className="wp-ok-text wp-small">Held. It will offer itself each morning — change it under Settings.</span>}
		</div>
	)
}

export function Briefing() {
	const { data, reload } = useLive(() => call('briefing'))
	const [goal, setGoal] = useState<string | null>(null)
	const { busy, run } = useAction()

	if (!data) return null
	// What you lined up last night counts as something to show — without it a
	// plan made at check-out vanished the next morning, which is the one morning
	// it was written for.
	const nothing = !data.yesterday.length && !data.unfinished.length && !data.suggested.length && !data.goal && !data.planned.length
	if (nothing) return null

	const editing = goal != null
	const saveGoal = () =>
		run(async () => {
			await call('savePlan', data.date, { goal: (goal ?? '').trim() || undefined })
			setGoal(null)
			await reload()
		})

	return (
		<section className="wp-card wp-stack-sm">
			<div className="wp-between">
				<span className="wp-eyebrow">This morning</span>
				<span className="wp-muted wp-small">{prettyDate(data.about)}</span>
			</div>

			{/* The goal is the one line anyone types, so it sits where a headline
			    would, not in a row of controls. */}
			{editing ? (
				<div className="wp-row">
					<input
						className="wp-input wp-grow"
						autoFocus
						placeholder="Today's goal — one sentence"
						value={goal}
						onChange={(e) => setGoal(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') void saveGoal()
							if (e.key === 'Escape') setGoal(null)
						}}
					/>
					<button className="wp-btn wp-btn-sm wp-btn-primary" disabled={busy} onClick={saveGoal}>
						Save
					</button>
				</div>
			) : (
				<button className="wp-action" style={{ textAlign: 'left' }} onClick={() => setGoal(data.goal ?? '')}>
					{data.goal ? <span className="wp-title">{data.goal}</span> : <span className="wp-muted">+ Set one goal for today</span>}
				</button>
			)}

			{/* What you said on Friday would make this week better. Monday is the
			    only day it can still be acted on. */}
			<WeekIntention />

			{/* One thing to start with. Everything else on this card is context for
			    it, so it is the only thing with any weight. */}
			{!!data.suggested.length && (
				<div className="wp-lede">
					<span className="wp-eyebrow">Start with</span>
					<strong>{data.suggested[0].title}</strong>
					<span className="wp-muted wp-small">{data.suggested[0].why}</span>
					{data.suggested.length > 1 && (
						<span className="wp-muted wp-small" style={{ marginTop: 6 }}>
							or {data.suggested.slice(1).map((x) => x.title).join(' · ')}
						</span>
					)}
				</div>
			)}

			{/* Three short lists, not three paragraphs. */}
			<div className="wp-brief-cols">
				{!!data.planned.length && (
					<div>
						<span className="wp-eyebrow">You planned</span>
						<ol className="wp-list">
							{data.planned.map((t) => (
								<li key={t}>{t}</li>
							))}
						</ol>
					</div>
				)}
				<div>
					<span className="wp-eyebrow">{prettyDate(data.about)}</span>
					{!data.yesterday.length ? (
						<p className="wp-muted wp-small">Nothing logged.</p>
					) : (
						<ul className="wp-list">
							{data.yesterday.slice(0, 4).map((l) => (
								<li key={l.label}>
									{l.label} <span className="wp-muted">{fmtMinutes(l.minutes)}</span>
								</li>
							))}
						</ul>
					)}
				</div>
				<div>
					<span className="wp-eyebrow">Still open</span>
					{!data.unfinished.length ? (
						<p className="wp-muted wp-small">Nothing carried over.</p>
					) : (
						<ul className="wp-list">
							{data.unfinished.slice(0, 4).map((t) => (
								<li key={t}>{t}</li>
							))}
							{data.unfinished.length > 4 && <li className="wp-muted">and {data.unfinished.length - 4} more</li>}
						</ul>
					)}
				</div>
			</div>
		</section>
	)
}


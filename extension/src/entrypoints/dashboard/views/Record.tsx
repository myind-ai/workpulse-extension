// The questions you are asked twice a year and cannot answer.
//
// "What have you been working on?" · "Can you cover my tickets?" · "How many
// hours was that really?" Every answer here is assembled from lines you wrote
// at the time. Nothing is generated, nothing is guessed, and nothing leaves
// this machine until you copy it somewhere yourself.

import { useState } from 'react'

import { calibrationLine } from '@/core/calibrate'
import type { Licence } from '@/core/licence'
import { SPAN_LABEL, type Span } from '@/core/period'
import { fmtMinutes } from '@/core/time'
import { API_ENABLED } from '@/core/features'
import { reviewText } from '@/core/week'
import { call } from '@/lib/rpc'
import { NotMoving } from './NotMoving'
import { Busy } from '@/ui/Busy'
import { Heatmap } from '@/ui/Heatmap'
import { Icon } from '@/ui/Icon'
import { DateField } from '@/ui/TimeField'
import { Assess } from '@/ui/Assess'
import { WeekCost } from '@/ui/WeekCost'
import { ProNag } from '@/ui/ProNag'
import { copyText, useAction, useLive } from '@/ui/hooks'

const SPANS: Span[] = ['week', 'month', 'quarter', 'half', 'year']

export function RecordView() {
	// One read, one place. Scattering `isPro()` through these panels is how a
	// free tier quietly turns into a crippled one.
	const { data: s } = useLive(() => call('state'))
	const licence: Licence | undefined = s ? { tier: s.settings.licence, key: s.settings.licenceKey || undefined } : undefined
	return (
		<div className="wp-stack">
			<header className="wp-page-head">
				<div>
					<span className="wp-eyebrow">Written at the time, by you</span>
					<h1 className="wp-h1">Your record</h1>
					<p className="wp-muted wp-small" style={{ maxWidth: 560, margin: 0 }}>
						The appraisal, the 1:1, the handover, the hours. Nothing in here was invented: every line is one you typed when the work was in front of you.
					</p>
				</div>
			</header>

			{/* The question people actually come here with, first. The rest is in
			    the order it gets asked: the hours, the focus, the estimates, and
			    the handover you need twice a year. */}
			{/* Asked once, about the whole page, and never again once dismissed —
			    everything below it runs either way. */}
			<ProNag feature="record" licence={licence} />

			{/* The week first on a Friday, when it is the thing you came for. */}
			<ThisWeek />
			{/* Which meeting, and what broke the blocks — the two questions
			    'where did the week go' raises and cannot answer. */}
			<WeekCost />
			<NotMoving />
			<Period />

			{/* Built from the same period as above, and shown beside its sources.
			    This is the one people come back at review time for. */}
			<AssessPanel />
			<Hours />
			<Deep />
			<Months />
			<Calibration />
			<Cover />
		</div>
	)
}

/** Download and copy, in one place, because every section below wants both. */
function Take({ text, name }: { text: string; name: string }) {
	const [said, setSaid] = useState('')
	return (
		<span className="wp-row">
			<button
				className="wp-btn wp-btn-sm"
				onClick={async () => {
					await copyText(text)
					setSaid('Copied')
					setTimeout(() => setSaid(''), 1500)
				}}
			>
				{said || 'Copy'}
			</button>
			<button
				className="wp-btn wp-btn-sm wp-btn-ghost"
				onClick={() => {
					// A blob and an anchor: no permission, no host, nothing uploaded.
					const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
					const a = document.createElement('a')
					a.href = url
					a.download = name
					a.click()
					setTimeout(() => URL.revokeObjectURL(url), 1000)
				}}
			>
				Download .md
			</button>
		</span>
	)
}

/**
 * The last few months, at a glance. It used to sit on Today, where it answered
 * a question nobody asks at eleven in the morning — "how has the quarter gone"
 * belongs with the rest of the record.
 */
function Months() {
	const { data: history } = useLive(() => call('history'))
	const { data: s } = useLive(() => call('state'))
	const { busy, run } = useAction()
	if (!s) return null
	return (
		<section className="wp-card wp-stack-sm">
			<div className="wp-between">
				<h2 className="wp-h2">The last few months</h2>
				<span className="wp-row wp-small">
					{/* Days before WorkPulse existed are Zoho's to answer for. */}
					{API_ENABLED && s.hasZoho && (
						<button className="wp-action" disabled={busy} title="Fill the days WorkPulse never saw from Zoho's own report" onClick={() => run(() => call('fillHistory'))}>
							<Busy busy={busy} doing="Reading Zoho…">Fill from Zoho</Busy>
						</button>
					)}
					<span className="wp-muted">click a day to open it</span>
				</span>
			</div>
			<Heatmap days={history ?? []} targetMinutes={s.settings.minHours * 60} onPick={(date) => (location.hash = `#/review/${date}`)} />
			{history?.some((d) => d.fromZoho) && <span className="wp-muted wp-small">Lighter days are Zoho's hours, for days with nothing written down here.</span>}
		</section>
	)
}

/**
 * Where the week went, and the five minutes that make it worth knowing.
 *
 * No target: nobody knows what share of a week should be meetings, and an app
 * that invents a number and then measures you against it is making things up.
 */
function ThisWeek() {
	const { data } = useLive(() => call('week'))
	const { data: review, reload } = useLive(() => call('weekReview'))
	const [note, setNote] = useState('')
	const [said, setSaid] = useState('')
	const [copied, setCopied] = useState(false)
	const { busy, run } = useAction()
	if (!data?.split.logged) return null
	const { split } = data

	const share = (n: number) => (split.logged ? Math.round((n / split.logged) * 100) : 0)

	return (
		<section className="wp-card wp-stack-sm">
			<div className="wp-between">
				<h2 className="wp-h2">This week</h2>
				{review && (
					<button
						className="wp-action wp-muted"
						onClick={async () => {
							await copyText(reviewText(review))
							setCopied(true)
							setTimeout(() => setCopied(false), 1500)
						}}
					>
						{copied ? 'Copied' : 'Copy the update'}
					</button>
				)}
			</div>

			<div className="wp-row-wrap">
				<span className="wp-stat">
					<span className="wp-eyebrow">Logged</span>
					<span className="wp-big">{fmtMinutes(split.logged)}</span>
				</span>
				<span className="wp-stat">
					<span className="wp-eyebrow">Meetings</span>
					<span className="wp-big">
						{fmtMinutes(split.meetings)} <span className="wp-muted" style={{ fontSize: 14 }}>{share(split.meetings)}%</span>
					</span>
				</span>
				<span className="wp-stat">
					<span className="wp-eyebrow">Deep work</span>
					<span className="wp-big">
						{fmtMinutes(split.deep)} <span className="wp-muted" style={{ fontSize: 14 }}>{share(split.deep)}%</span>
					</span>
				</span>
				<span className="wp-stat">
					<span className="wp-eyebrow">Switches</span>
					<span className="wp-big wp-muted">{split.switches}</span>
				</span>
			</div>
			{data.line && <span className="wp-muted wp-small">{data.line}</span>}

			{/* What you said last Friday would make this week better. Said back,
			    because a resolution nobody reads again is one nobody keeps. */}
			{review?.lastIntention && (
				<div className="wp-lede">
					<span className="wp-eyebrow">Last Friday you said</span>
					{review.lastIntention}
				</div>
			)}

			<div className="wp-row">
				<input
					className="wp-input wp-grow"
					placeholder="One thing that would make next week better…"
					value={note}
					onChange={(e) => setNote(e.target.value)}
					onKeyDown={(e) => e.key === 'Enter' && note.trim() && void run(async () => void (await call('saveWeekIntention', note), setNote(''), setSaid('Kept — you will see it on Monday.'), await reload()))}
				/>
				<button className="wp-btn wp-btn-sm" disabled={busy || !note.trim()} onClick={() => run(async () => void (await call('saveWeekIntention', note), setNote(''), setSaid('Kept — you will see it on Monday.'), await reload()))}>
					Keep it
				</button>
			</div>
			{said && <span className="wp-ok-text wp-small">{said}</span>}
		</section>
	)
}

function Period() {
	const [span, setSpan] = useState<Span>('month')
	const [from, setFrom] = useState('')
	const [to, setTo] = useState('')
	const custom = span === 'custom'
	const { data } = useLive(() => call('period', span, custom ? from || undefined : undefined, custom ? to || undefined : undefined), [span, from, to])

	return (
		<section className="wp-card wp-stack">
			<div className="wp-between">
				<h2 className="wp-h2">What have you been working on?</h2>
				{data && <Take text={data.text} name={`workpulse-${data.report.from}-to-${data.report.to}.md`} />}
			</div>

			<div className="wp-row-wrap">
				<span className="wp-seg">
					{SPANS.map((s) => (
						<button key={s} aria-pressed={span === s} onClick={() => setSpan(s)}>
							{SPAN_LABEL[s]}
						</button>
					))}
				</span>
				<button className={custom ? 'wp-action' : 'wp-action wp-muted'} onClick={() => setSpan(custom ? 'month' : 'custom')}>
					{custom ? 'Back to spans' : 'Pick dates…'}
				</button>
				{custom && (
					<>
						<DateField label="From" value={from} onChange={setFrom} />
						<DateField label="To" value={to} onChange={setTo} />
					</>
				)}
			</div>

			{!data ? (
				<div className="wp-muted">Reading…</div>
			) : !data.report.lines.length ? (
				<div className="wp-muted">Nothing logged between {data.report.from} and {data.report.to}.</div>
			) : (
				<>
					<div className="wp-lede">
						<span className="wp-eyebrow">What it was mostly about</span>
						{data.report.headline.map((l) => (
							<div key={l.label}>
								<strong>{l.name ?? l.label}</strong> <span className="wp-muted">{fmtMinutes(l.minutes)} across {l.days} day{l.days === 1 ? '' : 's'}</span>
							</div>
						))}
						<span className="wp-muted wp-small" style={{ marginTop: 6 }}>
							{fmtMinutes(data.report.minutes)} over {data.report.daysWorked} days · {data.report.lines.length} things · {data.report.learnings.length} learnings
						</span>
					</div>

					<div className="wp-timeline">
						{data.report.lines.slice(0, 20).map((l) => (
							<div key={l.label} className="wp-tl-item">
								<span className="wp-num">{fmtMinutes(l.minutes)}</span>
								<span style={{ minWidth: 0 }}>
									<strong>{l.name ?? l.label}</strong>
									{!!l.said.length && <div className="wp-muted wp-small">{l.said.slice(0, 3).join(' · ')}</div>}
								</span>
								<span className="wp-muted wp-small">{l.days}d</span>
							</div>
						))}
					</div>
				</>
			)}
		</section>
	)
}

function Hours() {
	const [span, setSpan] = useState<'week' | 'month'>('week')
	const { data } = useLive(() => call('hours', span), [span])
	if (!data) return null
	const { o } = data

	return (
		<section className="wp-card wp-stack-sm">
			<div className="wp-between">
				<h2 className="wp-h2">The hours you actually worked</h2>
				<span className="wp-seg">
					<button aria-pressed={span === 'week'} onClick={() => setSpan('week')}>
						This week
					</button>
					<button aria-pressed={span === 'month'} onClick={() => setSpan('month')}>
						This month
					</button>
				</span>
			</div>

			{!o.days ? (
				<span className="wp-muted">Nothing on the clock yet.</span>
			) : (
				<>
					<div className="wp-row-wrap">
						<span className="wp-stat">
							<span className="wp-eyebrow">Worked</span>
							<span className="wp-big">{fmtMinutes(o.minutes)}</span>
						</span>
						<span className="wp-stat">
							<span className="wp-eyebrow">Meant to be</span>
							<span className="wp-big wp-muted">{fmtMinutes(o.expected)}</span>
						</span>
						<span className="wp-stat">
							<span className="wp-eyebrow">{o.over ? 'Over' : 'Short'}</span>
							<span className={`wp-big ${o.over ? 'wp-warn-text' : 'wp-muted'}`}>{fmtMinutes(o.over || o.short)}</span>
						</span>
					</div>
					{data.line && <div className="wp-muted wp-small">{data.line}</div>}
					{!!o.offDaysWorked.length && (
						<div className="wp-warn-text wp-small">
							Worked on {o.offDaysWorked.map((d) => d.date).join(', ')} — {o.offDaysWorked.length === 1 ? 'a day' : 'days'} Zoho has as not working.
						</div>
					)}
					<span className="wp-muted wp-small">Counted on this machine, from your own check-ins and entries. Nothing here is shared with anyone.</span>
				</>
			)}
		</section>
	)
}

/**
 * What the week's deep work came to.
 *
 * Deliberately without a target: nobody knows how many hours of focus a week
 * should hold, and an app that invents a number and then measures you against
 * it is an app making things up.
 */
function Deep() {
	const [span, setSpan] = useState<'week' | 'month'>('week')
	const { data } = useLive(() => call('deepWork', span), [span])
	if (!data) return null
	const peak = Math.max(60, ...data.stats.byDay.map((d) => d.minutes))

	return (
		<section className="wp-card wp-stack-sm">
			<div className="wp-between">
				<h2 className="wp-h2">Deep work</h2>
				<span className="wp-seg">
					<button aria-pressed={span === 'week'} onClick={() => setSpan('week')}>
						This week
					</button>
					<button aria-pressed={span === 'month'} onClick={() => setSpan('month')}>
						This month
					</button>
				</span>
			</div>
			{!data.stats.sessions ? (
				<span className="wp-muted wp-small">No blocks yet. In the widget: <strong>Focus</strong> → say what it is for → 25, 50 or 90 minutes. Nothing interrupts until it ends.</span>
			) : (
				<>
					<div className="wp-row-wrap">
						<span className="wp-stat">
							<span className="wp-eyebrow">Focused</span>
							<span className="wp-big">{fmtMinutes(data.stats.minutes)}</span>
						</span>
						<span className="wp-stat">
							<span className="wp-eyebrow">Blocks</span>
							<span className="wp-big">{data.stats.sessions}</span>
						</span>
						<span className="wp-stat">
							<span className="wp-eyebrow">Ran to the end</span>
							<span className="wp-big wp-muted">{data.stats.finished}</span>
						</span>
					</div>
					{/* A bar a day: the shape of a week of focus, which is the only
					    thing worth knowing about it. */}
					<div className="wp-row" style={{ alignItems: 'flex-end', gap: 4, height: 44 }}>
						{data.stats.byDay.map((d) => (
							<span
								key={d.date}
								title={`${d.date} · ${fmtMinutes(d.minutes)}`}
								style={{ flex: 1, height: `${Math.max(6, (d.minutes / peak) * 100)}%`, background: 'var(--wp-accent)', borderRadius: 3, opacity: 0.85 }}
							/>
						))}
					</div>
					{data.line && <span className="wp-muted wp-small">{data.line}</span>}
				</>
			)}
		</section>
	)
}

function Calibration() {
	const { data } = useLive(() => call('calibration'))
	if (!data) return null
	return (
		<section className="wp-card wp-stack-sm">
			<h2 className="wp-h2">How long things really take you</h2>
			<p className="wp-muted wp-small" style={{ margin: 0 }}>
				Give a ticket an estimate when you save it. Nothing else to do — the hours come from what you log against it anyway.
			</p>
			<div className={data.c.ready ? 'wp-lede' : 'wp-muted wp-small'}>{data.line ?? calibrationLine(data.c)}</div>
			{!!data.rows.length && (
				<div className="wp-timeline">
					{data.rows.slice(0, 8).map((r) => {
						const ratio = r.estimateMinutes ? r.actualMinutes / r.estimateMinutes : 0
						return (
							<div key={r.label} className="wp-tl-item">
								<span className="wp-num">{fmtMinutes(r.estimateMinutes)} said</span>
								<span style={{ minWidth: 0 }}>
									<strong>{r.label}</strong>
									<div className="wp-muted wp-small">{r.actualMinutes ? `${fmtMinutes(r.actualMinutes)} so far` : 'nothing logged against it yet'}</div>
								</span>
								<span className={ratio > 1.25 ? 'wp-warn-text wp-num' : 'wp-muted wp-num'}>{ratio ? `${ratio.toFixed(1)}×` : '—'}</span>
							</div>
						)
					})}
				</div>
			)}
		</section>
	)
}

function Cover() {
	const [days, setDays] = useState(14)
	const { data } = useLive(() => call('handover', days), [days])
	const { busy } = useAction()

	return (
		<section className="wp-card wp-stack-sm">
			<div className="wp-between">
				<h2 className="wp-h2">Cover for me</h2>
				{data && <Take text={data.text} name={`workpulse-cover-${data.h.from}.md`} />}
			</div>
			<p className="wp-muted wp-small" style={{ margin: 0 }}>
				Going on leave, or off ill. Where every ticket stands, the links with your own labels, the day's notes, and the thing that will catch someone out.
			</p>
			<div className="wp-row wp-small">
				<span className="wp-muted">Looking back</span>
				<select className="wp-select wp-sm" style={{ width: 130 }} value={days} disabled={busy} onChange={(e) => setDays(Number(e.target.value))} aria-label="How far back">
					<option value={7}>a week</option>
					<option value={14}>a fortnight</option>
					<option value={30}>a month</option>
				</select>
			</div>
			{data && (
				<div className="wp-card-flat wp-small" style={{ whiteSpace: 'pre-wrap', maxHeight: 260, overflowY: 'auto' }}>
					{data.text}
				</div>
			)}
			{!!data?.h.tickets.length && (
				<span className="wp-muted wp-small">
					<Icon name="check" size={12} /> {data.h.tickets.length} ticket{data.h.tickets.length === 1 ? '' : 's'}, {data.h.tickets.reduce((n, t) => n + t.links.length, 0)} links, {data.h.meetings.length} meetings.
				</span>
			)}
		</section>
	)
}


/**
 * The half-year, which is the span a review actually asks about.
 *
 * Its own dates rather than the Period panel's: somebody reading their last
 * month does not want a self-assessment, and somebody writing one is not
 * reading last month.
 */
function AssessPanel() {
	const { data } = useLive(() => call('period', 'half'))
	if (!data) return null
	return <Assess from={data.report.from} to={data.report.to} />
}

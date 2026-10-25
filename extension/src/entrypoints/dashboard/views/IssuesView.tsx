// Regularisation: the days that will cost you unless they are fixed before
// payroll. Each one carries the reason WorkPulse can write for you from what
// you logged, because remembering a Tuesday three weeks later is the hard part.

import { useState } from 'react'

import { istTime, prettyDate } from '@/core/time'
import { call } from '@/lib/rpc'
import { TimeField } from '@/ui/TimeField'
import { copyText, useAction, useLive } from '@/ui/hooks'
import { Busy } from '@/ui/Busy'

const KIND = {
	absent: { label: 'Absent', cls: 'wp-chip-danger', fix: 'Raise a regularisation for the whole day.' },
	missing_checkout: { label: 'Missing check-out', cls: 'wp-chip-warn', fix: 'Regularise the check-out time.' },
	short_hours: { label: 'Short hours', cls: 'wp-chip-warn', fix: 'Regularise the hours, or note the reason.' },
} as const

/**
 * The check-out you never made, closed at the time you actually stopped.
 *
 * Everything needed is already recorded — when the machine went quiet, the last
 * tick, the end of your last entry — so the row offers the answer rather than a
 * form and a guess.
 */
function CloseIt({ date, onDone }: { date: string; onDone: () => Promise<unknown> }) {
	const { data: left } = useLive(() => call('whenLeft', date), [date])
	const [at, setAt] = useState('')
	const [note, setNote] = useState('')
	const { busy, error, run } = useAction()
	if (!left) return null
	const time = at || istTime(left.at)

	if (note)
		return (
			<div className="wp-card-flat wp-stack-sm wp-small">
				<span className="wp-ok-text">Closed here at {time}. Zoho still needs the regularisation — the sentence is ready:</span>
				<div className="wp-card">{note}</div>
				<div className="wp-row">
					<button className="wp-btn wp-btn-sm wp-btn-primary" onClick={() => void copyText(note)}>
						Copy the reason
					</button>
					<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => run(() => call('openZoho'))}>
						Open Zoho attendance ↗
					</button>
				</div>
			</div>
		)

	return (
		<div className="wp-row-wrap wp-small" style={{ paddingLeft: 2 }}>
			<span className="wp-muted">{left.guessed ? 'No record of when you stopped —' : `You stopped at ${istTime(left.at)} —`}</span>
			<TimeField label={`The time you left on ${date}`} value={time} onChange={(v) => v && setAt(v)} width={96} />
			<button
				className="wp-btn wp-btn-sm"
				disabled={busy}
				onClick={() =>
					run(async () => {
						const [h, m] = time.split(':').map(Number)
						const stamp = Date.parse(`${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:30`)
						const r = await call('closeOpenDay', date, stamp)
						setNote(r.note)
						await onDone()
					})
				}
			>
				Close it at {time}
			</button>
			<span className="wp-muted">{left.why}</span>
			{error && <span className="wp-error">{error}</span>}
		</div>
	)
}

export function IssuesView() {
	const { data: s, reload } = useLive(() => call('state'))
	const [open, setOpen] = useState<string | null>(null)
	const [reason, setReason] = useState('')
	const [copied, setCopied] = useState(false)
	const { busy, error, run } = useAction()
	if (!s) return <div className="wp-muted">Loading…</div>

	const show = (date: string) =>
		run(async () => {
			setOpen(open === date ? null : date)
			setCopied(false)
			if (open !== date) setReason(await call('issueReason', date))
		})

	return (
		<div className="wp-stack" style={{ gap: 20 }}>
			<div className="wp-page-head">
				<div>
					<div className="wp-eyebrow">This month</div>
					<h1 className="wp-title">Regularisation</h1>
				</div>
				<div className="wp-row">
					<button className="wp-btn" disabled={busy} onClick={() => run(async () => void (await call('scanNow'), await reload()))}>
						<Busy busy={busy} doing="Reading Zoho…">Scan now</Busy>
					</button>
					<button className="wp-btn wp-btn-primary" disabled={busy} onClick={() => run(() => call('openZoho'))}>
						Open Zoho attendance
					</button>
				</div>
			</div>

			<div className="wp-card wp-stack-sm">
				{s.issues.length ? (
					s.issues.map((i) => {
						const kind = KIND[i.kind]
						return (
							<div key={i.date} className="wp-stack-sm" style={{ paddingBottom: 8 }}>
								<div className="wp-between">
									<span className="wp-row">
										<span className={`wp-chip ${kind.cls}`}>
											<span className="wp-dot" /> {kind.label}
										</span>
										<strong>{prettyDate(i.date)}</strong>
										<span className="wp-muted wp-small">{i.detail}</span>
									</span>
									<span className="wp-row">
										<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => show(i.date)}>
											{open === i.date ? 'Hide' : 'How to fix'}
										</button>
										{/* "Sorted" read as a verb: people asked what it sorted. It
										    marks the day fixed in Zoho, so it says that. */}
										<button
											className="wp-btn wp-btn-sm wp-btn-ghost"
											disabled={busy}
											title="Take this off the list — the next scan confirms it against Zoho"
											onClick={() => run(async () => void (await call('resolveIssue', i.date), await reload()))}
										>
											Fixed in Zoho
										</button>
									</span>
								</div>

								{/* A missing check-out is the one WorkPulse can answer itself:
								    it knows when the machine went quiet. Asking someone to
								    remember a time it already has is the app wasting what it
								    was there for. */}
								{i.kind === 'missing_checkout' && <CloseIt date={i.date} onDone={reload} />}

								{open === i.date && (
									<div className="wp-card-flat wp-stack-sm wp-small">
										<div>
											<strong>1.</strong> {kind.fix} <strong>2.</strong> Paste the reason below. <strong>3.</strong> Press <strong>Fixed in Zoho</strong> here.
										</div>
										<textarea className="wp-input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
										<div className="wp-row-wrap">
											<button
												className="wp-btn wp-btn-sm wp-btn-primary"
												onClick={async () => {
													await copyText(reason)
													setCopied(true)
												}}
											>
												{copied ? 'Copied' : 'Copy the reason'}
											</button>
											<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => run(() => call('openZoho'))}>
												Open Zoho
											</button>
											<a className="wp-link" href={`#/review/${i.date}`}>
												See that day
											</a>
										</div>
										<div className="wp-muted">Written from what you logged that day. Edit it before pasting if the wording needs to differ.</div>
									</div>
								)}
							</div>
						)
					})
				) : (
					<div className="wp-muted">Nothing to regularise. WorkPulse checks every morning after you check in.</div>
				)}
			</div>

			<div className="wp-muted wp-small wp-tail">
				{s.roleBlocked || !s.hasZoho
					? 'Checked against WorkPulse’s own record of your days, since Zoho’s attendance report needs API access your role does not have. It only knows days you used WorkPulse.'
					: 'Checked against Zoho’s own attendance report every morning.'}{' '}
				A day leaves this list when you press <strong>Sorted</strong>, and the next scan confirms it. Days near month end open this page on their own, so nothing
				slips past payroll.
			</div>
			{error && <div className="wp-error">{error}</div>}
		</div>
	)
}

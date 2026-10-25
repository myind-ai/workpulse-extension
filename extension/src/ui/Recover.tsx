// The first thing a new install says.
//
// Until now WorkPulse opened on a feature list and asked for a month of
// patience before it was worth anything. But most people arrive already
// holding the problem — a day or two that Zoho is reading as an absence — and
// the app has had the evidence to fix it the whole time.
//
// So this leads. Not a tour, not a checklist: a found problem, the punch it
// proposes, what that was built from, and one button. Somebody should be able
// to recover a real day inside a minute of installing.

import { useState } from 'react'

import { beforeAfter, type Recovery } from '@/core/recover'
import { istTime } from '@/core/time'
import { call } from '@/lib/rpc'
import { Icon } from '@/ui/Icon'
import { copyText, useAction, useLive } from '@/ui/hooks'

const dayName = (date: string) =>
	new Date(`${date}T12:00:00+05:30`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })

function Row({ r, onDone }: { r: Recovery; onDone: () => Promise<unknown> }) {
	const { busy, error, run } = useAction()
	const [note, setNote] = useState('')
	const [done, setDone] = useState(false)

	const apply = () =>
		run(async () => {
			const got = await call('recoverPunch', r.date, r.arrived?.at, r.left?.at)
			setNote(got.note)
			setDone(true)
			await onDone()
		})

	// Both proposals, with what each was built from. A punch somebody submits
	// is a claim they are making about themselves — they get to see the basis.
	const parts = [r.arrived && { what: 'In', p: r.arrived }, r.left && { what: 'Out', p: r.left }].filter(Boolean) as {
		what: string
		p: { at: number; why: string; guessed: boolean }
	}[]

	return (
		<div className="wp-card-flat wp-stack-sm">
			<div className="wp-between">
				<b>{dayName(r.date)}</b>
				<span className={r.sealsIn <= 2 ? 'wp-warn-text wp-small' : 'wp-muted wp-small'}>
					{r.sealsIn === 0 ? 'seals today' : `seals in ${r.sealsIn} day${r.sealsIn === 1 ? '' : 's'}`}
				</span>
			</div>

			{done ? (
				<>
					<span className="wp-ok-text wp-small wp-row">
						<Icon name="check" size={14} /> Recovered · {beforeAfter(r)}
					</span>
					{/* Fixed here is not fixed in Zoho. The note is the thing that
					    actually has to be filed, so it is handed over, not hidden. */}
					<p className="wp-muted wp-small" style={{ margin: 0 }}>
						Now file it in Zoho with this reason:
					</p>
					<div className="wp-row">
						<code className="wp-grow wp-small" style={{ overflowWrap: 'anywhere' }}>
							{note}
						</code>
						<button className="wp-action" onClick={() => void copyText(note)} title="Copy the reason">
							<Icon name="copy" size={12} />
						</button>
					</div>
				</>
			) : (
				<>
					<span className="wp-big">{beforeAfter(r)}</span>
					<div className="wp-stack-sm wp-small">
						{parts.map((x) => (
							<span key={x.what} className="wp-row">
								<span className="wp-muted" style={{ minWidth: 28 }}>
									{x.what}
								</span>
								<b className="wp-num">{istTime(x.p.at)}</b>
								<span className={x.p.guessed ? 'wp-warn-text' : 'wp-muted'}>
									{x.p.guessed ? `guessed from ${x.p.why}` : `from ${x.p.why}`}
								</span>
							</span>
						))}
					</div>
					<div className="wp-row">
						<button className="wp-btn wp-btn-sm" disabled={busy} onClick={apply}>
							Recover this day
						</button>
						<button className="wp-action wp-muted" disabled={busy} onClick={() => run(async () => void (await call('markOff', r.date), await onDone()))}>
							I did not work it
						</button>
					</div>
				</>
			)}
			{error && <span className="wp-error wp-small">{error}</span>}
		</div>
	)
}

/**
 * Shown at the top of Today whenever there is something to recover, and
 * nowhere at all when there is not — an empty "all clear" panel earns its
 * space exactly once and costs it every day after.
 */
export function Recover() {
	const { data, reload } = useLive(() => call('missingPunches'))
	if (!data?.list.length) return null

	return (
		<section className="wp-card wp-stack-sm">
			<div className="wp-between">
				<div>
					<span className="wp-eyebrow">Zoho is reading these as absences</span>
					<h2 className="wp-h2">{data.headline}</h2>
				</div>
				<Icon name="clock" size={18} />
			</div>
			<p className="wp-muted wp-small" style={{ margin: 0, maxWidth: 560 }}>
				WorkPulse was running on these days and kept what it saw. That is a better account
				of when you started and stopped than anybody&rsquo;s memory a week later.
			</p>
			{data.list.map((r) => (
				<Row key={r.date} r={r} onDone={reload} />
			))}
		</section>
	)
}

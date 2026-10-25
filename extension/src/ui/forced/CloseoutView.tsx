// A day that was never closed.
//
// The lid went down at seven and nothing was running to punch you out. By the
// time anyone opens a regularisation form, "what time did you leave on Tuesday"
// is a guess — so this arrives with the answer already worked out, from the
// moment the machine actually went quiet.
//
// Three endings, because there are three truths: you left then and Zoho needs
// telling; you did check out elsewhere and only WorkPulse missed it; or the
// time is wrong and you will say what it was.

import { useState } from 'react'

import { istTime, prettyDate } from '@/core/time'
import type { Pending } from '@/core/types'
import { call } from '@/lib/rpc'
import { Art } from '@/ui/Art'
import { Brand } from '@/ui/Brand'
import { TimeField } from '@/ui/TimeField'
import { copyText, useAction } from '@/ui/hooks'

export function CloseoutView({ pending }: { pending: Pending }) {
	const date = pending.date ?? ''
	const [at, setAt] = useState(pending.leftAt != null ? istTime(pending.leftAt) : '18:00')
	const [note, setNote] = useState('')
	const { busy, error, run } = useAction()

	const close = (how: 'regularise' | 'already') =>
		run(async () => {
			const [h, m] = at.split(':').map(Number)
			const when = new Date(pending.leftAt ?? Date.now())
			// The date is the day being closed; only the time is being chosen.
			const stamp = Date.parse(`${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:30`)
			const r = await call('closeOpenDay', date, Number.isFinite(stamp) ? stamp : when.getTime(), how)
			if (how === 'regularise') setNote(r.note)
		})

	if (note)
		return (
			<div className="wp-stack">
				<div className="wp-between">
					<Brand />
					<span className="wp-eyebrow">Closed</span>
				</div>
				<h1 className="wp-title">{prettyDate(date)} is closed here</h1>
				<p className="wp-muted">Zoho still has the day open, so it needs a regularisation. The sentence it wants is written — paste it in.</p>
				<div className="wp-card-flat wp-small">{note}</div>
				<div className="wp-row">
					<button className="wp-btn wp-btn-primary" onClick={() => void copyText(note)}>
						Copy the reason
					</button>
					<button className="wp-btn" disabled={busy} onClick={() => run(() => call('openZoho'))}>
						Open Zoho attendance ↗
					</button>
					<button className="wp-btn wp-btn-ghost" disabled={busy} onClick={() => run(() => call('dismiss'))}>
						Later
					</button>
				</div>
			</div>
		)

	return (
		<div className="wp-stack">
			<div className="wp-between">
				<Brand />
				<span className="wp-eyebrow">Yesterday</span>
			</div>

			<div className="wp-row">
				<Art name="wrapup" size={56} />
				<div>
					<h1 className="wp-title">{prettyDate(date)} was never closed</h1>
					<div className="wp-muted">
						Zoho has a check-in with nothing after it, which it reads as a missing check-out.
					</div>
				</div>
			</div>

			{/* The number nobody can remember a fortnight later, worked out while
			    the evidence was still around. */}
			<div className="wp-card-flat wp-stack-sm">
				<span className="wp-eyebrow">{pending.leftGuessed ? 'Best guess' : 'You stopped at'}</span>
				<div className="wp-row">
					<TimeField label="The time you stopped" value={at} onChange={(v) => v && setAt(v)} width={110} />
					<span className="wp-muted wp-small">{pending.leftWhy}</span>
				</div>
			</div>

			{error && <div className="wp-error">{error}</div>}

			<div className="wp-row-wrap">
				<button className="wp-btn wp-btn-primary wp-btn-lg" disabled={busy} onClick={() => close('regularise')}>
					Close it at {at}
				</button>
				<button className="wp-btn" disabled={busy} title="You punched out in Zoho and only WorkPulse missed it" onClick={() => close('already')}>
					I did check out
				</button>
			</div>
			<span className="wp-muted wp-small">
				Closing it here records the day and writes the regularisation sentence. Nothing is sent to Zoho without you.
			</span>
		</div>
	)
}

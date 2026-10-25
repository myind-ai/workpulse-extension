// The tidied timesheet, shown beside the one it came from.
//
// A model cannot be stopped from inventing a claim using only words it was
// given — so nothing here is applied, saved or sent until somebody has read
// both columns. "Cite, or do not claim" is enforced where it can be (the row
// count, the hours, which never leave this machine) and *shown* where it
// cannot: the original sits next to the draft, and a word that arrived from
// nowhere is called out.

import { useState } from 'react'

import { fmtMinutes } from '@/core/time'
import { call } from '@/lib/rpc'
import { Icon } from '@/ui/Icon'
import { copyText, useAction } from '@/ui/hooks'

interface Row {
	jobName: string
	minutes: number
	was: string
	now: string
	novel: string[]
}

export function DraftRows({ date }: { date: string }) {
	const [rows, setRows] = useState<Row[] | null>(null)
	const [said, setSaid] = useState('')
	const { busy, error, run } = useAction()

	const draft = () =>
		run(async () => {
			setSaid('')
			setRows((await call('draftTimesheet', date)).rows)
		})

	return (
		<div className="wp-stack-sm">
			<div className="wp-row">
				<button className="wp-btn wp-btn-sm" disabled={busy} onClick={draft}>
					<Icon name="bulb" size={13} /> {rows ? 'Draft again' : 'Tidy the descriptions'}
				</button>
				<span className="wp-muted wp-small">Your own model, your own key. Nothing is saved until you copy it.</span>
			</div>

			{rows && (
				<>
					{rows.map((r, i) => (
						<div key={i} className="wp-card-flat wp-stack-sm">
							<div className="wp-between wp-small">
								<b>{r.jobName}</b>
								{/* The hours were never in the model's reach: it is handed
								    text and asked for text back. */}
								<span className="wp-muted wp-num">{fmtMinutes(r.minutes)} · unchanged</span>
							</div>
							<div className="wp-small wp-muted" style={{ textDecoration: 'line-through', opacity: 0.7 }}>
								{r.was || 'nothing written'}
							</div>
							<div className="wp-row">
								<span className="wp-grow">{r.now}</span>
								<button className="wp-action" title="Copy this line" onClick={() => void copyText(r.now)}>
									<Icon name="copy" size={12} />
								</button>
							</div>
							{!!r.novel.length && (
								<span className="wp-warn-text wp-small">
									Not in your own notes: {r.novel.join(', ')} — check this before you submit it.
								</span>
							)}
						</div>
					))}
					<div className="wp-row">
						<button
							className="wp-action"
							onClick={() => run(async () => void (await copyText(rows.map((r) => `${r.jobName}\t${fmtMinutes(r.minutes)}\t${r.now}`).join('\n')), setSaid('All rows copied.')))}
						>
							<Icon name="copy" size={12} /> Copy every row
						</button>
						{said && <span className="wp-ok-text wp-small">{said}</span>}
					</div>
				</>
			)}
			{error && <span className="wp-error wp-small">{error}</span>}
		</div>
	)
}

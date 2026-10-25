// What a ticket taught you, on the ticket. Written here it is already linked;
// written anywhere else it can be linked later from the journal.

import { useState } from 'react'

import { KIND_LABEL, type LearnKind } from '@/core/learn'
import { istDate } from '@/core/time'
import { call } from '@/lib/rpc'
import { useAction, useLive } from '@/ui/hooks'
import { Markdown } from '@/ui/Markdown'
import { TagPicker } from '@/ui/TagPicker'

const KINDS: LearnKind[] = ['learning', 'mistake', 'howto']

export function TicketLearnings({ ticketId }: { ticketId: string }) {
	const { data: items, reload } = useLive(() => call('learnFor', ticketId), [ticketId])
	const { data: known } = useLive(() => call('learnTags'))
	const [text, setText] = useState('')
	const [kind, setKind] = useState<LearnKind>('learning')
	const { busy, error, run } = useAction()

	const save = () =>
		run(async () => {
			await call('saveLearning', { text, kind, ticketId, date: istDate(Date.now()) })
			setText('')
			await reload()
		})

	return (
		<div className="wp-stack-sm">
			<div className="wp-between">
				<span className="wp-eyebrow">What this taught you</span>
				<a className="wp-link wp-small" href="#/journal">
					All learnings →
				</a>
			</div>

			{!items?.length && <span className="wp-muted wp-small">Nothing yet. A gotcha written here is the thing you will look for next time this ticket comes back.</span>}
			{items?.map((l) => (
				<div key={l.id} className="wp-card-flat wp-stack-sm">
					<span className="wp-row wp-small">
						<strong>{KIND_LABEL[l.kind]}</strong>
						<span className="wp-muted">{l.date}</span>
						{l.tags.map((t) => (
							<span key={t} className="wp-chip">
								#{t}
							</span>
						))}
					</span>
					<Markdown text={l.text} />
				</div>
			))}

			<div className="wp-stack-sm">
				<input
					className="wp-input"
					placeholder="A gotcha, a decision, something you would not repeat…"
					value={text}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && text.trim()) void save()
					}}
				/>
				{!!text.trim() && (
					<>
						<TagPicker text={text} onChange={setText} known={known ?? []} />
						<div className="wp-between wp-small">
							<span className="wp-row">
								{KINDS.map((k) => (
									<button key={k} className={kind === k ? 'wp-btn wp-btn-sm wp-btn-soft' : 'wp-btn wp-btn-sm'} onClick={() => setKind(k)} aria-pressed={kind === k}>
										{KIND_LABEL[k]}
									</button>
								))}
							</span>
							<button className="wp-btn wp-btn-sm wp-btn-primary" disabled={busy} onClick={save}>
								Save
							</button>
						</div>
					</>
				)}
				{error && <div className="wp-error wp-small">{error}</div>}
			</div>
		</div>
	)
}

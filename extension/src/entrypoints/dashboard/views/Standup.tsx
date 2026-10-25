// Your standup, written from the day you actually had. The one thing a tracker
// and a ticket system cannot do between them: a tracker knows which tabs were
// open, Jira knows a ticket moved, and neither knows what you did — but you said
// it, an hour at a time, all day.

import { useState } from 'react'

import { standupText, type StandupStyle } from '@/core/standup'
import { prettyDate } from '@/core/time'
import { call } from '@/lib/rpc'
import { copyText, useAction, useLive } from '@/ui/hooks'
import { Panel } from '@/ui/Panel'

const STYLES: { id: StandupStyle; label: string }[] = [
	{ id: 'slack', label: 'Slack' },
	{ id: 'markdown', label: 'Markdown' },
	{ id: 'plain', label: 'Plain' },
]

export function Standup() {
	const { data } = useLive(() => call('standup'))
	const [style, setStyle] = useState<StandupStyle>('slack')
	const [copied, setCopied] = useState(false)
	const { busy, run } = useAction()

	if (!data) return null
	// The background hands back the data as well as the text, so switching the
	// shape is the same function run again here rather than a round trip.
	const text = standupText(data.data, style)

	return (
		<Panel
			title="Your standup"
			hint={`From ${prettyDate(data.date)} · ${data.data.yesterday.length} thing${data.data.yesterday.length === 1 ? '' : 's'}${data.data.blocked.length ? ` · ${data.data.blocked.length} blocked` : ''}`}
			keywords="standup daily scrum update yesterday today blocked slack copy"
			open={false}
		>
			<div className="wp-between wp-small">
				<span className="wp-row">
					{STYLES.map((s) => (
						<button key={s.id} className={style === s.id ? 'wp-btn wp-btn-sm wp-btn-soft' : 'wp-btn wp-btn-sm'} onClick={() => setStyle(s.id)} aria-pressed={style === s.id}>
							{s.label}
						</button>
					))}
				</span>
				<button
					className="wp-btn wp-btn-sm wp-btn-primary"
					disabled={busy}
					onClick={() =>
						run(async () => {
							await copyText(text)
							setCopied(true)
							setTimeout(() => setCopied(false), 2000)
						})
					}
				>
					{copied ? 'Copied' : 'Copy'}
				</button>
			</div>

			<pre className="wp-md-code" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
				{text}
			</pre>

			<span className="wp-muted wp-small">
				Grouped by ticket where your entries named one, by job where they did not. <strong>Today</strong> is your three highest-priority open tasks;{' '}
				<strong>Blocked</strong> is whatever you marked as waiting on someone.
			</span>
		</Panel>
	)
}

// Which ticket does this belong to?
//
// A dropdown of forty tickets is a list you scroll, not a question you answer.
// This is the same shape every other search in the app uses: type a word, see
// what matches, press the one you meant — with the likely answer offered first
// and a reason attached, because a suggestion you cannot check is one you
// either take blindly or ignore.

import { useState } from 'react'

import { call } from '@/lib/rpc'
import { Icon } from '@/ui/Icon'
import { useAction, useLive } from '@/ui/hooks'

export function TicketPicker({
	url,
	text,
	current,
	onPick,
	onCancel,
}: {
	/** The page, so the likely ticket can be worked out from it. */
	url?: string
	/** What was written about it, which may name the ticket outright. */
	text?: string
	/** What it is filed under now, if anything. */
	current?: string
	onPick: (ticketId: string) => void | Promise<unknown>
	onCancel?: () => void
}) {
	const { data: tickets } = useLive(() => call('ticketList', true))
	const { data: likely } = useLive(() => (url ? call('ticketFor', url, '', text ?? '') : Promise.resolve(null)), [url, text])
	const [q, setQ] = useState('')
	const { busy, run } = useAction()

	const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
	const shown = (tickets ?? [])
		.filter((t) => words.every((w) => t.name.toLowerCase().includes(w)))
		.slice(0, 8)

	return (
		<div className="wp-stack-sm wp-small" style={{ minWidth: 240 }}>
			<div className="wp-row">
				<input
					className="wp-input wp-sm wp-grow"
					autoFocus
					placeholder="Find a ticket…"
					value={q}
					onChange={(e) => setQ(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Escape') onCancel?.()
						if (e.key === 'Enter' && shown[0]) void run(async () => onPick(shown[0].id))
					}}
				/>
				{onCancel && (
					<button className="wp-action wp-muted" onClick={onCancel}>
						Cancel
					</button>
				)}
			</div>

			{/* The one it is probably about, with why — so it can be checked. */}
			{likely && !q && likely.id !== current && (
				<button className="wp-btn wp-btn-sm wp-btn-soft" style={{ justifyContent: 'flex-start', width: '100%' }} disabled={busy} title={`Because ${likely.why}`} onClick={() => run(async () => onPick(likely.id))}>
					<Icon name="group" size={13} /> {likely.name}
					<span className="wp-muted" style={{ marginLeft: 6 }}>— {likely.why}</span>
				</button>
			)}

			<div className="wp-stack-sm wp-scroll-sm">
				{!shown.length && <span className="wp-muted">{tickets?.length ? `No ticket matches “${q}”.` : 'No tickets yet.'}</span>}
				{shown.map((t) => (
					<button
						key={t.id}
						className={t.id === current ? 'wp-btn wp-btn-sm wp-btn-soft' : 'wp-btn wp-btn-sm'}
						style={{ justifyContent: 'flex-start', width: '100%' }}
						disabled={busy}
						onClick={() => run(async () => onPick(t.id))}
					>
						<span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
						{t.id === current && <span className="wp-muted" style={{ marginLeft: 'auto' }}>filed here</span>}
					</button>
				))}
			</div>

			{!!current && (
				<button className="wp-action wp-muted" disabled={busy} onClick={() => run(async () => onPick(''))}>
					Take it out of its ticket
				</button>
			)}
		</div>
	)
}

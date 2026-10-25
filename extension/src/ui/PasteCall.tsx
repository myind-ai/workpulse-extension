// Paste one of Zoho's own calls, copied from DevTools. Lives wherever a call
// turns out to be missing — the panel in Connect Zoho, and next to the push
// error in Review — so the fix is always where the problem appeared.

import { useState } from 'react'

import { call } from '@/lib/rpc'
import { useAction } from '@/ui/hooks'

const KIND_LABEL: Record<string, string> = {
	attendance: 'your check-in status',
	projects: 'your projects',
	jobs: 'your projects and tasks',
	timesheet: 'the rows already logged',
	write: 'saving a time log',
}

export function PasteCall({ hint, onAdded }: { hint?: string; onAdded?: () => void }) {
	const [text, setText] = useState('')
	const [said, setSaid] = useState('')
	const { busy, error, run } = useAction()

	return (
		<div className="wp-stack-sm">
			<textarea
				className="wp-input wp-num"
				rows={4}
				placeholder={hint ?? "curl --url 'https://people.zoho.in/logiciel/…' …"}
				value={text}
				onChange={(e) => setText(e.target.value)}
			/>
			<div className="wp-row-wrap">
				<button
					className="wp-btn wp-btn-sm wp-btn-primary"
					disabled={busy || !text.trim()}
					onClick={() =>
						run(async () => {
							const r = await call('addCurl', text)
							setSaid(r.kind ? `Added — ${KIND_LABEL[r.kind] ?? r.kind}.` : 'Added, but WorkPulse cannot tell what that call is for.')
							setText('')
							onAdded?.()
						})
					}
				>
					Add this call
				</button>
				<span className={said ? 'wp-ok-text wp-small' : 'wp-muted wp-small'}>{said || 'Cookies in the paste are discarded; only the address, body and plain headers are kept.'}</span>
			</div>
			{error && <div className="wp-error">{error}</div>}
		</div>
	)
}

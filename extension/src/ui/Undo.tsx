// "That was not what I meant."
//
// One line, wherever something was just done, offering to put it back. It
// appears only when there is something to undo and only for a few minutes,
// because an Undo button that is always there is a button nobody reads.

import { useState } from 'react'

import { call } from '@/lib/rpc'
import { useAction, useLive } from '@/ui/hooks'

export function Undo({ onUndone }: { onUndone?: () => Promise<unknown> | void }) {
	const { data, reload } = useLive(() => call('undoable'))
	const [said, setSaid] = useState('')
	const { busy, run } = useAction()
	if (said) return <span className="wp-ok-text wp-small">{said}</span>
	if (!data) return null

	return (
		<button
			className="wp-action wp-small"
			disabled={busy}
			title="Put it back as it was"
			onClick={() =>
				run(async () => {
					const r = await call('undo')
					setSaid(r ? 'Put back.' : 'Too late to undo that one.')
					setTimeout(() => setSaid(''), 2500)
					await reload()
					await onUndone?.()
				})
			}
		>
			↩ {data.label}
		</button>
	)
}

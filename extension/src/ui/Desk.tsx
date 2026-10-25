// What is on the desk, and the one action that clears it.
//
// Deliberately small and usually silent. The drift line appears only once a
// second ticket has genuinely turned up — not every time you glance at the
// window — because a line that is always there is furniture within a day, and
// a line that is wrong a third of the time gets the whole feature switched off
// within a week.

import { useState } from 'react'

import { call } from '@/lib/rpc'
import { Icon } from '@/ui/Icon'
import { useAction, useLive } from '@/ui/hooks'

export function Desk() {
	const { data, reload } = useLive(() => call('deskState'))
	const { data: groups, reload: reloadGroups } = useLive(() => call('groups'))
	const [name, setName] = useState('')
	const { busy, error, run } = useAction()
	if (!data) return null

	const park = () =>
		run(async () => {
			const as = name.trim() || data.context?.name || 'Parked'
			const got = await call('parkDesk', as)
			setName('')
			await Promise.all([reload(), reloadGroups()])
			return got
		})

	// Nothing to say and nothing to do: say nothing.
	if (!data.line && !data.load.line && !groups?.length) return null

	return (
		<section className="wp-card wp-stack-sm">
			<div className="wp-between">
				<span className="wp-eyebrow">The desk</span>
				{data.context && (
					<span
						className={data.context.stated ? 'wp-chip wp-chip-accent' : 'wp-chip'}
						title={data.context.stated ? 'What you said this block is for' : 'What most of this desk is about — nothing was declared'}
					>
						{data.context.stated && <span className="wp-dot" />}
						{data.context.name}
						{!data.context.stated && <span className="wp-faint"> · observed</span>}
					</span>
				)}
			</div>

			{/* The number nobody has. Not "40 tabs" — everyone knows that and it
			    changes nothing — but how many separate jobs are on one desk. */}
			{data.load.line && <p className="wp-small wp-warn-text" style={{ margin: 0 }}>{data.load.line}</p>}
			{data.line && <p className="wp-small" style={{ margin: 0 }}>{data.line}</p>}

			<div className="wp-row">
				<input
					className="wp-input wp-grow"
					value={name}
					placeholder={data.context ? `Park as “${data.context.name}”` : 'Park these tabs as…'}
					onChange={(e) => setName(e.target.value)}
					onKeyDown={(e) => e.key === 'Enter' && park()}
				/>
				<button className="wp-btn wp-btn-sm" disabled={busy} onClick={park} title="Keep these tabs under a name and take them off the screen">
					<Icon name="archive" size={13} /> Park
				</button>
			</div>

			{!!groups?.length && (
				<div className="wp-row-wrap wp-small">
					<span className="wp-muted">Parked:</span>
					{groups.slice(0, 6).map((g) => (
						<button
							key={g.id}
							className="wp-action"
							disabled={busy}
							title={`Reopen ${g.count} tabs — what is on the desk now is parked first`}
							onClick={() => run(async () => void (await call('resumeDesk', g.id, data.context?.name ?? 'Parked'), await reloadGroups()))}
						>
							{g.name} <span className="wp-muted">· {g.count}</span>
						</button>
					))}
				</div>
			)}
			{error && <span className="wp-error wp-small">{error}</span>}
		</section>
	)
}

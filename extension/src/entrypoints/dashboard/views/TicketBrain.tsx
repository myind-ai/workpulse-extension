// What Claude Code (or any other device) recorded about this ticket, on the
// ticket: what was asked, what was done, the root cause, the mistakes. The
// entries live in the bridge; this only shows the ones whose key matches the
// ticket's name, and links to the Brain for the rest.
//
// Checked before writing: TicketLearnings (local learnings, saved here — a
// different store, kept separate so a backup never mixes in the CLI's files)
// and BrainView's EntryCard, which this reuses to draw each entry.

import { useMemo } from 'react'

import { filter } from '@/core/bridge'
import { enabled } from '@/core/features'
import { ticketKey } from '@/core/links'
import { call } from '@/lib/rpc'
import { useLive } from '@/ui/hooks'

import { EntryCard } from './BrainView'

export function TicketBrain({ name }: { name: string }) {
	const key = ticketKey(name)
	const on = enabled('BRAIN') && enabled('BRIDGE_SYNC') && !!key
	const { data } = useLive(() => (on ? call('bridge') : Promise.resolve(null)), [on])
	const entries = useMemo(() => (data && key ? filter(data.entries, { ticket: key }) : []), [data, key])
	if (!on || !data?.ready) return null

	const open = (k: string) => (location.hash = `#/brain/${k}`)
	return (
		<section className="wp-card wp-stack-sm">
			<div className="wp-between">
				<span className="wp-eyebrow">From Claude Code and the Brain</span>
				<a className="wp-link wp-small" href={`#/brain/${key}`}>
					Open {key} in the Brain →
				</a>
			</div>
			{!entries.length ? (
				<span className="wp-muted wp-small">
					Nothing recorded for {key} yet. The <code>workpulse-brain</code> skill writes what was asked, done and learned at the end of a session.
				</span>
			) : (
				entries.slice(0, 8).map((e) => <EntryCard key={e.id} e={e} onTicket={open} onProject={() => (location.hash = '#/brain')} />)
			)}
		</section>
	)
}

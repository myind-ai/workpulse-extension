// Six months, written up — beside the evidence it was written from.
//
// The draft is never shown alone. A self-assessment is a document somebody
// hands to the person who decides their salary, and a claim in it that they
// cannot stand behind is worse for them than having written nothing. So the
// numbered sources sit next to the text, every sentence carries the number it
// came from, and anything the model reached for is called out rather than
// quietly left in.
//
// Nothing is saved. It is copied out by hand, having been read.

import { useState } from 'react'

import { call } from '@/lib/rpc'
import { Icon } from '@/ui/Icon'
import { copyText, useAction, useLive } from '@/ui/hooks'

interface Evidence {
	n: number
	label: string
	hours: number
	days: number
	from: string
	to: string
	said: string[]
}

export function Assess({ from, to }: { from: string; to: string }) {
	const { data: evidence } = useLive(() => call('assessEvidence', from, to), [from, to])
	const { data: growth } = useLive(() => call('scopeSince', from, to), [from, to])
	const [draft, setDraft] = useState<{ text: string; uncited: string[]; bogus: number[]; ok: boolean } | null>(null)
	const [open, setOpen] = useState(false)
	const { busy, error, run } = useAction()

	if (!evidence?.length) return null

	return (
		<section className="wp-card wp-stack-sm">
			<div className="wp-between">
				<div>
					<span className="wp-eyebrow">The review you will be asked for</span>
					<h2 className="wp-h2">{evidence.length} strands of work, {Math.round(evidence.reduce((a, e) => a + e.hours, 0))} hours</h2>
				</div>
				<button className="wp-action" onClick={() => setOpen(!open)}>
					{open ? 'Hide the evidence' : 'See the evidence'}
				</button>
			</div>

			{/* Shown first and on its own: somebody should be able to decide the
			    evidence is right before a word is generated from it. */}
			{open && (
				<div className="wp-stack-sm wp-small">
					{evidence.map((e: Evidence) => (
						<div key={e.n} className="wp-card-flat">
							<div className="wp-between">
								<b>
									[{e.n}] {e.label}
								</b>
								<span className="wp-muted wp-num">
									{e.hours}h · {e.days} days
								</span>
							</div>
							<div className="wp-faint">
								{e.from} to {e.to}
							</div>
							<ul style={{ margin: '6px 0 0', paddingLeft: 16 }}>
								{e.said.slice(0, 4).map((x, i) => (
									<li key={i} className="wp-muted">
										{x}
									</li>
								))}
							</ul>
						</div>
					))}
				</div>
			)}

			{/* Facts, never spun. What is new, and what has gone. */}
			{growth?.line && (
				<p className="wp-small" style={{ margin: 0 }}>
					{growth.line}
					{!!growth.left.length && <span className="wp-muted"> You are no longer on: {growth.left.slice(0, 3).join(', ')}.</span>}
				</p>
			)}

			<div className="wp-row">
				<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => run(async () => setDraft(await call('assessDraft', from, to)))}>
					<Icon name="pencil" size={13} /> {draft ? 'Draft again' : 'Draft it'}
				</button>
				<span className="wp-muted wp-small">Your own model. Every claim must cite the evidence above.</span>
			</div>

			{draft && (
				<>
					{/* The point of the whole feature. A sentence with nothing behind
					    it is the one that ends somebody's credibility in a meeting. */}
					{!draft.ok && (
						<div className="wp-banner wp-small">
							<span className="wp-grow">
								{!!draft.uncited.length && (
									<>
										<b className="wp-warn-text">{draft.uncited.length} sentence{draft.uncited.length === 1 ? '' : 's'} cite nothing.</b> Check them before you use this —
										they are the model reaching, not your record.
									</>
								)}
								{!!draft.bogus.length && <> It also cited {draft.bogus.map((n) => `[${n}]`).join(', ')}, which does not exist.</>}
							</span>
						</div>
					)}
					{draft.ok && (
						<span className="wp-ok-text wp-small wp-row">
							<Icon name="check" size={13} /> Every claim points at evidence above. It still cannot tell whether it read it correctly — that part is yours.
						</span>
					)}

					{!!draft.uncited.length && (
						<ul className="wp-small wp-warn-text" style={{ margin: 0, paddingLeft: 18 }}>
							{draft.uncited.slice(0, 5).map((u, i) => (
								<li key={i}>{u}</li>
							))}
						</ul>
					)}

					<textarea className="wp-input" rows={14} value={draft.text} onChange={(e) => setDraft({ ...draft, ...{ text: e.target.value } })} />
					<div className="wp-row">
						<button className="wp-action" onClick={() => void copyText(draft.text)}>
							<Icon name="copy" size={12} /> Copy it
						</button>
						<span className="wp-faint wp-small">Nothing here is saved. Copy what you are willing to stand behind.</span>
					</div>
				</>
			)}
			{error && <span className="wp-error wp-small">{error}</span>}
		</section>
	)
}

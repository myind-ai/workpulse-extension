// Eyes, legs, water, posture. All of it off by default and all of it switchable
// one at a time — a health feature that interrupts an incident or a client call
// is the reason extensions get removed, so nothing here is on until you say so.

import type { Settings } from '@/core/types'
import { istDate, prettyDate } from '@/core/time'
import { call } from '@/lib/rpc'
import { useAction, useLive } from '@/ui/hooks'
import { Panel } from '@/ui/Panel'
import { Art } from '@/ui/Art'

type Patch = (patch: Partial<Settings>) => Promise<void>

export function Health({ settings, onPatch }: { settings: Settings; onPatch: Patch }) {
	const { data: water, reload } = useLive(() => call('water'))
	const { data: notes, reload: reloadNotes } = useLive(() => call('healthNotes'))
	const { busy, run } = useAction()

	const on = [settings.eyeEvery && 'eyes', settings.moveEvery && 'standing', settings.waterTarget && 'water', settings.posture && 'posture', settings.breatheEvery && 'breathing'].filter(Boolean)

	return (
		<Panel
			title="Breaks, water, posture and breathing"
			hint={on.length ? `On: ${on.join(', ')}` : 'All off'}
			keywords="health break eye 20-20-20 water drink walk stand posture breathe breathing calm rest screen strain hydration notes"
			right={water && water.target ? <span className="wp-chip">{water.had} / {water.target}</span> : undefined}
		>
			<Art name="breathe" size={88} />
			<p className="wp-muted wp-small" style={{ margin: 0 }}>
				One card at a time, never during a focus session or a meeting, and never when you have been away from the keyboard — a reminder to look away is for someone who is looking.
				Every one of them can be skipped in a click.
			</p>

			<label className="wp-row">
				<span style={{ width: 140 }}>Look away</span>
				<select className="wp-select wp-sm" style={{ width: 150 }} value={settings.eyeEvery} disabled={busy} onChange={(e) => run(() => onPatch({ eyeEvery: Number(e.target.value) }))}>
					<option value={0}>never</option>
					<option value={20}>every 20 min</option>
					<option value={30}>every 30 min</option>
					<option value={45}>every 45 min</option>
				</select>
				<span className="wp-muted wp-small">20 seconds at something far away — the 20-20-20 rule</span>
			</label>

			<label className="wp-row">
				<span style={{ width: 140 }}>Stand up</span>
				<select className="wp-select wp-sm" style={{ width: 150 }} value={settings.moveEvery} disabled={busy} onChange={(e) => run(() => onPatch({ moveEvery: Number(e.target.value) }))}>
					<option value={0}>never</option>
					<option value={50}>every 50 min</option>
					<option value={60}>every hour</option>
					<option value={90}>every 90 min</option>
				</select>
				<span className="wp-muted wp-small">two minutes away, counted down on the card</span>
			</label>

			<label className="wp-row">
				<span style={{ width: 140 }}>Water</span>
				<select className="wp-select wp-sm" style={{ width: 150 }} value={settings.waterTarget} disabled={busy} onChange={(e) => run(() => onPatch({ waterTarget: Number(e.target.value) }))}>
					<option value={0}>no target</option>
					{[4, 6, 8, 10, 12].map((n) => (
						<option key={n} value={n}>
							{n} glasses a day
						</option>
					))}
				</select>
				{!!settings.waterTarget && (
					<>
						<span className="wp-muted wp-small">asking every</span>
						<select className="wp-select wp-sm" style={{ width: 90 }} value={settings.waterEvery} disabled={busy} onChange={(e) => run(() => onPatch({ waterEvery: Number(e.target.value) }))}>
							{[30, 45, 60, 90].map((n) => (
								<option key={n} value={n}>
									{n} min
								</option>
							))}
						</select>
					</>
				)}
			</label>

			<label className="wp-row">
				<span style={{ width: 140 }}>Posture</span>
				<input type="checkbox" checked={settings.posture} disabled={busy} onChange={(e) => run(() => onPatch({ posture: e.target.checked }))} />
				<span className="wp-muted wp-small">"shoulders down, jaw unclenched", about every 90 minutes</span>
			</label>

			<label className="wp-row">
				<span style={{ width: 140 }}>Breathe</span>
				<select className="wp-select wp-sm" style={{ width: 150 }} value={settings.breatheEvery} disabled={busy} onChange={(e) => run(() => onPatch({ breatheEvery: Number(e.target.value) }))}>
					<option value={0}>never</option>
					<option value={60}>every hour</option>
					<option value={90}>every 90 min</option>
					<option value={120}>every 2 hours</option>
				</select>
				<span className="wp-muted wp-small">a minute of slow breathing, counted down, with Tick</span>
			</label>

			<label className="wp-row">
				<span style={{ width: 140 }}>Suggest a break after</span>
				<select
					className="wp-select wp-sm"
					style={{ width: 150 }}
					value={settings.breakAfterHours}
					disabled={busy}
					onChange={(e) => run(() => onPatch({ breakAfterHours: Number(e.target.value) }))}
				>
					<option value={0}>never</option>
					{[2, 3, 4].map((n) => (
						<option key={n} value={n}>
							{n} hours
						</option>
					))}
				</select>
				<span className="wp-muted wp-small">a longer one, once per stretch</span>
			</label>

			{/* Everything written at a break, kept here rather than lost with the
			    card it was written on. */}
			{!!notes?.length && (
				<div className="wp-stack-sm wp-small" style={{ paddingTop: 8, borderTop: '1px solid var(--wp-border)' }}>
					<span className="wp-eyebrow">Your notes from breaks</span>
					{notes.slice(0, 8).map((n) => (
						<div key={n.id} className="wp-between">
							<span style={{ minWidth: 0 }}>
								{n.text}
								<span className="wp-muted"> · {prettyDate(istDate(n.at))}</span>
								{n.showNext && n.shownAt == null && <span className="wp-chip" style={{ marginLeft: 6 }}>next break</span>}
							</span>
							<button className="wp-icon-btn" disabled={busy} title="Delete this note" aria-label="Delete this note" onClick={() => run(async () => void (await call('deleteHealthNote', n.id), await reloadNotes()))}>
								✕
							</button>
						</div>
					))}
					{notes.length > 8 && <span className="wp-muted">and {notes.length - 8} more</span>}
				</div>
			)}

			{/* Counting a glass here as well as on the card: you do not drink water
			    only when something asks you to. */}
			{!!settings.waterTarget && (
				<div className="wp-row">
					<span style={{ width: 140 }} className="wp-muted wp-small">
						Today
					</span>
					<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => run(async () => void (await call('logWater', 1), await reload()))}>
						+ Had a glass
					</button>
					<button className="wp-btn wp-btn-sm wp-btn-ghost" disabled={busy || !water?.had} onClick={() => run(async () => void (await call('logWater', -1), await reload()))}>
						−
					</button>
					<span className="wp-muted wp-small">
						{water?.had ?? 0} of {settings.waterTarget}
					</span>
				</div>
			)}
		</Panel>
	)
}

// A goal bigger than a day: one sentence, and what the period actually amounted
// to underneath it. The numbers are counted, never estimated — there is no
// percentage here, because a percentage of a sentence is a made-up number.

import { useState } from 'react'

import type { GoalScope } from '@/core/goals'
import { fmtMinutes } from '@/core/time'
import { call } from '@/lib/rpc'
import { useAction, useLive } from '@/ui/hooks'
import { Panel } from '@/ui/Panel'

const VERDICTS = [
	{ id: 'done', label: 'Done' },
	{ id: 'partly', label: 'Partly' },
	{ id: 'missed', label: 'Missed' },
] as const

export function Goals() {
	return (
		<Panel title="Goals" hint="One sentence for the week, one for the month" keywords="goal week month sprint outcome progress verdict">
			<OneGoal scope="week" />
			<OneGoal scope="month" />
		</Panel>
	)
}

function OneGoal({ scope }: { scope: GoalScope }) {
	const { data, reload } = useLive(() => call('goal', scope))
	const [text, setText] = useState<string | null>(null)
	const { busy, error, run } = useAction()

	if (!data) return null
	const { progress: p, goal } = data
	const editing = text != null

	const save = () =>
		run(async () => {
			await call('saveGoal', scope, text ?? '')
			setText(null)
			await reload()
		})

	return (
		<div className="wp-card-flat wp-stack-sm">
			<div className="wp-between wp-small">
				<span className="wp-eyebrow">{data.title}</span>
				<span className="wp-muted">
					{p.worked} of {p.elapsed} work day{p.elapsed === 1 ? '' : 's'} · {fmtMinutes(p.minutes)}
					{p.pending ? ` · ${p.pending} unpushed` : ''}
				</span>
			</div>

			{editing ? (
				<div className="wp-row">
					<input
						className="wp-input wp-grow"
						autoFocus
						placeholder={scope === 'week' ? 'Ship the retry fix and finish the Client A integration' : 'The outcome this month is for'}
						value={text}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') void save()
							if (e.key === 'Escape') setText(null)
						}}
					/>
					<button className="wp-btn wp-btn-sm wp-btn-primary" disabled={busy} onClick={save}>
						Save
					</button>
				</div>
			) : (
				<button className={goal ? 'wp-action' : 'wp-action wp-muted'} style={{ textAlign: 'left' }} onClick={() => setText(goal?.text ?? '')}>
					{goal?.text ? <strong>{goal.text}</strong> : `+ Set a goal for ${scope === 'week' ? 'this week' : 'this month'}`}
				</button>
			)}

			{/* What the time went on, which is the only honest progress bar. */}
			{!!p.things.length && (
				<div className="wp-row-wrap wp-small">
					{p.things.slice(0, 5).map((t) => (
						<span key={t.label} className="wp-chip">
							{t.label} <span className="wp-muted">{fmtMinutes(t.minutes)}</span>
						</span>
					))}
				</div>
			)}

			{!!goal && (
				<div className="wp-row wp-small">
					<span className="wp-muted">How did it go?</span>
					{VERDICTS.map((v) => (
						<button
							key={v.id}
							className={goal.verdict === v.id ? 'wp-btn wp-btn-sm wp-btn-soft' : 'wp-btn wp-btn-sm'}
							disabled={busy}
							aria-pressed={goal.verdict === v.id}
							onClick={() => run(async () => void (await call('judgeGoal', data.key, v.id), await reload()))}
						>
							{v.label}
						</button>
					))}
				</div>
			)}
			{error && <div className="wp-error wp-small">{error}</div>}
		</div>
	)
}

/** The ten-minute cleanup, and how scattered the day was. */
export function DayShape() {
	const { data, reload } = useLive(() => call('dayShape'))
	const { busy, run } = useAction()
	if (!data) return null
	if (!data.quick.length && !data.switches.things && !data.planned.length) return null

	return (
		<Panel
			title="The shape of today"
			hint={data.quick.length ? `${data.quick.length} small thing${data.quick.length === 1 ? '' : 's'} · about ${data.cleanup} min` : data.note}
			keywords="context switch focus quick small task cleanup planned actual estimate"
		>
			<div className="wp-small wp-muted">{data.note}</div>

			{!!data.quick.length && (
				<div className="wp-stack-sm wp-small">
					<span className="wp-eyebrow">Clear in {data.cleanup} minutes</span>
					{data.quick.map((t) => (
						<div key={t.uid} className="wp-between">
							<span>
								{t.key && <span className="wp-muted">{t.key} · </span>}
								{t.title}
								{t.estimateMinutes ? <span className="wp-muted"> · {t.estimateMinutes}m</span> : null}
							</span>
							<button className="wp-btn wp-btn-sm wp-btn-soft" disabled={busy} onClick={() => run(async () => void (await call('answerTask', t.uid, 'done'), await reload()))}>
								Done
							</button>
						</div>
					))}
					<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => run(() => call('startFocus', Math.max(10, data.cleanup)))}>
						Start a {Math.max(10, data.cleanup)}-minute cleanup block
					</button>
				</div>
			)}

			{!!data.planned.length && (
				<div className="wp-stack-sm wp-small">
					<span className="wp-eyebrow">Planned against actual</span>
					{data.planned.slice(0, 5).map((p) => (
						<div key={p.title} className="wp-between">
							<span style={{ minWidth: 0 }}>{p.title}</span>
							<span className="wp-num wp-muted">
								{fmtMinutes(p.planned)} → <strong className={p.actual > p.planned * 1.5 ? 'wp-warn-text' : undefined}>{fmtMinutes(p.actual)}</strong>
							</span>
						</div>
					))}
				</div>
			)}
		</Panel>
	)
}

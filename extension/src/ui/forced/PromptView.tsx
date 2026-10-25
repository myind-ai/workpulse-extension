import { useEffect, useMemo, useRef, useState } from 'react'

import type { PromptContext } from '@/background/commands'
import { fmtMinutes } from '@/core/time'
import { call } from '@/lib/rpc'
import { Art } from '@/ui/Art'
import { Brand } from '@/ui/Brand'
import { DayBar } from '@/ui/DayBar'
import { useAction } from '@/ui/hooks'

const MIN_TEXT = 10

/** The same colours the Tasks page uses, so a task looks the same everywhere. */
const PRIORITY_COLOUR = { high: 'var(--wp-danger)', normal: 'var(--wp-accent)', low: 'var(--wp-border)' } as const

export function PromptView({ ctx, blocking }: { ctx: PromptContext; blocking: boolean }) {
	// Filled before it is seen. An empty box is where this product dies:
	// somebody who cannot remember skips the card, and skipping once is how
	// every tool anybody has tried quietly stopped being used.
	const [text, setText] = useState(ctx.guess ?? '')
	const [sharpened, setSharpened] = useState(false)
	const [jobId, setJobId] = useState(ctx.defaultJobId)
	const [taskUid, setTaskUid] = useState(ctx.timer?.task.uid ?? '')
	const [minutes, setMinutes] = useState(ctx.minutes)
	const [adding, setAdding] = useState(false)
	const [newTask, setNewTask] = useState('')
	const [tasks, setTasks] = useState(ctx.tasks)
	const { busy, error, run } = useAction()
	const area = useRef<HTMLTextAreaElement>(null)
	const [recall, setRecall] = useState<{ groups: { label: string; minutes: number; titles: string[]; ticket: boolean }[]; draft: string } | null>(null)

	useEffect(() => {
		area.current?.focus()
	}, [])

	// What the browser remembers about this hour, when you have allowed it. A
	// prompt for your own sentence, never an answer written on your behalf.
	useEffect(() => {
		let live = true
		void call('slotActivity', ctx.slotStart, ctx.slotEnd)
			.then((r) => live && r.groups.length && setRecall(r))
			.catch(() => undefined)
		return () => {
			live = false
		}
	}, [ctx.slotStart, ctx.slotEnd])

	const jobName = useMemo(() => new Map(ctx.jobs.map((j) => [j.id, j.name])), [ctx.jobs])

	/** "PAY-3017 · title" splits into a key and a title, the way you would type it. */
	const addTask = () =>
		run(async () => {
			const raw = newTask.trim()
			if (!raw) return
			const m = raw.match(/^([A-Z][A-Z0-9]+-\d+)\s*[·:\-]?\s*(.*)$/)
			const task = await call('createTask', { title: (m?.[2] || raw).trim() || raw, key: m?.[1], jobId: jobId || undefined })
			setTasks([task, ...tasks])
			setTaskUid(task.uid)
			if (!text.trim()) setText(raw)
			setNewTask('')
			setAdding(false)
		})
	const ready = text.trim().length >= MIN_TEXT && (!ctx.jobs.length || !!jobId)

	const pickTask = (uid: string) => {
		setTaskUid(uid)
		const t = tasks.find((x) => x.uid === uid)
		if (t?.jobId) setJobId(t.jobId)
		if (t && !text.trim()) setText(t.key ? `${t.key}: ${t.title}` : t.title)
	}

	/**
	 * The answers that are probably it, one tap each: what you said last time,
	 * whatever the timer is running, and the open work that carries a key.
	 */
	const quick = [
		// What the block you have just finished was for, first: you wrote that
		// line twenty-five minutes ago and it is almost always the answer.
		...(ctx.focusIntent ? [ctx.focusIntent] : []),
		...(ctx.lastText ? [ctx.lastText] : []),
		...(ctx.timer ? [ctx.timer.task.key ? `${ctx.timer.task.key}: ${ctx.timer.task.title}` : ctx.timer.task.title] : []),
		...tasks.filter((t) => t.key).slice(0, 2).map((t) => `${t.key}: ${t.title}`),
	]
		.map((q) => q.trim())
		.filter((q, i, all) => q && all.indexOf(q) === i)
		.slice(0, 3)

	/** A sharper line, only on a press — never while the card is loading. */
	const sharpen = async () => {
		const line = await call('sharpenGuess', ctx.slotStart, ctx.slotEnd)
		setSharpened(true)
		pick(line)
	}

	/** Fill it in and put the caret at the end, so it can be edited or just sent. */
	const pick = (q: string) => {
		setText(q)
		const el = area.current
		if (el) {
			el.focus()
			requestAnimationFrame(() => el.setSelectionRange(q.length, q.length))
		}
	}

	/**
	 * Logging the last hour and finishing the day are one action at the end of
	 * it. `out: 'punch'` goes through the normal check-out — which punches Zoho
	 * where WorkPulse is allowed to, and opens Zoho where it is not. `out: 'done'`
	 * is for when you have already punched somewhere else: it records it here, and
	 * nothing asks again.
	 */
	const save = (out?: 'punch' | 'done') =>
		run(async () => {
			await call('saveEntry', { slotStart: ctx.slotStart, slotEnd: ctx.slotEnd, text, jobId: jobId || undefined, taskUid: taskUid || undefined, minutes })
			if (out === 'punch') await call('checkOut')
			if (out === 'done') await call('confirmAttendance', 'out')
		})

	return (
		<form
			className="wp-stack"
			onSubmit={(e) => {
				e.preventDefault()
				if (ready) void save()
			}}
			onKeyDown={(e) => {
				if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && ready) {
					e.preventDefault()
					void save()
				}
				e.stopPropagation() // keep page shortcuts from firing underneath
			}}
		>
			<div className="wp-between">
				<Brand />
				<span className="wp-row">
					{ctx.snoozes > 0 && <span className="wp-chip wp-chip-warn">Snoozed {ctx.snoozes}× today</span>}
					<span className="wp-eyebrow">{ctx.manual ? 'Log now' : 'Hourly check-in'}</span>
				</span>
			</div>
			<Art name="log" size={88} />

			<div>
				<div className="wp-slot">{ctx.label}</div>
				<div className="wp-muted">{fmtMinutes(ctx.totalMinutes)} since your last entry</div>
			</div>

			{/* The day, so answering this visibly moves something. A habit needs a
			    reward you can see, and "the bar went up" is the whole reward. */}
			<DayBar logged={ctx.loggedToday ?? 0} target={ctx.targetToday ?? 0} elapsed={ctx.elapsedToday} compact />

			{ctx.awayNote && (
				<div className="wp-banner">
					<span className="wp-grow">{ctx.awayNote} — was that a break?</span>
					<button type="button" className="wp-btn wp-btn-sm" disabled={busy} onClick={() => run(() => call('takeBreak', ctx.slotStart, ctx.slotEnd))}>
						Lunch / break
					</button>
				</div>
			)}

			{ctx.timer && (
				<div className="wp-card-flat wp-between">
					<span>
						<span className="wp-chip wp-chip-accent">
							<span className="wp-dot" /> Running
						</span>{' '}
						<strong>{ctx.timer.task.title}</strong> <span className="wp-muted">· {fmtMinutes(ctx.timer.minutesInSlot)} in this slot</span>
					</span>
				</div>
			)}

			<div>
				<label className="wp-label" htmlFor="wp-text">
					What did you work on?
				</label>
				<textarea
					id="wp-text"
					ref={area}
					className="wp-textarea"
					placeholder="e.g. Fixed the webhook retry bug in payment-service, reviewed PAY-231"
					value={text}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => {
						// Slack's rule, because everyone already knows it.
						if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
							e.preventDefault()
							if (ready) void save()
						}
					}}
				/>
				{/* Three seconds, not thirty: the likely answers are one tap each,
				    and Enter saves. Typing a sentence is the fallback, not the
				    requirement — an hourly question you have to compose is an
				    hourly question you start snoozing. */}
				<div className="wp-row-wrap wp-small" style={{ marginTop: 6 }}>
					{quick.map((q) => (
						<button type="button" key={q} className="wp-chip wp-chip-accent" style={{ cursor: 'pointer', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }} onClick={() => pick(q)}>
							{q}
						</button>
					))}
				</div>
				{/* Why the box already says what it says. A suggestion somebody
				    cannot audit is a suggestion they will accept wrongly: "still
				    on LEAP-19" is checkable at a glance, a sentence from nowhere
				    is not. */}
				{!!ctx.guessWhy && !sharpened && text.trim() === (ctx.guess ?? '').trim() && (
					<div className="wp-row wp-small" style={{ marginTop: 4 }}>
						<span className="wp-faint">Filled in — {ctx.guessWhy}</span>
						{ctx.canSharpen && (
							<button type="button" className="wp-action wp-muted" onClick={() => void sharpen().catch(() => undefined)} title="Ask your own model for a sharper line">
								sharpen
							</button>
						)}
					</div>
				)}

				<div className="wp-between wp-small">
					<span className="wp-muted">
						Enter saves · Shift+Enter for a new line
						{/* Counts what was captured, never what was missed. A streak
						    that reports failures is a guilt trip attached to a thing
						    you do every hour. */}
						{ctx.captured && <span className="wp-ok-text"> · {ctx.captured}</span>}
					</span>
					<span className={text.trim().length >= MIN_TEXT ? 'wp-muted' : 'wp-warn-text'}>
						{text.trim().length}/{MIN_TEXT} characters
					</span>
				</div>
			</div>

			<div className="wp-grid-3">
				<div style={{ gridColumn: 'span 2' }}>
					<label className="wp-label" htmlFor="wp-job">
						Zoho job
					</label>
					{ctx.jobs.length ? (
						<select id="wp-job" className="wp-select" value={jobId} onChange={(e) => setJobId(e.target.value)}>
							<option value="">Pick a job…</option>
							{ctx.jobs.map((j) => (
								<option key={j.id} value={j.id}>
									{j.name}
									{j.project ? ` · ${j.project}` : ''}
								</option>
							))}
						</select>
					) : (
						<div className="wp-input wp-muted wp-small" style={{ display: 'flex', alignItems: 'center' }}>
							No jobs yet — connect Zoho in Settings
						</div>
					)}
				</div>
			</div>

			{/* The whole slot, unless you say otherwise — which is true nearly
			    every time, so saying otherwise is one click rather than a field
			    standing open on every card. */}
			<details className="wp-fold">
				<summary className="wp-fold-head">
					{fmtMinutes(minutes)}
					{minutes !== ctx.totalMinutes && <span className="wp-muted"> of {fmtMinutes(ctx.totalMinutes)}</span>}
					{taskUid && <span className="wp-muted"> · {tasks.find((t) => t.uid === taskUid)?.title.slice(0, 28)}</span>}
					<span className="wp-muted"> · change</span>
				</summary>
				<div className="wp-fold-body wp-stack-sm">
					<div className="wp-row-wrap wp-small">
						{/* Hours, the way anyone says them — not a number to type. */}
						{[15, 30, 45, 60, 90, 120].filter((m) => m <= Math.max(ctx.totalMinutes, 15)).map((m) => (
							<button type="button" key={m} className={minutes === m ? 'wp-chip wp-chip-accent' : 'wp-chip'} style={{ cursor: 'pointer' }} onClick={() => setMinutes(m)}>
								{fmtMinutes(m)}
							</button>
						))}
						<button type="button" className={minutes === ctx.totalMinutes ? 'wp-chip wp-chip-accent' : 'wp-chip'} style={{ cursor: 'pointer' }} onClick={() => setMinutes(ctx.totalMinutes)}>
							the whole {fmtMinutes(ctx.totalMinutes)}
						</button>
						<label className="wp-row wp-small">
							<span className="wp-muted">or</span>
							<input
								id="wp-min"
								className="wp-input wp-num wp-sm"
								style={{ width: 72 }}
								type="number"
								min={0}
								max={Math.max(ctx.totalMinutes, 1)}
								value={minutes}
								onChange={(e) => setMinutes(Number(e.target.value))}
								aria-label="Minutes worked"
							/>
							<span className="wp-muted">min</span>
						</label>
					</div>

				<div>
					<label className="wp-label" htmlFor="wp-task">
						Task (optional)
					</label>
				{adding ? (
					// Adding the task here, while it is in your head, beats remembering
					// to add it on the Tasks page later.
					<div className="wp-row">
						<input
							className="wp-input wp-grow"
							autoFocus
							placeholder="PAY-3017 · what you are starting"
							value={newTask}
							onChange={(e) => setNewTask(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter') void addTask()
								if (e.key === 'Escape') setAdding(false)
							}}
						/>
						<button type="button" className="wp-btn wp-btn-sm wp-btn-primary" disabled={!newTask.trim()} onClick={() => void addTask()}>
							Add
						</button>
						<button type="button" className="wp-btn wp-btn-sm wp-btn-ghost" onClick={() => setAdding(false)}>
							Cancel
						</button>
					</div>
				) : (
					<div className="wp-stack-sm">
						{/* A list you can see, not a dropdown you have to open: picking the
						    thing you were on is the step people skip. */}
						{tasks.length > 0 && (
							<div className="wp-stack-sm wp-small wp-scroll-sm">
								{tasks.map((t) => (
									<button
										key={t.uid}
										type="button"
										className={taskUid === t.uid ? 'wp-btn wp-btn-sm wp-btn-soft' : 'wp-btn wp-btn-sm'}
										style={{ justifyContent: 'flex-start', width: '100%' }}
										onClick={() => pickTask(taskUid === t.uid ? '' : t.uid)}
										aria-pressed={taskUid === t.uid}
									>
										<span className="wp-dot" style={{ background: PRIORITY_COLOUR[t.priority ?? 'normal'], marginRight: 8, flex: 'none' }} />
										<span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
											{t.key && <span className="wp-muted">{t.key} · </span>}
											{t.title}
											{t.jobId && jobName.get(t.jobId) ? <span className="wp-muted"> ({jobName.get(t.jobId)})</span> : null}
										</span>
									</button>
								))}
							</div>
						)}
						<div className="wp-row-wrap wp-small">
							<button type="button" className="wp-btn wp-btn-sm" onClick={() => setAdding(true)}>
								+ New task
							</button>
							{taskUid && (
								<button type="button" className="wp-action" onClick={() => setTaskUid('')}>
									no task
								</button>
							)}
							{!tasks.length && <span className="wp-muted">No tasks yet — add one if this hour belongs to something.</span>}
						</div>
					</div>
				)}
				</div>
				</div>
			</details>

			{error && <div className="wp-error">{error}</div>}

			<div className="wp-between">
				<div className="wp-row">
					{!ctx.awayNote && (
						<button type="button" className="wp-btn wp-btn-ghost" disabled={busy} onClick={() => run(() => call('takeBreak', ctx.slotStart, ctx.slotEnd))}>
							Lunch / break
						</button>
					)}
				</div>
				<div className="wp-row">
					{blocking ? (
						<button type="button" className="wp-btn wp-btn-ghost" disabled={busy} onClick={() => run(() => call('snooze'))}>
							Snooze 10 min
						</button>
					) : (
						<button type="button" className="wp-btn wp-btn-ghost" disabled={busy} onClick={() => run(() => call('dismiss'))}>
							Cancel
						</button>
					)}
					<button type="submit" className="wp-btn wp-btn-primary" disabled={!ready || busy}>
						Save <span className="wp-kbd" style={{ color: 'inherit', borderColor: 'rgba(255,255,255,.4)' }}>⌘↵</span>
					</button>
				</div>
			</div>
			<div className="wp-muted wp-small">Saved on this computer. Sent to Zoho only when you close the day.</div>
		</form>
	)
}

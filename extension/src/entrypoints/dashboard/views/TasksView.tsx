// Tasks with one running timer. Jira tasks arrive here later through the desktop app (MCP).

import { useState } from 'react'

import { addDays, atIst, fmtMinutes, isHHMM, istDate, istTime, prettyDate } from '@/core/time'
import type { Priority, Task } from '@/core/types'
import { call } from '@/lib/rpc'
import { byPriority } from '@/lib/tasks'
import { Fold } from '@/ui/Fold'
import { useAction, useLive, useNow } from '@/ui/hooks'
import { DateField, TimeField } from '@/ui/TimeField'
import { Art } from '@/ui/Art'

/** High reads as urgent, low as background; normal stays quiet. */
export const PRIORITY_COLOUR: Record<Priority, string> = { high: 'var(--wp-danger)', normal: 'var(--wp-accent)', low: 'var(--wp-border)' }

/** What each column means when it is empty — a blank card teaches nothing. */
const EMPTY: Record<string, string> = {
	doing: 'Nothing in progress. Start a timer on a to-do and it moves here.',
	todo: 'Nothing to do yet. Add one above, or save a link from the toolbar.',
	done: 'Finished work shows up here.',
}

const COLUMNS: { status: Task['status']; label: string }[] = [
	{ status: 'doing', label: 'Doing' },
	{ status: 'todo', label: 'To do' },
	{ status: 'done', label: 'Done' },
]

export function TasksView() {
	const { data } = useLive(() => call('tasks'))
	const { data: jobs } = useLive(() => call('jobs'))
	const [day, setDay] = useState<string | null>(null)
	const { data: history } = useLive(() => (day ? call('tasksOn', day) : Promise.resolve(null)), [day])
	const [form, setForm] = useState({ title: '', key: '', jobId: '', priority: 'normal' as Priority, remindAt: '' })
	const [adding, setAdding] = useState(false)
	const [find, setFind] = useState('')
	const { busy, error, run } = useAction()
	const now = useNow(15_000)
	if (!data) return <div className="wp-muted">Loading…</div>

	const jobName = new Map((jobs ?? []).map((j) => [j.id, j.name]))
	const running = data.timer?.task.uid
	const hit = (t: Task) => `${t.key ?? ''} ${t.title}`.toLowerCase().includes(find.trim().toLowerCase())
	// Reminders are their own thing: a time you asked to be interrupted at is not
	// the same as a thing to do, and mixing them is what made this page a wall.
	const reminders = data.tasks.filter((t) => t.kind !== 'note' && t.status !== 'done' && t.remindAt != null && hit(t)).sort((a, b) => (a.remindAt ?? 0) - (b.remindAt ?? 0))

	return (
		<div className="wp-stack" style={{ gap: 20 }}>
			<div className="wp-page-head">
				<div>
					<div className="wp-eyebrow">Time and tasks</div>
					<h1 className="wp-title">Tasks</h1>
				</div>
				{data.timer && (
					<div className="wp-row">
						<span className="wp-chip wp-chip-accent">
							<span className="wp-dot" /> {data.timer.task.title} · {fmtMinutes(Math.round((now - data.timer.startedAt) / 60_000))}
						</span>
						<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => run(() => call('stopTimer'))}>
							Stop
						</button>
					</div>
				)}
			</div>

			<div className="wp-between">
				<div className="wp-row">
					<button className={adding ? 'wp-btn wp-btn-sm wp-btn-soft' : 'wp-btn wp-btn-sm wp-btn-primary'} onClick={() => setAdding(!adding)}>
						{adding ? 'Close' : '+ Add a task'}
					</button>
				</div>
				<input className="wp-input" style={{ maxWidth: 240 }} placeholder="Find a task or a key…" value={find} onChange={(e) => setFind(e.target.value)} />
			</div>

			{adding && (
			<form
				className="wp-card wp-row-wrap"
				onSubmit={(e) => {
					e.preventDefault()
					void run(async () => {
						await call('createTask', {
							title: form.title,
							key: form.key,
							jobId: form.jobId,
							priority: form.priority,
							// A bare time means today: the reminder is for the day you set it.
							remindAt: isHHMM(form.remindAt) ? atIst(istDate(Date.now()), form.remindAt) : undefined,
						})
						setForm({ title: '', key: '', jobId: form.jobId, priority: 'normal', remindAt: '' })
					})
				}}
			>
				<input className="wp-input" style={{ width: 120 }} placeholder="Key (PAY-231)" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} />
				<input className="wp-input wp-grow" placeholder="What needs doing?" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
				{!!jobs?.length && (
					<select className="wp-select" style={{ width: 200 }} value={form.jobId} onChange={(e) => setForm({ ...form, jobId: e.target.value })}>
						<option value="">Zoho job…</option>
						{jobs.map((j) => (
							<option key={j.id} value={j.id}>
								{j.name}
							</option>
						))}
					</select>
				)}
				<select className="wp-select" style={{ width: 120 }} value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as Priority })} aria-label="Priority">
					<option value="high">High</option>
					<option value="normal">Normal</option>
					<option value="low">Low</option>
				</select>
				<TimeField label="Remind me at" value={form.remindAt} onChange={(v) => setForm({ ...form, remindAt: v })} width={110} />
				<button className="wp-btn wp-btn-primary" type="submit" disabled={busy || !form.title.trim()}>
					Add task
				</button>
			</form>
			)}
			{error && <div className="wp-error">{error}</div>}

			{day == null && !!reminders.length && (
				<section className="wp-card wp-stack-sm">
					<div className="wp-between">
						<h2 className="wp-h2">Reminders</h2>
						<span className="wp-muted wp-small">{reminders.length}</span>
					</div>
					{reminders.map((t) => (
						<div key={t.uid} className="wp-between wp-small">
							<span className="wp-grow" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
								<span className="wp-dot" style={{ background: PRIORITY_COLOUR[t.priority ?? 'normal'], marginRight: 6 }} />
								{t.key && <span className="wp-muted">{t.key} · </span>}
								{t.title}
								{t.repeatMinutes ? <span className="wp-muted"> · every {fmtMinutes(t.repeatMinutes)}</span> : null}
							</span>
							<span className="wp-row">
								<span className={t.remindAt != null && t.remindAt < now ? 'wp-warn-text wp-num' : 'wp-muted wp-num'}>{istTime(t.remindAt!)}</span>
								{/* `answerReminder(…, 'stop')` clears the time and any repeat.
								    A patch of `{ remindAt: undefined }` would not survive the
								    message passing — undefined keys are dropped in transit. */}
								<button className="wp-btn wp-btn-sm wp-btn-ghost" disabled={busy} title="Stop reminding me" onClick={() => run(() => call('answerReminder', t.uid, 'stop'))}>
									✕
								</button>
								<button className="wp-btn wp-btn-sm wp-btn-soft" disabled={busy} onClick={() => run(() => call('answerTask', t.uid, 'done'))}>
									Done
								</button>
							</span>
						</div>
					))}
				</section>
			)}

			{/* What happened on a given day, rather than only what is open now. */}
			<Fold title="A particular day" open={day != null}>
			<section className="wp-card wp-stack-sm">
				<div className="wp-row-wrap wp-small">
					<span className="wp-muted">Show:</span>
					<button className={day == null ? 'wp-btn wp-btn-sm wp-btn-soft' : 'wp-btn wp-btn-sm'} onClick={() => setDay(null)}>
						Everything open
					</button>
					<button className={day === istDate(Date.now()) ? 'wp-btn wp-btn-sm wp-btn-soft' : 'wp-btn wp-btn-sm'} onClick={() => setDay(istDate(Date.now()))}>
						Today
					</button>
					<button className={day === addDays(istDate(Date.now()), -1) ? 'wp-btn wp-btn-sm wp-btn-soft' : 'wp-btn wp-btn-sm'} onClick={() => setDay(addDays(istDate(Date.now()), -1))}>
						Yesterday
					</button>
					<DateField label="Pick a day" value={day ?? ''} onChange={(v) => setDay(v || null)} />
				</div>

				{day && history && (
					<div className="wp-stack-sm wp-small">
						<div className="wp-muted">
							{prettyDate(day)} · {history.done.length} finished · {history.open.length} still open · {history.notes.length} saved
						</div>
						{[
							{ label: 'Finished', list: history.done },
							{ label: 'Still open', list: history.open },
							{ label: 'Saved that day', list: history.notes },
						].map(({ label, list }) =>
							list.length ? (
								<div key={label} className="wp-stack-sm">
									<span className="wp-eyebrow">{label}</span>
									{list.map((t) => (
										<div key={t.uid} className="wp-between">
											<span className="wp-grow" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
												{t.key && <span className="wp-muted">{t.key} · </span>}
												{t.url ? (
													<a className="wp-link" href={t.url} target="_blank" rel="noreferrer">
														{t.title}
													</a>
												) : (
													t.title
												)}
											</span>
											<span className="wp-muted wp-num">
												{t.doneAt != null ? istTime(t.doneAt) : t.spentMinutes > 0 ? fmtMinutes(t.spentMinutes) : ''}
											</span>
										</div>
									))}
								</div>
							) : null,
						)}
						{!history.done.length && !history.open.length && !history.notes.length && <div className="wp-muted">Nothing on that day.</div>}
					</div>
				)}
			</section>
			</Fold>

			{day == null && !data.tasks.some((t) => t.kind !== 'note') && (
				<div className="wp-card wp-muted">
					<Art name="empty-tasks" size={96} />
					No tasks yet. Add one above, or start a timer from the popup.
				</div>
			)}
			{day == null &&
				COLUMNS.map(({ status, label }) => {
				const list = data.tasks.filter((t) => t.status === status && t.kind !== 'note' && hit(t)).sort(byPriority)
				if (!list.length && status === 'done') return null
				return (
					<section key={status} className="wp-card">
						<div className="wp-between" style={{ marginBottom: 6 }}>
							<h2 className="wp-h2">{label}</h2>
							<span className="wp-muted wp-small">{list.length}</span>
						</div>
						{list.length ? (
							<div className="wp-timeline wp-scroll">
								{list.map((t) => (
									<div key={t.uid} className="wp-tl-item" style={{ gridTemplateColumns: '110px minmax(0,1fr) auto' }}>
										<span className="wp-muted wp-num">{t.key ?? '—'}</span>
										<span>
											<span className="wp-dot" style={{ background: PRIORITY_COLOUR[t.priority ?? 'normal'], marginRight: 6 }} title={`${t.priority ?? 'normal'} priority`} />
										<strong style={{ fontWeight: 550, textDecoration: t.status === 'done' ? 'line-through' : undefined }}>{t.title}</strong>
										{t.remindAt != null && (
											<span className="wp-chip" style={{ marginLeft: 6 }}>
												{t.remindedAt != null && t.remindedAt >= t.remindAt ? 'reminded' : `reminds ${istTime(t.remindAt)}`}
											</span>
										)}
											<div className="wp-muted wp-small">
												{fmtMinutes(t.spentMinutes)} tracked{t.jobId ? ` · ${jobName.get(t.jobId) ?? t.jobId}` : ''}
											</div>
										</span>
										<span className="wp-row">
											{t.status !== 'done' &&
												(running === t.uid ? (
													<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => run(() => call('stopTimer'))}>
														Stop
													</button>
												) : (
													<button className="wp-btn wp-btn-sm wp-btn-soft" disabled={busy} onClick={() => run(() => call('startTimer', t.uid))}>
														Start
													</button>
												))}
											{t.status !== 'done' && (
												<button
													className={t.blocked ? 'wp-btn wp-btn-sm wp-btn-soft' : 'wp-btn wp-btn-sm wp-btn-ghost'}
													disabled={busy}
													title={t.blocked ? 'Not waiting on anyone any more' : 'Waiting on someone else — says so in the standup'}
													aria-pressed={!!t.blocked}
													onClick={() => run(() => call('updateTask', t.uid, { blocked: !t.blocked }))}
												>
													{t.blocked ? 'Blocked' : 'Block'}
												</button>
											)}
											{t.status !== 'done' ? (
												<button className="wp-btn wp-btn-sm wp-btn-ghost" disabled={busy} onClick={() => run(() => call('updateTask', t.uid, { status: 'done' }))}>
													Done
												</button>
											) : (
												<button className="wp-btn wp-btn-sm wp-btn-ghost" disabled={busy} onClick={() => run(() => call('updateTask', t.uid, { status: 'todo' }))}>
													Reopen
												</button>
											)}
											<button className="wp-btn wp-btn-sm wp-btn-ghost wp-btn-danger" aria-label="Delete task" disabled={busy} onClick={() => run(() => call('deleteTask', t.uid))}>
												✕
											</button>
										</span>
									</div>
								))}
							</div>
						) : (
							<div className="wp-muted wp-small">{EMPTY[status]}</div>
						)}
					</section>
				)
			})}
			<div className="wp-muted wp-small">Coming with the desktop app: import your assigned Jira issues as tasks through MCP.</div>
		</div>
	)
}

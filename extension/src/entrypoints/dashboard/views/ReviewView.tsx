// End-of-day review: check out, edit the rows grouped by job, then push to
// Zoho (Time-logs/Full mode) or Copy + Mark as done (Reminder mode).

import { useEffect, useState } from 'react'

import type { PushResult } from '@/background/review-commands'
import { minutesFromHHMM, rowsPerEntry, splitRows } from '@/core/rules'
import { addDays, fmtMinutes, hhmm, istDate, istTime, prettyDate } from '@/core/time'
import { fileName, SHEET_LABEL, timesheet, type SheetFormat } from '@/core/export'
import { ticketKey } from '@/core/links'
import { call } from '@/lib/rpc'
import { DraftRows } from '@/ui/DraftRows'
import { Timeline } from '@/ui/Timeline'
import { copyText, useAction, useLive } from '@/ui/hooks'
import { Icon, type IconName } from '@/ui/Icon'
import { PasteCall } from '@/ui/PasteCall'
import { Busy } from '@/ui/Busy'

import { Support } from './Support'
import { Art } from '@/ui/Art'

/**
 * A step marker: the icon says what the step is, and turns into a tick when it
 * is behind you — so the page shows where you are without counting headings.
 */
function Step({ icon, title, done }: { icon: IconName; title: string; done: boolean }) {
	return (
		<h2 className="wp-h2 wp-row" style={{ gap: 10 }}>
			<span
				style={{
					width: 26,
					height: 26,
					borderRadius: 999,
					display: 'inline-flex',
					alignItems: 'center',
					justifyContent: 'center',
					flex: 'none',
					background: done ? 'var(--wp-ok-soft)' : 'var(--wp-accent-soft)',
					color: done ? 'var(--wp-ok)' : 'var(--wp-accent)',
				}}
			>
				<Icon name={done ? 'check' : icon} size={14} />
			</span>
			{title}
		</h2>
	)
}

interface Row {
	jobId: string
	hours: string
	description: string
}

const STATUS = {
	pending: { label: 'Not logged yet', cls: 'wp-chip-warn' },
	pushed: { label: 'Logged', cls: 'wp-chip-ok' },
	failed: { label: 'Push failed', cls: 'wp-chip-danger' },
	skipped: { label: 'Day off in Zoho', cls: '' },
} as const

export function ReviewView({ date }: { date?: string }) {
	const { data: r, reload } = useLive(() => call('review', date), [date])
	const { data: s } = useLive(() => call('state'))
	const [rows, setRows] = useState<Row[]>([])
	const [result, setResult] = useState<PushResult | null>(null)
	const [copied, setCopied] = useState<number | 'all' | null>(null)
	const [manual, setManual] = useState({ from: '', to: '', text: '', jobId: '' })
	const { busy, error, run } = useAction()
	const { data: wiring, reload: reloadWiring } = useLive(() => call('wiring'))
	/** Which entries this push covers. Null until the day loads, then everything unsynced. */
	const [picked, setPicked] = useState<Set<string> | null>(null)
	/** How the day is cut into rows: one per job, or one per entry; and a cap. */
	const [perEntry, setPerEntry] = useState(false)
	const [maxHours, setMaxHours] = useState(0)

	const rowsKey = r ? `${r.date}|${r.rows.map((x) => `${x.jobId}:${x.minutes}`).join(',')}|${r.day.timelogStatus}` : ''
	useEffect(() => {
		if (r) setPicked(new Set(r.entries.filter((e) => e.kind === 'work' && !e.synced).map((e) => e.uid)))
		setResult(null)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [rowsKey])

	// The rows are whatever you ticked, grouped by job — regrouped as you tick.
	const pickedKey = picked ? [...picked].sort().join(',') : ''
	useEffect(() => {
		if (!r || picked == null) return
		const chosenEntries = r.entries.filter((e) => picked.has(e.uid))
		// The cut works from the entries, not from a grouped row: each row has to
		// carry the work that happened in it, not a copy of the whole day.
		const built = perEntry ? rowsPerEntry(chosenEntries, r.jobs) : splitRows(chosenEntries, r.jobs, maxHours * 60)
		setRows(built.map((x) => ({ jobId: x.jobId ?? '', hours: hhmm(x.minutes), description: x.description })))
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [pickedKey, rowsKey, perEntry, maxHours])

	if (!r || !s) return <div className="wp-muted">Loading…</div>

	const jobName = new Map(r.jobs.map((j) => [j.id, j.name]))
	const isToday = r.date === istDate(Date.now())
	const unsynced = r.entries.filter((e) => e.kind === 'work' && !e.synced)
	const chosen = r.entries.filter((e) => picked?.has(e.uid))
	const totalMinutes = rows.reduce((a, x) => a + (minutesFromHHMM(x.hours) ?? 0), 0)
	const total = hhmm(totalMinutes)
	const over = r.attendanceMinutes != null && totalMinutes > r.attendanceMinutes + 1
	const status = STATUS[r.day.timelogStatus]
	// "Done" means nothing is waiting, not that the day was once sent — an entry
	// made after a push must still be sendable.
	const done = r.day.timelogStatus === 'skipped' || !r.entries.some((e) => e.kind === 'work' && !e.synced)
	/**
	 * Tab-separated in Zoho's own column order — Project, Task, Work item,
	 * Billable, Description, Hours — so a paste lands in the grid instead of
	 * being retyped. Filling it in from memory at the deadline is where the
	 * detail gets lost.
	 */
	const line = (x: Row) => {
		const job = r.jobs.find((j) => j.id === x.jobId)
		const billable = s.settings.billingStatus === 'billable' ? 'Billable' : 'Non-Billable'
		return [job?.project ?? '', job?.name ?? (x.jobId || 'No job'), x.description, billable, '', x.hours].join('\t')
	}
	const setRow = (i: number, patch: Partial<Row>) => setRows((list) => list.map((x, j) => (j === i ? { ...x, ...patch } : x)))

	const copy = async (which: number | 'all') => {
		await copyText(which === 'all' ? rows.map(line).join('\n') : line(rows[which]))
		setCopied(which)
		setTimeout(() => setCopied(null), 1500)
	}

	const push = () =>
		run(async () => {
			const res = await call(
				'pushDay',
				r.date,
				rows.map((x) => ({ jobId: x.jobId || undefined, minutes: minutesFromHHMM(x.hours) ?? 0, description: x.description })),
				chosen.map((e) => e.uid),
			)
			setResult(res)
			if (res.done.length && res.status !== 'pushed') setRows((list) => list.filter((_, i) => !res.done.includes(i)))
			await reload()
		})

	return (
		<div className="wp-stack" style={{ gap: 20 }}>
			<div className="wp-page-head">
				<div>
					<div className="wp-row-wrap wp-small">
						<button className="wp-action" onClick={() => (location.hash = `#/review/${addDays(r.date, -1)}`)}>
							‹ {prettyDate(addDays(r.date, -1)).slice(0, 3)}
						</button>
						<span className="wp-eyebrow">{prettyDate(r.date)}</span>
						{r.date < istDate(Date.now()) && (
							<button className="wp-action" onClick={() => (location.hash = `#/review/${addDays(r.date, 1)}`)}>
								{prettyDate(addDays(r.date, 1)).slice(0, 3)} ›
							</button>
						)}
						{r.date !== istDate(Date.now()) && (
							<button className="wp-action" onClick={() => (location.hash = '#/review')}>
								Today
							</button>
						)}
					</div>
					<h1 className="wp-title">Review & timesheet</h1>
				</div>
				<div className="wp-row-wrap">
					{!isToday && (
						<a className="wp-btn wp-btn-sm" href="#/review">
							Today
						</a>
					)}
					{/* The day as logged, for a spreadsheet or an appraisal. Your own
					    record of the day, independent of whether Zoho took it. */}
					{/* Zoho is one timesheet; the rest of the world uses Clockify,
					    Harvest, Tempo or a spreadsheet — and the rows are the same. */}
					<select
						className="wp-select wp-sm"
						style={{ width: 170 }}
						value=""
						disabled={!rows.length}
						aria-label="Export these rows"
						onChange={(e) => {
							const format = e.target.value as SheetFormat
							e.target.value = ''
							if (!format) return
							const sheet = rows.map((row) => ({
								job: row.jobId ? (jobName.get(row.jobId) ?? row.jobId) : 'No job',
								minutes: minutesFromHHMM(row.hours) ?? 0,
								description: row.description,
								key: ticketKey(row.description) ?? undefined,
							}))
							const text = timesheet(sheet, format, r.date)
							if (format === 'markdown' || format === 'text') {
								void copyText(text).then(() => setCopied('all'))
								return
							}
							const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }))
							const a = document.createElement('a')
							a.href = url
							a.download = fileName(`timesheet-${format}`, 'csv', r.date)
							a.click()
							setTimeout(() => URL.revokeObjectURL(url), 10_000)
						}}
					>
						<option value="">Export for…</option>
						{(Object.keys(SHEET_LABEL) as SheetFormat[]).map((f) => (
							<option key={f} value={f}>
								{SHEET_LABEL[f]}
								{f === 'markdown' || f === 'text' ? ' (copy)' : ''}
							</option>
						))}
					</select>
					{r.pendingDays
						.filter((d) => d !== r.date)
						.map((d) => (
							<a key={d} className="wp-btn wp-btn-sm wp-btn-soft" href={`#/review/${d}`}>
								{prettyDate(d)} pending
							</a>
						))}
				</div>
			</div>

			<div className="wp-card wp-figures">
				<div className="wp-stat">
					<span className="wp-eyebrow">Attendance</span>
					<span className="wp-big">{r.attendanceMinutes != null ? fmtMinutes(r.attendanceMinutes) : '—'}</span>
					<span className="wp-muted wp-small">
						{r.day.checkedInAt != null ? `In ${istTime(r.day.checkedInAt)}${r.day.checkedOutAt != null ? ` · out ${istTime(r.day.checkedOutAt)}` : ''}` : 'No check-in recorded'}
					</span>
				</div>
				<div className="wp-stat">
					<span className="wp-eyebrow">Logged</span>
					<span className="wp-big">{fmtMinutes(r.loggedMinutes)}</span>
					<span className={`wp-small ${over ? 'wp-warn-text' : 'wp-muted'}`}>{over ? 'More than attendance — Zoho will refuse it' : `${total} in the rows below`}</span>
				</div>
				<div className="wp-stat">
					<span className="wp-eyebrow">Timesheet</span>
					<span>
						<span className={`wp-chip ${status.cls}`}>
							<span className="wp-dot" /> {status.label}
						</span>
					</span>
					<span className="wp-muted wp-small">{r.mode === 'reminder' ? 'Reminder mode: copy into Zoho, then mark done' : r.canPush ? 'Pushes one time log per row' : 'Connect Zoho to push'}</span>
				</div>

			</div>

			{/* What was logged is above; this is what was not. A list of entries
			    hides a gap, because a gap is an absence of rows and an absence of
			    rows looks like the end of the list. */}
			<Timeline date={r.date} />

			{/* One long row gets queried; two shorter ones do not. Your call. This
			    was a fourth cell in a three-column grid, which is why it stacked. */}
			<div className="wp-card wp-controls wp-small">
				<span className="wp-row">
					<span className="wp-muted">Rows</span>
					<div className="wp-seg" role="group" aria-label="How to split the rows">
						<button aria-pressed={!perEntry} disabled={done} onClick={() => setPerEntry(false)}>
							One per job
						</button>
						<button aria-pressed={perEntry} disabled={done} onClick={() => setPerEntry(true)}>
							One per entry
						</button>
					</div>
				</span>
				<span className="wp-row">
					<span className="wp-muted">No longer than</span>
					<select className="wp-select wp-sm" style={{ width: 120 }} value={maxHours} disabled={done} onChange={(e) => setMaxHours(Number(e.target.value))} aria-label="Longest row">
						<option value={0}>any length</option>
						<option value={1}>1 hour</option>
						<option value={2}>2 hours</option>
						<option value={3}>3 hours</option>
						<option value={4}>4 hours</option>
					</select>
				</span>
				<span className="wp-muted wp-controls-end">
					{rows.length} row{rows.length === 1 ? '' : 's'} · {total}
				</span>
			</div>

			{r.issue && (
				<div className="wp-card-flat wp-between">
					<span>
						<span className="wp-chip wp-chip-danger">Regularise</span> {r.issue.detail}
					</span>
					<button className="wp-btn wp-btn-sm" onClick={() => run(() => call('openZoho'))}>
						Open Zoho
					</button>
				</div>
			)}

			<section className="wp-card wp-stack">
				<div className="wp-between">
					<Step icon="clock" title="Check out" done={r.day.checkedOutAt != null} />
					{r.day.checkedOutAt != null && <span className="wp-chip wp-chip-ok">Checked out {istTime(r.day.checkedOutAt)}</span>}
				</div>
				{r.day.checkedOutAt == null && isToday && (
					<div className="wp-row-wrap">
						{s.awaiting === 'out' ? (
							<>
								<span className="wp-banner">Zoho People is open — click Check out there.</span>
								<button className="wp-btn wp-btn-primary" disabled={busy} onClick={() => run(() => call('confirmAttendance', 'out'))}>
									I've checked out
								</button>
							</>
						) : (
							<button className="wp-btn wp-btn-primary" disabled={busy || r.day.checkedInAt == null} onClick={() => run(() => call('checkOut'))}>
								{r.mode === 'full' && s.hasZoho ? 'Check out now' : 'Check out on Zoho'}
							</button>
						)}
						<span className="wp-muted wp-small">Time logs must fit inside attendance hours, so check out before pushing.</span>
					</div>
				)}
			</section>

			<section className="wp-card wp-stack">
				<div className="wp-between">
					<Step icon="list" title="Your time logs" done={!rows.length ? false : rows.every((x) => (minutesFromHHMM(x.hours) ?? 0) > 0 && !!x.jobId)} />
					{!done && (
						<button className="wp-btn wp-btn-sm wp-btn-ghost" onClick={() => setRows((l) => [...l, { jobId: '', hours: '00:00', description: '' }])}>
							Add row
						</button>
					)}
				</div>
				{rows.length ? (
					<table className="wp-table">
						<thead>
							<tr>
								<th style={{ width: '28%' }}>Job</th>
								<th style={{ width: 90 }}>Hours</th>
								<th>Description</th>
								<th style={{ width: 120 }} />
							</tr>
						</thead>
						<tbody>
							{rows.map((x, i) => (
								<tr key={i}>
									<td>
										<select className="wp-select" value={x.jobId} disabled={done} onChange={(e) => setRow(i, { jobId: e.target.value })}>
											<option value="">{r.jobs.length ? 'Pick a job…' : 'No job'}</option>
											{r.jobs.map((j) => (
												<option key={j.id} value={j.id}>
													{j.name}
												</option>
											))}
										</select>
									</td>
									<td>
										<input
											className="wp-input wp-num"
											value={x.hours}
											placeholder="01:30"
											disabled={done}
											aria-invalid={minutesFromHHMM(x.hours) == null}
											onChange={(e) => setRow(i, { hours: e.target.value })}
										/>
									</td>
									<td>
										<textarea className="wp-textarea" style={{ minHeight: 0 }} rows={Math.max(2, Math.ceil(x.description.length / 58))} value={x.description} disabled={done} onChange={(e) => setRow(i, { description: e.target.value })} />
									</td>
									<td>
										<div className="wp-row">
											<button className="wp-btn wp-btn-sm" onClick={() => copy(i)}>
												{copied === i ? 'Copied' : 'Copy'}
											</button>
											{!done && (
												<button className="wp-btn wp-btn-sm wp-btn-ghost wp-btn-danger" aria-label="Remove row" onClick={() => setRows((l) => l.filter((_, j) => j !== i))}>
													✕
												</button>
											)}
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				) : (
					<div className="wp-muted">No work entries for this day yet.</div>
				)}
			</section>

			<section className="wp-card wp-stack">
				{/* Between having the rows and sending them: the descriptions, as
				    the joined notes they are, tidied by the model the user brought.
				    Nothing is saved — both versions are shown and copied by hand. */}
				{!!rows.length && !done && <DraftRows date={r.date} />}

				<Step icon="external" title="Send it to Zoho" done={done} />
				{done ? (
					<>
					<div className="wp-ok-text">{r.day.timelogStatus === 'pushed' ? 'Done — this day is logged.' : 'Zoho marks this day as weekend, holiday or leave.'}</div>
					{/* The moment it has just done the thing it exists to do is the only
					    moment asking is a fair question rather than begging. */}
					{r.day.timelogStatus === 'pushed' && <Support />}
				</>
				) : (
					<div className="wp-row-wrap">
						{busy && r.canPush && <Art name="push" size={56} delay={400} />}
						{r.canPush ? (
							<button className="wp-btn wp-btn-primary" disabled={busy || !rows.length} onClick={push}>
								<Busy busy={busy} doing={`Pushing ${rows.length} to Zoho…`}>
									Push {rows.length} time log{rows.length === 1 ? '' : 's'} to Zoho
								</Busy>
							</button>
						) : (
							<>
								{/* Falling back to copying is fine; not saying why is not. */}
								<span className="wp-banner wp-small" style={{ flexBasis: '100%' }}>
									<span className="wp-grow">
										{r.pushBlocked === 'mode' ? (
											<>
												<strong>Pushing is switched off.</strong> Settings → <em>What WorkPulse may write to Zoho</em> is on <em>Reminder</em>; it needs{' '}
												<em>Time logs</em> or <em>Full</em>.
											</>
										) : r.pushBlocked === 'nosave' ? (
											<>
												<strong>WorkPulse has not seen a timesheet save yet.</strong> Save one row in Zoho once with recording on, and it can do the rest from
												then on.
											</>
										) : (
											<>
												<strong>Zoho is not connected.</strong> Either sign in, or capture one timesheet save and WorkPulse will use that instead.
											</>
										)}
									</span>
									<a className="wp-btn wp-btn-sm" href={r.pushBlocked === 'mode' ? '#/settings/mode' : '#/connect'}>
										{r.pushBlocked === 'mode' ? 'Open settings' : 'Set it up'}
									</a>
								</span>
								<button className="wp-btn" disabled={!rows.length} onClick={() => copy('all')}>
									{copied === 'all' ? 'Copied all' : 'Copy all rows'}
								</button>
								<button className="wp-btn wp-btn-primary" disabled={busy} onClick={() => run(() => call('markDone', r.date))}>
									Mark as done
								</button>
								<button className="wp-btn wp-btn-ghost" onClick={() => run(() => call('openZoho'))}>
									Open Zoho
								</button>
							</>
						)}
					</div>
				)}
				{result && result.status !== 'pushed' && <div className={result.status === 'skipped' ? 'wp-muted' : 'wp-error'}>{result.message}</div>}
			</section>

			<section className="wp-card wp-stack">
				<div className="wp-between">
					<h2 className="wp-h2">
						Entries
						{!!unsynced.length && <span className="wp-chip wp-chip-warn" style={{ marginLeft: 8 }}>{fmtMinutes(unsynced.reduce((a, e) => a + e.minutes, 0))} not in Zoho</span>}
					</h2>
					{!!unsynced.length && (
						<span className="wp-row wp-small">
							<span className="wp-muted">
								{chosen.length} of {unsynced.length} not yet in Zoho selected
							</span>
							<button className="wp-action" onClick={() => setPicked(new Set(unsynced.map((e) => e.uid)))}>
								All
							</button>
							<button className="wp-action" onClick={() => setPicked(new Set())}>
								None
							</button>
						</span>
					)}
				</div>
				{r.entries.length ? (
					<div className="wp-timeline wp-scroll">
						{r.entries.map((e) => (
							<div key={e.uid} className="wp-tl-item">
								<span className="wp-num wp-muted">
									{e.kind === 'work' &&
										(e.synced ? (
											<span className="wp-chip wp-chip-ok" title="Already in Zoho">
												<span className="wp-dot" />
											</span>
										) : (
											<input
												type="checkbox"
												aria-label={`Include ${e.text}`}
												checked={picked?.has(e.uid) ?? false}
												onChange={(ev) =>
													setPicked((p) => {
														const next = new Set(p ?? [])
														if (ev.target.checked) next.add(e.uid)
														else next.delete(e.uid)
														return next
													})
												}
											/>
										))}{' '}
									{istTime(e.slotStart)} – {istTime(e.slotEnd)}
								</span>
								<span>
									{e.text} {e.kind !== 'work' && <span className="wp-chip">{e.kind === 'break' ? 'Break' : 'Skipped'}</span>}
									{/* A line you did not write must never be indistinguishable
									    from one you did. */}
									{e.auto && (
										<span className="wp-chip" title="Added for you because this meeting recurs. Delete it if it did not happen.">
											Added for you
										</span>
									)}
									{e.jobId && <div className="wp-muted wp-small">{jobName.get(e.jobId) ?? e.jobId}</div>}
								</span>
								<span className="wp-row">
									{e.kind === 'work' && <span className="wp-num">{fmtMinutes(e.minutes)}</span>}
									{e.kind === 'work' && e.synced && <span className="wp-chip wp-chip-ok">In Zoho</span>}
									{!e.synced && (
										<button className="wp-btn wp-btn-sm wp-btn-ghost" onClick={() => run(() => call('deleteEntry', r.date, e.uid))}>
											Delete
										</button>
									)}
								</span>
							</div>
						))}
					</div>
				) : (
					<div className="wp-muted">No entries.</div>
				)}
				<hr className="wp-divider" />
				<div className="wp-eyebrow">Add an entry by hand</div>
				<div className="wp-row-wrap">
					<input className="wp-input wp-num" style={{ width: 90 }} placeholder="09:00" value={manual.from} onChange={(e) => setManual({ ...manual, from: e.target.value })} />
					<span className="wp-muted">to</span>
					<input className="wp-input wp-num" style={{ width: 90 }} placeholder="10:00" value={manual.to} onChange={(e) => setManual({ ...manual, to: e.target.value })} />
					{r.jobs.length > 0 && (
						<select className="wp-select" style={{ width: 200 }} value={manual.jobId} onChange={(e) => setManual({ ...manual, jobId: e.target.value })}>
							<option value="">Job…</option>
							{r.jobs.map((j) => (
								<option key={j.id} value={j.id}>
									{j.name}
								</option>
							))}
						</select>
					)}
					<input className="wp-input wp-grow" placeholder="What you worked on" value={manual.text} onChange={(e) => setManual({ ...manual, text: e.target.value })} />
					<button
						className="wp-btn"
						disabled={busy}
						onClick={() =>
							run(async () => {
								await call('addManualEntry', { date: r.date, ...manual })
								setManual({ from: '', to: '', text: '', jobId: manual.jobId })
							})
						}
					>
						Add
					</button>
				</div>
			</section>
			{error && <div className="wp-error">{error}</div>}
			{/* The push needs Zoho's own save call. When it is missing, the way to
			    supply it belongs here, where the push failed — not three pages away. */}
			{wiring && !wiring.save && r.mode !== 'reminder' && (
				<div className="wp-card wp-stack-sm">
					<h2 className="wp-h2">WorkPulse cannot send time logs yet</h2>
					<div className="wp-muted wp-small">
						It needs to watch you save one row in Zoho first — then it copies that shape and fills in your own date, hours and notes.{' '}
						<a className="wp-link" href="#/connect">
							Set it up (one minute) →
						</a>
					</div>
					<details>
						<summary className="wp-small wp-muted" style={{ cursor: 'pointer' }}>
							Or paste it by hand
						</summary>
						<div style={{ marginTop: 10 }}>
						<PasteCall hint="curl --url 'https://people.zoho.in/logiciel/addUpdateRecord.zp' …" onAdded={() => void reloadWiring()} />
						</div>
					</details>
				</div>
			)}
		</div>
	)
}

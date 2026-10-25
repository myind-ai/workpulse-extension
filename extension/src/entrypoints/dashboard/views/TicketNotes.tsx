// A ticket's running notes: Markdown, grouped by the day they belong to. The
// decisions, the blockers, the two commands you will need again — written where
// the ticket's links already are.

import { useState } from 'react'

import { firstLine, toggleBox } from '@/core/markdown'
import { addDays, istDate, prettyDate } from '@/core/time'
import { call } from '@/lib/rpc'
import { ConfirmButton } from '@/ui/Confirm'
import type { TicketNote, Workspace } from '@/lib/store'
import { useAction } from '@/ui/hooks'
import { Markdown } from '@/ui/Markdown'
import { NoteEditor } from '@/ui/NoteEditor'
import { DateField } from '@/ui/TimeField'

/** "Today", "Yesterday", "Sat 11 Oct" — how people ask for a day. */
export function dayLabel(date: string, today: string): string {
	if (date === today) return 'Today'
	if (date === addDays(today, -1)) return 'Yesterday'
	return prettyDate(date)
}

export function TicketNotes({ space, onSaved }: { space: Workspace; onSaved: () => Promise<unknown> }) {
	const today = istDate(Date.now())
	const [adding, setAdding] = useState(false)
	const [editing, setEditing] = useState<string | null>(null)
	const notes = space.notes ?? []

	const byDay = notes.reduce<Record<string, TicketNote[]>>((acc, n) => {
		;(acc[n.date] ??= []).push(n)
		return acc
	}, {})
	const days = Object.keys(byDay).sort((a, b) => b.localeCompare(a))

	return (
		<div className="wp-stack-sm">
			<div className="wp-between">
				<span className="wp-eyebrow">Notes</span>
				{!adding && (
					<button className="wp-btn wp-btn-sm" onClick={() => setAdding(true)}>
						+ Note for {dayLabel(today, today).toLowerCase()}
					</button>
				)}
			</div>

			{adding && <Editor space={space} onDone={() => setAdding(false)} onSaved={onSaved} today={today} />}

			{!notes.length && !adding && <span className="wp-muted wp-small">No notes yet — what you decided today is what you will want in a month.</span>}

			{days.map((date) => (
				<div key={date} className="wp-stack-sm">
					<span className="wp-small wp-muted">{dayLabel(date, today)}</span>
					{byDay[date].map((n) =>
						editing === n.id ? (
							<Editor key={n.id} space={space} note={n} onDone={() => setEditing(null)} onSaved={onSaved} today={today} />
						) : (
							<Note key={n.id} space={space} note={n} onEdit={() => setEditing(n.id)} onSaved={onSaved} />
						),
					)}
				</div>
			))}
		</div>
	)
}

function Note({ space, note, onEdit, onSaved }: { space: Workspace; note: TicketNote; onEdit: () => void; onSaved: () => Promise<unknown> }) {
	const { busy, run } = useAction()

	/**
	 * Ticking a box in a rendered note edits the note itself — the nth `[ ]` in
	 * the text, counted the same way the renderer counts them.
	 */
	const toggle = (boxIndex: number) =>
		run(async () => {
			await call('saveNote', space.id, { noteId: note.id, text: toggleBox(note.text, boxIndex) })
			await onSaved()
		})

	return (
		<div className="wp-card-flat wp-stack-sm">
			<Markdown text={note.text} onToggleBox={busy ? undefined : toggle} />
			<div className="wp-row wp-small">
				<button className="wp-action" onClick={onEdit}>
					Edit
				</button>
				<ConfirmButton
					label="Delete"
					question={`Delete “${firstLine(note.text).slice(0, 60)}”?`}
					confirmLabel="Delete it"
					disabled={busy}
					onConfirm={() => run(async () => void (await call('deleteNote', space.id, note.id), await onSaved()))}
				/>
				{note.editedAt && <span className="wp-muted">edited</span>}
			</div>
		</div>
	)
}

function Editor({ space, note, today, onDone, onSaved }: { space: Workspace; note?: TicketNote; today: string; onDone: () => void; onSaved: () => Promise<unknown> }) {
	const [text, setText] = useState(note?.text ?? '')
	// Writing up yesterday today is normal, so the day is yours to set.
	const [date, setDate] = useState(note?.date ?? today)
	const { busy, error, run } = useAction()

	const save = () =>
		run(async () => {
			await call('saveNote', space.id, { noteId: note?.id, text, date })
			await onSaved()
			onDone()
		})

	return (
		<div className="wp-card-flat wp-stack-sm">
			<div
				onKeyDown={(e) => {
					if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && text.trim()) void save()
					if (e.key === 'Escape') onDone()
				}}
			>
				<NoteEditor value={text} onChange={setText} autoFocus />
			</div>
			{error && <div className="wp-error wp-small">{error}</div>}
			<div className="wp-between wp-small">
				<span className="wp-row">
					<DateField label="The day this note belongs to" value={date} max={today} onChange={(v) => setDate(v || today)} width={140} />
					<span className="wp-muted">⌘↵ saves · markdown renders as you leave each line</span>
				</span>
				<span className="wp-row">
					<button className="wp-btn wp-btn-sm wp-btn-ghost" onClick={onDone}>
						Cancel
					</button>
					<button className="wp-btn wp-btn-sm wp-btn-primary" disabled={busy || !text.trim()} onClick={save}>
						Save
					</button>
				</span>
			</div>
		</div>
	)
}

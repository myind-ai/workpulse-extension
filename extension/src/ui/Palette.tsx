// The box. One keystroke on any page, everything the app can do inside it.
//
// Type to filter, Tab to change what Enter will do, Enter to do it. Escape
// closes. Nothing here is a new capability — it is the same commands the
// dashboard calls, reached without leaving the sentence you were writing.

import { useEffect, useMemo, useRef, useState } from 'react'

import type { Hit } from '@/core/find'
import { KIND_LABEL } from '@/core/find'
import { canSubmit, footerFor, MODES, modeFor, nextMode, type Mode } from '@/core/palette'
import { findSections, type Section } from '@/core/sections'
import { fmtMinutes } from '@/core/time'
import { isDismissKey } from '@/ui/palette-open'
import { call } from '@/lib/rpc'


/** "YYYY-MM-DDTHH:MM", which is what a reminder is stored as. */
const stamp = (d: Date, hours: number) =>
	`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(Math.floor(hours)).padStart(2, '0')}:${String(Math.round((hours % 1) * 60)).padStart(2, '0')}`
const todayAt = (h: number) => stamp(new Date(), h)
const tomorrowAt = (h: number) => stamp(new Date(Date.now() + 86_400_000), h)

export function Palette({ onClose, page: given }: { onClose: () => void; page?: { title: string; url: string } }) {
	const [raw, setRaw] = useState('')
	const [mode, setMode] = useState<Mode>('go')
	const [at, setAt] = useState(0)
	const [busy, setBusy] = useState(false)
	const [said, setSaid] = useState('')
	const [found, setFound] = useState<Hit[]>([])
	const [tickets, setTickets] = useState<{ id: string; name: string }[]>([])
	const [groups, setGroups] = useState<{ id: string; name: string; count: number }[]>([])
	const [here, setHere] = useState<{ text: string; author: string; state: string; localId?: string }[]>([])
	// The slot the box would log against, and how much of it to claim.
	const [slot, setSlot] = useState<{ label: string; minutes: number; total: number; jobId: string; jobs: { id: string; name: string }[] } | null>(null)
	const [mins, setMins] = useState<number | null>(null)
	const [jobId, setJobId] = useState('')
	// What each mode needs beyond words. Kept to chips, because a box that is
	// meant to take three seconds cannot grow a form.
	const [kind, setKind] = useState<'learning' | 'mistake'>('learning')
	const [ctxKind, setCtxKind] = useState<'note' | 'decision' | 'debug' | 'handover'>('note')
	const [nextStep, setNextStep] = useState('')
	const [when, setWhen] = useState<'' | 'today' | 'tomorrow'>('')
	const [high, setHigh] = useState(false)
	// The picture is taken for you, not asked about: the moment you are writing
	// about a page is the moment the evidence is on the screen, and "do you want
	// a screenshot?" is a question with one answer and a click attached.
	const [shot, setShot] = useState<string | null>(null)
	const [shotOff, setShotOff] = useState(false)
	// The box is drawn over the page it is about, so it has to get out of the
	// way of its own photograph. Two frames of being invisible is enough for the
	// browser to have painted the page without it.
	const [hiding, setHiding] = useState(false)
	const [flash, setFlash] = useState(false)
	const [big, setBig] = useState(false)

	const takeShot = async () => {
		if (!page?.url) return
		setHiding(true)
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
		const pic = await call('capturePage', page.url).catch(() => null)
		setHiding(false)
		if (pic) {
			setShot(pic)
			setShotOff(false)
			// A picture taken silently is a picture nobody believes in. The frame
			// pulses once around exactly what was captured — the visible page, not
			// the whole document and not this box.
			setFlash(true)
			setTimeout(() => setFlash(false), 650)
		}
		return pic
	}
	// From a content script the page is handed in. From the dashboard or the
	// widget it has to be asked for, because the active tab there is WorkPulse.
	const [onPage, setOnPage] = useState<{ title: string; url: string } | null>(null)
	const page = given ?? onPage ?? undefined
	useEffect(() => {
		if (!given) void call('currentPage').then(setOnPage)
	}, [given])
	const box = useRef<HTMLInputElement>(null)

	// A prefix changes the mode as you type it, and is eaten in the process.
	const read = modeFor(raw, mode)
	const text = read.text
	useEffect(() => {
		if (read.mode !== mode) {
			setMode(read.mode)
			setRaw(read.text)
		}
	}, [raw])

	useEffect(() => box.current?.focus(), [])

	/**
	 * Escape, from anywhere in the box.
	 *
	 * It was bound to the textarea alone, so pressing a mode button, picking a
	 * row, or the page quietly taking focus back all left Escape doing nothing
	 * — on an overlay covering somebody's whole screen. Captured at the
	 * document, like every other dismissable thing here, so it does not depend
	 * on where focus happens to be.
	 */
	useEffect(() => {
		const esc = (e: KeyboardEvent) => {
			if (!isDismissKey(e)) return
			e.preventDefault()
			e.stopPropagation()
			onClose()
		}
		// Capture: a page with its own Escape handler must not get there first
		// and swallow it while our overlay is the thing on screen.
		document.addEventListener('keydown', esc, true)
		return () => document.removeEventListener('keydown', esc, true)
	}, [onClose])
	useEffect(() => setAt(0), [raw, mode])

	// Going somewhere searches the sections and everything you have written;
	// filing a page searches your tickets. Nothing else needs a list.
	useEffect(() => {
		if (mode === 'ticket') {
			void call('ticketList').then((list) => setTickets(list.map((w) => ({ id: w.id, name: w.name }))))
			return
		}
		if (mode === 'group') {
			void call('groups').then(setGroups)
			return
		}
		// Writing one and reading the ones already there are the same thought, so
		// they are the same mode: the list is simply what is under the box.
		if (mode === 'page') {
			if (!page?.url) return
			void call('notesOnPage', page.url).then((r) => setHere(r.notes.map((n) => ({ text: n.text, author: n.author, state: n.state, localId: n.localId }))))
			// Taken as the mode opens, with the box out of the way. Only when that
			// page is the one on screen — from the dashboard it is not, and there
			// is nothing honest to photograph.
			if (!shot && !shotOff) void takeShot()
			return
		}
		// Logging needs to know what it is logging against before you press Enter,
		// not after — the slot and its length are half the question.
		if (mode === 'log') {
			void call('promptContext', true).then((c) => {
				setSlot({ label: c.label, minutes: c.minutes, total: c.totalMinutes, jobId: c.defaultJobId, jobs: c.jobs.map((j) => ({ id: j.id, name: j.name })) })
				setMins((m) => m ?? c.minutes)
				setJobId((j) => j || c.defaultJobId || '')
			})
			return
		}
		if (mode !== 'go' || text.trim().length < 2) return setFound([])
		let live = true
		void call('findAll', text.trim()).then((r) => live && setFound(r.hits.slice(0, 8)))
		return () => {
			live = false
		}
	}, [mode, text])

	const sections = mode === 'go' ? findSections(text).slice(0, 5) : []
	const picks: { key: string; title: string; detail: string; run: () => void | Promise<unknown> }[] = useMemo(() => {
		if (mode === 'go') {
			return [
				...sections.map((s: Section) => ({ key: `s-${s.hash}-${s.title}`, title: s.title, detail: s.detail, run: () => go(s.hash) })),
				...found.map((h) => ({ key: `h-${h.kind}-${h.at}-${h.text.slice(0, 10)}`, title: h.text, detail: `${KIND_LABEL[h.kind]} · ${h.where}`, run: () => (h.url ? window.open(h.url, '_blank', 'noreferrer') : go(h.hash ?? '#/today')) })),
			]
		}
		if (mode === 'ticket') {
			const list = text.trim() ? tickets.filter((t) => t.name.toLowerCase().includes(text.trim().toLowerCase())) : tickets
			return list.slice(0, 8).map((t) => ({
				key: t.id,
				title: t.name,
				detail: 'File this page under it',
				run: async () => {
					if (!page) return
					await call('addToWorkspace', t.id, [{ title: page.title, url: page.url }])
					setSaid(`Filed under ${t.name}`)
				},
			}))
		}
		if (mode === 'group') {
			const q = text.trim().toLowerCase()
			const list = q ? groups.filter((g) => g.name.toLowerCase().includes(q)) : groups
			return list.slice(0, 8).map((g) => ({
				key: g.id,
				title: g.name,
				detail: `${g.count} tab${g.count === 1 ? '' : 's'} · Enter reopens them together`,
				run: async () => {
					await call('openWorkspace', g.id, [])
					setSaid(`Opening “${g.name}”`)
				},
			}))
		}
		if (mode === 'page') {
			// Not things to pick: things to read, and to tick off.
			return here.map((n) => ({
				key: n.localId ?? n.text.slice(0, 20),
				title: n.text,
				detail: `${n.author}${n.state === 'closed' ? ' · dealt with' : ''}${n.localId ? ' · Enter writes a new one' : ''}`,
				run: async () => {
					if (n.localId) await call('noteDone', n.localId, n.state !== 'closed')
					if (page?.url) setHere((await call('notesOnPage', page.url)).notes.map((x) => ({ text: x.text, author: x.author, state: x.state, localId: x.localId })))
				},
			}))
		}
		if (mode === 'focus') {
			return [25, 50, 90].map((m) => ({
				key: `f-${m}`,
				title: `${m} minutes`,
				detail: text.trim() ? `on “${text.trim()}”` : 'on one thing, nothing interrupting',
				run: async () => {
					await call('startFocus', m, undefined, text.trim() || undefined)
					setSaid(`${m} minutes. Nothing will interrupt.`)
				},
			}))
		}
		return []
	}, [mode, text, found.length, tickets.length, groups.length, here.length, page?.url])

	const go = (hash: string) => {
		void call('openDashboard', hash.replace(/^#\//, ''))
		onClose()
	}

	const submit = async () => {
		if (busy) return
		const body = text.trim()
		setBusy(true)
		try {
			if (mode === 'log') {
				const ctx = await call('promptContext', true)
				const minutes = Math.min(mins ?? ctx.minutes, Math.max(ctx.totalMinutes, 1))
				await call('saveEntry', { slotStart: ctx.slotStart, slotEnd: ctx.slotEnd, text: body, jobId: jobId || ctx.defaultJobId || undefined, minutes })
				setSaid(`Logged ${fmtMinutes(minutes)} against ${ctx.label}`)
			} else if (mode === 'learn') {
				await call('saveLearning', { text: body, kind })
				setSaid(kind === 'mistake' ? 'Saved — you will be told if it comes up again' : 'Saved to your learnings')
			} else if (mode === 'brain') {
				const saved = await call('saveContext', { title: body, kind: ctxKind, next: nextStep.trim() || undefined, page })
				setNextStep('')
				setSaid(saved.queued ? 'Saved here — it goes to the Brain on the next sync' : `Saved to the Brain${saved.ticket ? ` under ${saved.ticket}` : ''}`)
			} else if (mode === 'page') {
				if (!page) throw new Error('No page here to note.')
				// The screenshot has to be taken by the background: a page cannot
				// photograph itself.
				await call('noteOnPage', { url: page.url, title: page.title, text: body, shot: shot ?? undefined })
				setSaid('Kept against this page — it comes back when you open it')
			} else if (mode === 'group' && body && !picks.length) {
				// Typed a name no group answers to: that is the save, not an
				// empty result. One step, named before it is kept.
				const g = await call('saveWindowAsGroup', body)
				setSaid(`Kept ${g.count} tab${g.count === 1 ? '' : 's'} as “${g.name}”`)
			} else if (mode === 'task') {
				const at = when === 'today' ? todayAt(16) : when === 'tomorrow' ? tomorrowAt(9.5) : undefined
				await call('capture', { text: body, when: at, priority: high ? 'high' : undefined })
				setSaid(when ? `Added — you will hear about it ${when === 'today' ? 'at 16:00' : 'tomorrow at 09:30'}` : 'Added to your tasks')
			} else {
				await picks[at]?.run()
			}
			setRaw('')
			// Something saved: say so, then get out of the way.
			setTimeout(onClose, 900)
		} catch (e) {
			setSaid((e as Error).message)
		} finally {
			setBusy(false)
		}
	}

	// In page mode the list is what is already there, not a list to choose from:
	// Enter writes a new one, and the rows are ticked off by clicking them.
	// In group mode a name that matches nothing is not an empty result — it is
	// the new group's name, so Enter is ready as soon as anything is typed.
	const ready = mode === 'group' ? !!text.trim() || picks.length > 0 : canSubmit(mode, text, mode === 'page' ? false : picks.length > 0) && (mode !== 'page' || !!page)

	return (
		// `wp-root` carries every colour token. Without it the box inherits
		// nothing — in the dashboard an ancestor happened to provide them, but in
		// a content script's shadow root there is no ancestor, so `var(--wp-surface)`
		// resolved to nothing and the whole thing was transparent over the page.
		<div className="wp-root wp-pal-back" style={hiding ? { opacity: 0, pointerEvents: 'none' } : undefined} onMouseDown={onClose}>
			{/* Around exactly what was captured, for half a second. */}
			{flash && <span className="wp-pal-flash" aria-hidden />}
			<div className="wp-pal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="WorkPulse">
				<div className="wp-pal-modes">
					{MODES.map((m) => (
						<button key={m.id} className={m.id === mode ? 'wp-pal-mode wp-pal-on' : 'wp-pal-mode'} onClick={() => setMode(m.id)} aria-pressed={m.id === mode}>
							{m.label}
						</button>
					))}
					<span className="wp-pal-tab">Tab</span>
				</div>

				<input
					ref={box}
					className="wp-pal-input"
					placeholder={MODES.find((m) => m.id === mode)!.empty}
					value={raw}
					onChange={(e) => setRaw(e.target.value)}
					onPaste={(e) => {
						// Your own crop — ⌘⇧4 on a Mac, Snip on Windows — beats anything
						// the browser can take of itself, and this is the only place it
						// could ever have gone.
						const file = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'))?.getAsFile()
						if (!file || mode !== 'page') return
						e.preventDefault()
						const reader = new FileReader()
						reader.onload = () => {
							setShot(String(reader.result))
							setShotOff(false)
						}
						reader.readAsDataURL(file)
					}}
					onKeyDown={(e) => {
						e.stopPropagation()
						if (e.key === 'Escape') return onClose()
						if (e.key === 'Tab') {
							e.preventDefault()
							return setMode(nextMode(mode, e.shiftKey))
						}
						if (e.key === 'ArrowDown' && picks.length) {
							e.preventDefault()
							return setAt((at + 1) % picks.length)
						}
						if (e.key === 'ArrowUp' && picks.length) {
							e.preventDefault()
							return setAt((at - 1 + picks.length) % picks.length)
						}
						if (e.key === 'Enter' && ready) {
							e.preventDefault()
							void submit()
						}
					}}
				/>

				{/* What each mode needs beyond the words, as chips. Never a form: a
				    box meant to take three seconds cannot grow one. */}
				{mode === 'log' && slot && (
					<>
						<div className="wp-pal-chips">
							<button className={mins === slot.minutes ? 'wp-chip wp-chip-accent' : 'wp-chip'} onClick={() => setMins(slot.minutes)}>
								all {fmtMinutes(slot.minutes)}
							</button>
							{[15, 30, 45, 60, 90, 120].filter((m) => m < slot.total).map((m) => (
								<button key={m} className={mins === m ? 'wp-chip wp-chip-accent' : 'wp-chip'} onClick={() => setMins(m)}>
									{fmtMinutes(m)}
								</button>
							))}
							{/* And a number, for the time that is not one of those. */}
							<label className="wp-pal-mins">
								<input
									type="number"
									min={1}
									max={Math.max(slot.total, 1)}
									value={mins ?? slot.minutes}
									onChange={(e) => setMins(Math.max(0, Number(e.target.value)))}
									onKeyDown={(e) => {
										// Enter in here means the same as Enter anywhere else in
										// the box: save it.
										if (e.key === 'Enter' && ready) {
											e.preventDefault()
											void submit()
										}
										e.stopPropagation()
									}}
									aria-label="Minutes to log"
								/>
								min
							</label>
							<span className="wp-pal-slot">{slot.label}</span>
						</div>
						{/* Zoho refuses an entry with no job, so the box cannot either —
						    and finding that out on Enter is the worst moment to. */}
						{slot.jobs.length > 1 && (
							<div className="wp-pal-chips">
								{slot.jobs.slice(0, 4).map((j) => (
									<button key={j.id} className={jobId === j.id ? 'wp-chip wp-chip-accent' : 'wp-chip'} onClick={() => setJobId(j.id)} title={j.name}>
										{j.name.length > 22 ? `${j.name.slice(0, 21)}…` : j.name}
									</button>
								))}
							</div>
						)}
					</>
				)}

				{mode === 'learn' && (
					<div className="wp-pal-chips">
						<button className={kind === 'learning' ? 'wp-chip wp-chip-accent' : 'wp-chip'} onClick={() => setKind('learning')}>
							Learned
						</button>
						{/* A mistake is the one worth tagging: it is what the repeat
						    nudge watches for. */}
						<button className={kind === 'mistake' ? 'wp-chip wp-chip-warn' : 'wp-chip'} onClick={() => setKind('mistake')}>
							Would not repeat
						</button>
					</div>
				)}

				{mode === 'brain' && (
					<>
						<div className="wp-pal-chips">
							{([['note', 'Note'], ['decision', 'Decision'], ['debug', 'Debugging'], ['handover', 'Handover']] as const).map(([k, label]) => (
								<button key={k} className={ctxKind === k ? 'wp-chip wp-chip-accent' : 'wp-chip'} onClick={() => setCtxKind(k)}>
									{label}
								</button>
							))}
							{page && (
								<span className="wp-pal-slot" title={page.url}>
									with {page.title.slice(0, 40)}
								</span>
							)}
						</div>
						{/* The one line that makes it resumable. Optional, because a
						    title alone is still worth keeping. */}
						<input
							className="wp-pal-input wp-pal-next"
							placeholder="Next action (optional): what to do first when you come back"
							value={nextStep}
							onChange={(e) => setNextStep(e.target.value)}
							onKeyDown={(e) => {
								e.stopPropagation()
								if (e.key === 'Escape') return onClose()
								if (e.key === 'Enter' && ready) {
									e.preventDefault()
									void submit()
								}
							}}
							aria-label="Next action"
						/>
					</>
				)}

				{mode === 'task' && (
					<div className="wp-pal-chips">
						<button className={when === '' ? 'wp-chip wp-chip-accent' : 'wp-chip'} onClick={() => setWhen('')}>
							no reminder
						</button>
						<button className={when === 'today' ? 'wp-chip wp-chip-accent' : 'wp-chip'} onClick={() => setWhen('today')}>
							later today
						</button>
						<button className={when === 'tomorrow' ? 'wp-chip wp-chip-accent' : 'wp-chip'} onClick={() => setWhen('tomorrow')}>
							tomorrow 09:30
						</button>
						<button className={high ? 'wp-chip wp-chip-danger' : 'wp-chip'} onClick={() => setHigh(!high)}>
							{high ? 'high' : 'mark high'}
						</button>
					</div>
				)}

				{mode === 'page' && (
					<div className="wp-pal-chips">
						{page ? (
							<>
								{shot ? (
									<span className="wp-pal-shot">
										{/* Clickable, because "what exactly did it take?" is the
										    first thing anyone wants to know. */}
										<button className="wp-pal-thumb" onClick={() => setBig(!big)} title={big ? 'Smaller' : 'See what was captured'}>
											<img src={shot} alt="The page as it was captured" />
										</button>
										<span className="wp-muted" style={{ fontSize: 11.5 }}>the visible page, just now</span>
										<button className="wp-action wp-muted" onClick={() => void takeShot()} title="Take it again — scroll to the thing first">
											again
										</button>
										<button
											className="wp-action wp-muted"
											title="Note it without the picture"
											onClick={() => {
												setShot(null)
												setShotOff(true)
												setBig(false)
											}}
										>
											drop it
										</button>
									</span>
								) : (
									<>
										{/* It can always be asked for again — the page may have
										    been scrolled to the thing that is actually wrong. */}
										<button className="wp-chip wp-chip-accent" style={{ cursor: 'pointer' }} onClick={() => void takeShot()}>
											{shotOff ? 'take one again' : 'attach a screenshot'}
										</button>
										<span className="wp-muted" style={{ fontSize: 11.5 }}>or ⌘V to paste your own</span>
									</>
								)}
								{/* Which page, said out loud: from the dashboard this is the
								    last page you were on, not the one you are looking at. */}
								<span className="wp-pal-slot" title={page.url}>
									on {page.title.slice(0, 44)}
								</span>
							</>
						) : (
							<span className="wp-muted" style={{ fontSize: 11.5 }}>No ordinary page open to note — open one first.</span>
						)}
					</div>
				)}

				{/* The full picture, when it has been asked for. */}
				{mode === 'page' && shot && big && (
					<div className="wp-pal-big">
						<img src={shot} alt="The page as it was captured" />
					</div>
				)}

				{mode === 'page' && !!here.length && <div className="wp-pal-group">Already on this page</div>}
				{!!picks.length && (
					<div className="wp-pal-list">
						{picks.map((p, i) => (
							<button key={p.key} className={i === at ? 'wp-pal-hit wp-pal-at' : 'wp-pal-hit'} onMouseEnter={() => setAt(i)} onClick={() => void (mode === 'page' ? p.run() : submit())}>
								<span className="wp-pal-title">{p.title}</span>
								<span className="wp-pal-detail">{p.detail}</span>
							</button>
						))}
					</div>
				)}

				<div className="wp-pal-foot">
					<span>{said || (mode === 'log' && slot && mins != null && text.trim() ? `Enter logs ${fmtMinutes(mins)} against ${slot.label}` : footerFor(mode, text, picks.length > 0))}</span>
					<span className="wp-pal-keys">
						<kbd>Tab</kbd> mode · <kbd>↵</kbd> {busy ? 'saving…' : 'do it'} · <kbd>esc</kbd>
					</span>
				</div>
			</div>
		</div>
	)
}

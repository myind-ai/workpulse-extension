// Your zone, the zones you work with, and somewhere to try a time. The same
// conversion the right-click menu does, so what you see here is what a selected
// time on any page will say.

import { useEffect, useMemo, useState } from 'react'

import { DEFAULT_STRAY } from '@/core/deepwork'
import { cleanPrefix } from '@/core/links'
import { COMMON_ZONES, explain, localZone, resolveZone, timeIn, zoneGap, zoneLabel } from '@/core/timezone'
import type { Settings } from '@/core/types'
import { useAction, useLive } from '@/ui/hooks'
import { Icon } from '@/ui/Icon'
import { call } from '@/lib/rpc'
import { Panel } from '@/ui/Panel'
import { TimeField } from '@/ui/TimeField'

/** `onPatch` saves and hands back the whole of settings, so the page stays in step. */
export function Recall() {
	const [on, setOn] = useState(true)
	const { busy, run } = useAction()

	useEffect(() => {
		void chrome.permissions.contains({ permissions: ['history'] }).then(setOn)
	}, [])

	return (
		<Panel
			title="Remind me what I had open"
			hint={on ? 'On — the hourly prompt suggests from your browser history' : 'Off'}
			keywords="history browsing recall suggest hourly prompt what did i do remember"
		>
			<p className="wp-muted wp-small" style={{ margin: 0 }}>
				An hour later, "what did you work on?" is a hard question. The browser already knows.
			</p>

			{/* What it does, shown rather than described. */}
			<div className="wp-card-flat wp-stack-sm wp-small">
				<span className="wp-eyebrow">The hourly card would say</span>
				<div className="wp-row-wrap">
					<span className="wp-chip wp-chip-accent">PAY-2433 <span className="wp-muted">40m</span></span>
					<span className="wp-chip">
						docs.acme.com <span className="wp-muted">15m</span>
					</span>
					<span className="wp-chip">
						github.com <span className="wp-muted">5m</span>
					</span>
				</div>
				<span className="wp-muted">Click one to put it in the box. Nothing is written for you.</span>
			</div>

			<ul className="wp-list wp-muted wp-small">
				<li>Grouped by ticket where a page names one, using your prefixes.</li>
				<li>Read in the background, for the one hour being asked about.</li>
				<li>Nothing is stored, and nothing is sent anywhere.</li>
			</ul>

			<div className="wp-row">
				{on ? (
					<button
						className="wp-btn wp-btn-sm"
						disabled={busy}
						onClick={() => run(async () => void setOn(!(await chrome.permissions.remove({ permissions: ['history'] }))))}
					>
						Turn it off
					</button>
				) : (
					<button
						className="wp-btn wp-btn-sm wp-btn-primary"
						disabled={busy}
						onClick={() => run(async () => void setOn(await chrome.permissions.request({ permissions: ['history'] })))}
					>
						Allow reading history
					</button>
				)}
				<span className="wp-muted wp-small">Chrome asks you directly, and you can take it back here at any time.</span>
			</div>
		</Panel>
	)
}

export function Prefixes({ settings, onPatch }: { settings: Settings; onPatch: (patch: Partial<Settings>) => Promise<void> }) {
	const list = settings.ticketPrefixes ?? []
	const [add, setAdd] = useState('')
	const { busy, error, run } = useAction()

	const save = (next: string[]) => run(() => onPatch({ ticketPrefixes: [...new Set(next.map(cleanPrefix).filter(Boolean))].slice(0, 12) }))

	return (
		<Panel title="Ticket prefixes" hint={list.length ? list.map((p) => `${p}-`).join(' ') : 'PAY, LEAP, SALESPRO — what your keys start with'} keywords="ticket prefix key PAY LEAP jira right click menu">
			<div>
				<p className="wp-muted wp-small">
					What your teams' keys start with — <code>PAY</code>, <code>LEAP</code>, <code>SALESPRO</code>. Right-clicking a page then offers the ticket its key points at. With none
					set, anything shaped like <code>ABC-123</code> counts.
				</p>
			</div>
			<div className="wp-row-wrap wp-small">
				{list.map((p) => (
					<span key={p} className="wp-chip wp-chip-accent">
						{p}-
						<button className="wp-action wp-action-danger" style={{ marginLeft: 6 }} disabled={busy} onClick={() => save(list.filter((x) => x !== p))} aria-label={`Remove ${p}`}>
							✕
						</button>
					</span>
				))}
				<input
					className="wp-input wp-sm"
					style={{ width: 120 }}
					placeholder="+ PAY"
					value={add}
					onChange={(e) => setAdd(e.target.value)}
					onKeyDown={(e) => {
						if (e.key !== 'Enter' || !cleanPrefix(add)) return
						save([...list, add])
						setAdd('')
					}}
				/>
				{!!cleanPrefix(add) && (
					<button
						className="wp-btn wp-btn-sm"
						disabled={busy}
						onClick={() => {
							save([...list, add])
							setAdd('')
						}}
					>
						Add
					</button>
				)}
			</div>
			{error && <div className="wp-error wp-small">{error}</div>}
		</Panel>
	)
}

export function Zones({ settings, onPatch }: { settings: Settings; onPatch: (patch: Partial<Settings>) => Promise<void> }) {
	const mine = settings.myZone || localZone()
	const others = settings.otherZones ?? []
	const [add, setAdd] = useState('')
	const [tryIt, setTryIt] = useState('3pm PST')
	const { busy, error, run } = useAction()
	const now = Date.now()

	const save = (patch: Partial<Settings>) => run(() => onPatch(patch))

	const result = useMemo(() => explain(tryIt, mine, others, now), [tryIt, mine, others.join(), now])

	// Zones worth offering: the usual ones, plus this browser's if it is unusual.
	const choices = [...new Set([localZone(), ...COMMON_ZONES])]

	return (
		<Panel title="Time zones" hint={`Yours: ${zoneLabel(mine)}${others.length ? ` · ${others.length} more` : ''}`} keywords="time zone timezone convert utc ist pst clock meeting">
			<div>
				<p className="wp-muted wp-small">
					Select a time on any page — “3pm PST”, “15:00 UTC”, “tomorrow 9:30 AM EST” — right-click it and WorkPulse reads it in your clock.
				</p>
			</div>

			<div className="wp-row">
				<label className="wp-label wp-small" htmlFor="wp-myzone" style={{ flex: 'none' }}>
					My zone
				</label>
				<select id="wp-myzone" className="wp-select wp-grow" value={mine} onChange={(e) => save({ myZone: e.target.value })} disabled={busy}>
					{choices.map((z) => (
						<option key={z} value={z}>
							{zoneLabel(z)} · {timeIn(now, z)}
						</option>
					))}
				</select>
			</div>

			<div className="wp-stack-sm wp-small">
				<span className="wp-eyebrow">Also show</span>
				{!others.length && <span className="wp-muted">Nobody else yet — add the zones your team sits in.</span>}
				{others.map((z) => (
					<div key={z} className="wp-between">
						<span className="wp-grow">
							<strong>{zoneLabel(z)}</strong> <span className="wp-muted">· {timeIn(now, z)} now · {zoneGap(mine, z, now)}</span>
						</span>
						<button
							className="wp-btn wp-btn-sm wp-btn-ghost"
							disabled={busy}
							title={`Stop showing ${zoneLabel(z)}`}
							aria-label={`Stop showing ${zoneLabel(z)}`}
							onClick={() => save({ otherZones: others.filter((x) => x !== z) })}
						>
							✕
						</button>
					</div>
				))}
				<div className="wp-row">
					<input
						className="wp-input wp-grow"
						list="wp-zone-list"
						placeholder="Add a zone — Europe/Berlin, EST, UTC+2"
						value={add}
						onChange={(e) => setAdd(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') addZone()
						}}
					/>
					<datalist id="wp-zone-list">
						{choices.map((z) => (
							<option key={z} value={z} />
						))}
					</datalist>
					<button className="wp-btn wp-btn-sm" disabled={busy || !add.trim()} onClick={addZone}>
						Add
					</button>
				</div>
			</div>

			{/* The same function the right-click menu runs, so this is a real check. */}
			<div className="wp-stack-sm">
				<div className="wp-row">
					<label className="wp-label wp-small" htmlFor="wp-tryit" style={{ flex: 'none' }}>
						Try one
					</label>
					<input id="wp-tryit" className="wp-input wp-grow" value={tryIt} onChange={(e) => setTryIt(e.target.value)} placeholder="3pm PST" />
				</div>
				{result ? (
					<div className="wp-card-flat wp-stack-sm wp-small">
						<span className="wp-muted">
							{result.read}
							{result.assumedZone ? ' — no zone given, read as yours' : ` in ${zoneLabel(result.from)}`}
						</span>
						{result.rows.map((r) => (
							<div key={r.zone} className="wp-between">
								<span>
									{r.mine && <span className="wp-chip wp-chip-accent">you</span>} {zoneLabel(r.zone)}
								</span>
								<strong>
									{r.time} <span className={r.otherDay ? 'wp-warn-text' : 'wp-muted'}>· {r.day}</span>
								</strong>
							</div>
						))}
					</div>
				) : (
					<span className="wp-muted wp-small">No time in that — try “3pm PST” or “15:00 UTC”.</span>
				)}
			</div>
			{error && <div className="wp-error wp-small">{error}</div>}
		</Panel>
	)

	function addZone() {
		const zone = resolveZone(add)
		if (!zone) return void run(async () => {
			throw new Error(`“${add}” is not a zone this browser knows. Try an IANA name like Europe/Berlin, an abbreviation like EST, or UTC+2.`)
		})
		setAdd('')
		save({ otherZones: [...new Set([...others, zone])].slice(0, 8) })
	}
}

/**
 * What a focus block should quietly object to.
 *
 * Nothing is blocked, ever: a blocker you can switch off is theatre, and one
 * you cannot is uninstalled at the worst possible moment. It says "you are in a
 * block, this is not it" once per site per block, and gets out of the way.
 */
/**
 * Where the keystroke lives, whether Chrome actually gave it to us, and how to
 * change it.
 *
 * The third part is the one that matters. Chrome silently refuses a suggested
 * shortcut another extension already holds, and refuses to bind anything at all
 * until the extension has been reloaded — so "⌘⇧K does nothing" is usually
 * Chrome's answer, not a bug, and the only honest thing to do is read what
 * Chrome says and show it.
 */
export function Shortcuts() {
	const [keys, setKeys] = useState<{ name?: string; shortcut?: string; description?: string }[] | null>(null)
	useEffect(() => {
		void chrome.commands?.getAll?.().then(setKeys)
	}, [])
	// Chrome reports "Alt+Shift+K" on every platform; on a Mac that key is
	// Option, and it is written ⌥. Showing someone a key by a name their
	// keyboard does not use is how a shortcut goes unused.
	const mac = navigator.platform.toLowerCase().includes('mac')
	const pretty = (s: string) => (mac ? s.replace(/Alt/g, '⌥').replace(/Shift/g, '⇧').replace(/Command|Meta/g, '⌘').replace(/Ctrl/g, '⌃').replace(/\+/g, ' ') : s)
	const bound = (name: string) => pretty(keys?.find((k) => k.name === name)?.shortcut || '')
	const missing = keys != null && (!bound('open-palette') || !bound('log-now'))

	return (
		<Panel title="Keyboard" hint={bound('open-palette') || 'not set — Chrome did not take the key'} keywords="shortcut keyboard hotkey command palette quick log spotlight not working">
			<div className="wp-stack-sm wp-small">
				<div className="wp-between">
					<span>
						<strong>The box, on any page</strong> — log, note, a to-do, find anything, file this page, start a block
					</span>
					<span className={bound('open-palette') ? 'wp-kbd' : 'wp-chip wp-chip-warn'}>{bound('open-palette') || 'not set'}</span>
				</div>
				<div className="wp-between">
					<span>
						<strong>Log the last slot</strong> — straight to the card
					</span>
					<span className={bound('log-now') ? 'wp-kbd' : 'wp-chip wp-chip-warn'}>{bound('log-now') || 'not set'}</span>
				</div>
				{mac && (
					<div className="wp-muted wp-small">
						On a Mac, <strong>Alt is Option</strong> — the <span className="wp-kbd">⌥</span> key between Control and Command. So the box is{' '}
						<span className="wp-kbd">⌥ ⇧ K</span>.
					</div>
				)}
				{missing && (
					<div className="wp-banner wp-small">
						<span className="wp-grow">
							<strong>Chrome has not given WorkPulse that key.</strong> It refuses a shortcut another extension already holds, and binds nothing at all until the
							extension has been reloaded. Set it by hand — it takes one click.
						</span>
						<button className="wp-btn wp-btn-sm" onClick={() => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}>
							Set the keys
						</button>
					</div>
				)}
				<div className="wp-muted">
					<strong>{mac ? 'Option+Shift (⌥⇧)' : 'Alt+Shift'}</strong> on purpose. <span className="wp-kbd">⌘K</span> belongs to Slack, Linear, Notion, GitHub and half the web besides — an extension
					that takes it takes it from every one of them, on every page, for ever. On WorkPulse's own pages, where it steals nothing, plain{' '}
					<span className="wp-kbd">⌘K</span> opens the same box; so does <strong>Quick actions</strong> in the sidebar, with the mouse.
				</div>
				<p className="wp-muted">
					Inside the box: <strong>Tab</strong> changes what Enter does, <strong>Enter</strong> does it, <strong>Esc</strong> closes. Typing <code>&gt;</code>,{' '}
					<code>#</code>, <code>!</code> or <code>/</code> jumps straight to logging, a learning, a to-do or a search.
				</p>
				<button className="wp-action wp-muted" onClick={() => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}>
					Change these in Chrome ↗
				</button>
			</div>
		</Panel>
	)
}

export function Strays({ settings, onPatch }: { settings: Settings; onPatch: (patch: Partial<Settings>) => Promise<void> }) {
	const list = settings.strayHosts ?? []
	const [add, setAdd] = useState('')
	const { busy, error, run } = useAction()
	const clean = (s: string) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')
	const save = (next: string[]) => run(() => onPatch({ strayHosts: [...new Set(next.map(clean).filter(Boolean))].slice(0, 40) }))

	return (
		<Panel
			title="During a focus block"
			hint={list.length ? `${list.length} sites you call a detour` : 'The usual suspects'}
			keywords="focus deep work distraction block sites reddit youtube twitter nudge detour"
		>
			<p className="wp-muted wp-small">
				Open one of these mid-block and WorkPulse says so — once per site, in the page, for a few seconds. <strong>Nothing is ever blocked.</strong> With none set it uses the
				usual suspects: {DEFAULT_STRAY.slice(0, 5).join(', ')} and a few more.
			</p>
			<div className="wp-row-wrap wp-small">
				{list.map((h) => (
					<span key={h} className="wp-chip">
						{h}
						<button className="wp-action wp-action-danger" style={{ marginLeft: 6 }} disabled={busy} onClick={() => save(list.filter((x) => x !== h))} aria-label={`Remove ${h}`}>
							✕
						</button>
					</span>
				))}
				<input
					className="wp-input wp-sm"
					style={{ width: 170 }}
					placeholder="+ news.ycombinator.com"
					value={add}
					onChange={(e) => setAdd(e.target.value)}
					onKeyDown={(e) => {
						if (e.key !== 'Enter' || !clean(add)) return
						save([...list, add])
						setAdd('')
					}}
				/>
				{!!list.length && (
					<button className="wp-action wp-muted" disabled={busy} onClick={() => save([])}>
						back to the usual suspects
					</button>
				)}
			</div>
			{error && <div className="wp-error wp-small">{error}</div>}
		</Panel>
	)
}

/**
 * Deep work on the calendar rather than on willpower.
 *
 * The people who get deep work reliably are not the ones with more discipline,
 * they are the ones for whom 10:00 on a Tuesday was already spoken for. A
 * booked block is a recurring meeting with yourself, and it behaves like one:
 * it comes round, it says so, and it is still your choice to start it.
 */
export function Blocks() {
	const { data: list, reload } = useLive(() => call('blocks'))
	const { data: ideas } = useLive(() => call('blockIdeas'))
	const [form, setForm] = useState({ time: '10:00', minutes: 90, days: [1, 2, 3, 4, 5], intent: '' })
	const { busy, error, run } = useAction()

	const save = () =>
		run(async () => {
			await call('saveBlock', form)
			setForm({ ...form, intent: '' })
			await reload()
		})

	return (
		<Panel
			title="Blocks you book in advance"
			hint={list?.length ? `${list.length} booked` : 'Deep work on the calendar, not on willpower'}
			keywords="deep work focus block book schedule recurring calendar daily concentration"
		>
			<p className="wp-muted wp-small" style={{ margin: 0 }}>
				At the minute it comes round, WorkPulse says so — once. Starting it is still your call, because a block that begins without you is a timer running in a tab you
				are not looking at.
			</p>

			{!!list?.length && (
				<div className="wp-stack-sm wp-small">
					{list.map((b) => (
						<div key={b.id} className="wp-between">
							<span className="wp-grow">
								<strong style={{ opacity: b.enabled ? 1 : 0.55 }}>
									{b.time} · {b.minutes} min
								</strong>
								<div className="wp-muted">
									{sayDays(b.days)}
									{b.intent ? ` · ${b.intent}` : ''}
								</div>
							</span>
							<span className="wp-row">
								<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => run(async () => void (await call('saveBlock', { ...b, enabled: !b.enabled }), await reload()))}>
									{b.enabled ? 'Pause' : 'Resume'}
								</button>
								<button className="wp-icon-btn" disabled={busy} title={`Delete the ${b.time} block`} aria-label={`Delete the ${b.time} block`} onClick={() => run(async () => void (await call('deleteBlock', b.id), await reload()))}>
									<Icon name="trash" size={14} />
								</button>
							</span>
						</div>
					))}
				</div>
			)}

			<div className="wp-row-wrap">
				<TimeField label="Block starts" value={form.time} onChange={(v) => v && setForm({ ...form, time: v })} width={110} />
				<select className="wp-select" style={{ width: 120 }} value={form.minutes} onChange={(e) => setForm({ ...form, minutes: Number(e.target.value) })} aria-label="How long">
					{[25, 50, 90, 120].map((m) => (
						<option key={m} value={m}>
							{m} minutes
						</option>
					))}
				</select>
				<span className="wp-row" style={{ gap: 3 }}>
					{['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
						<button
							key={i}
							className="wp-day-toggle"
							aria-pressed={form.days.includes(i + 1)}
							onClick={() => setForm({ ...form, days: form.days.includes(i + 1) ? form.days.filter((x) => x !== i + 1) : [...form.days, i + 1] })}
						>
							{d}
						</button>
					))}
				</span>
				<input className="wp-input wp-grow" style={{ minWidth: 150 }} placeholder="Usually for… (optional)" value={form.intent} onChange={(e) => setForm({ ...form, intent: e.target.value })} />
				<button className="wp-btn wp-btn-primary" disabled={busy || !form.days.length} onClick={save}>
					Book it
				</button>
			</div>
			{!!ideas?.length && (
				<span className="wp-muted wp-small">
					Today it would offer: {ideas.slice(0, 2).map((i) => i.text).join(' · ')}
				</span>
			)}
			{error && <div className="wp-error wp-small">{error}</div>}
		</Panel>
	)
}

const sayDays = (days: number[]) => {
	const sorted = [...days].sort()
	if (sorted.join() === '1,2,3,4,5') return 'Mon–Fri'
	if (sorted.length === 7) return 'every day'
	return sorted.map((d) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d - 1]).join(', ')
}

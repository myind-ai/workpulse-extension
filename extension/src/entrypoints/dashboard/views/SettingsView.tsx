// Settings: connection status (setup itself lives in Connect Zoho), the stage-1
// smoke test, write mode, schedule and jobs.

import { useEffect, useRef, useState } from 'react'

import { API_ENABLED } from '@/core/features'
import { istDate } from '@/core/time'
import type { Settings, ZohoMode } from '@/core/types'
import { call } from '@/lib/rpc'
import { useAction, useLive } from '@/ui/hooks'

import { Meetings } from './Meetings'
import { PROVIDERS, providerById } from '@/core/llm'
import { Panel } from '@/ui/Panel'
import { TrustCentre } from '@/ui/TrustCentre'

import { Backup, Support } from './Backup'
import { ClaudeCode } from './ClaudeCode'
import { Health } from './Health'
import { Blocks, Prefixes, Recall, Shortcuts, Strays, Zones } from './Zones'
import { TimeField } from '@/ui/TimeField'

const MODES: { id: ZohoMode; label: string; help: string }[] = [
	{ id: 'reminder', label: 'Reminder', help: 'Read-only. WorkPulse reminds you and opens Zoho; you click Check in and copy time logs yourself. Start here.' },
	{ id: 'timelogs', label: 'Time logs', help: 'Pushes your daily time logs to Zoho. Check-in and check-out stay manual. Needs ZOHOPEOPLE.timetracker.CREATE.' },
	{ id: 'full', label: 'Full', help: 'Also checks you in and out through the API when you click. Only after your manager or IT says API attendance is fine.' },
]
const DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
type Check = { ok: boolean; detail: string; blocked?: boolean }

export function SettingsView({ find: initialFind }: { find?: string }) {
	const { data, reload } = useLive(() => call('getSettings'))
	const { data: jobs, reload: reloadJobs } = useLive(() => call('jobs'))
	const [form, setForm] = useState<Settings | null>(null)
	const [test, setTest] = useState<Record<string, Check> | null>(null)
	const [saved, setSaved] = useState(false)
	const [clearDate, setClearDate] = useState(istDate(Date.now()))
	const [cleared, setCleared] = useState(false)
	const [restored, setRestored] = useState<number | null>(null)
	// `#/settings/backup` from the sidebar's search arrives as `find`, so landing
	// on a section and filtering to it are the same thing.
	const [find, setFind] = useState(initialFind ?? '')
	const [showing, setShowing] = useState(0)
	const page = useRef<HTMLDivElement>(null)
	const { busy, error, run } = useAction()

	useEffect(() => {
		if (data && !form) setForm(data.settings)
	}, [data, form])

	// Arriving from the sidebar while already on Settings changes only the hash,
	// so the filter has to follow it rather than being read once.
	useEffect(() => {
		if (initialFind != null) setFind(initialFind)
	}, [initialFind])

	/**
	 * Hides the sections that do not match. A section's own text is its index —
	 * nothing to keep in step with the UI — plus a few words people search for
	 * that the labels do not contain (`data-wp-keywords`). Local and instant, so
	 * no debounce: it runs on the keystroke.
	 */
	useEffect(() => {
		const q = find.trim().toLowerCase()
		const words = q.split(/\s+/).filter(Boolean)
		let shown = 0
		for (const el of page.current?.querySelectorAll<HTMLElement>('[data-wp-section]') ?? []) {
			const hay = `${el.textContent ?? ''} ${el.dataset.wpKeywords ?? ''}`.toLowerCase()
			el.hidden = words.length > 0 && !words.every((w) => hay.includes(w))
			if (!el.hidden) shown++
			// An open section stays open; a closed one opens when it is the answer.
			if (el instanceof HTMLDetailsElement && words.length && !el.hidden) el.open = true
		}
		setShowing(shown)
	}, [find, data, form])

	if (!data || !form) return <div className="wp-muted">Loading…</div>
	const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
		setForm({ ...form, [k]: v })
		setSaved(false)
	}
	const save = () =>
		run(async () => {
			setForm(await call('saveSettings', form))
			setSaved(true)
		})

	return (
		<div className="wp-stack" style={{ gap: 20, maxWidth: 760 }} ref={page}>
			<div className="wp-page-head">
				<div>
					<div className="wp-eyebrow">WorkPulse</div>
					<h1 className="wp-title">Settings</h1>
				</div>
				<div className="wp-row">
					{saved && <span className="wp-ok-text wp-small">Saved</span>}
					<button className="wp-btn wp-btn-primary" disabled={busy} onClick={save}>
						Save settings
					</button>
				</div>
			</div>
			{error && <div className="wp-error">{error}</div>}

			<div className="wp-row">
				<input
					className="wp-input wp-grow"
					placeholder="Search settings — “chime”, “break”, “backup”, “zone”…"
					value={find}
					onChange={(e) => setFind(e.target.value)}
					aria-label="Search settings"
				/>
				{!!find && (
					<button className="wp-btn wp-btn-sm wp-btn-ghost" onClick={() => setFind('')}>
						Clear
					</button>
				)}
			</div>
			{!!find.trim() && showing === 0 && <div className="wp-card wp-muted">No setting matches “{find}”.</div>}

			{API_ENABLED ? (
			<Panel title="Zoho People connection" hint="Sign in, or read your own pages instead" keywords="zoho api token oauth connect sign in">
				<div className="wp-between">
					{data.auth ? (
						<span className="wp-chip wp-chip-ok">
							<span className="wp-dot" /> Connected ({data.auth.kind === 'oauth' ? 'Sign in with Zoho' : 'Self Client'})
						</span>
					) : (
						<span className="wp-chip">Not connected — reminders still work</span>
					)}
				</div>
				<div className="wp-row-wrap">
					<a className="wp-btn wp-btn-primary" href="#/connect">
						{data.auth ? 'Reconnect or change' : 'Guided setup'} →
					</a>
					<button className="wp-btn wp-btn-soft" disabled={busy || !data.auth} onClick={() => run(async () => { setTest(await call('testConnection')); await reloadJobs() })}>
						Test connection
					</button>
					{data.auth && (
						<button className="wp-btn wp-btn-ghost wp-btn-danger" disabled={busy} onClick={() => run(async () => { await call('signOut'); setTest(null); await reload() })}>
							Disconnect
						</button>
					)}
				</div>
			</Panel>
			) : (
				<section className="wp-card wp-stack-sm" data-wp-section data-wp-keywords="zoho client id api console scopes">
					<h2 className="wp-h2">Zoho People</h2>
					<div className="wp-muted wp-small">
						WorkPulse reads and writes through the Zoho People tab you are signed in to. Set it up on{' '}
						<a className="wp-link" href="#/connect">
							Connect Zoho
						</a>
						.
					</div>
				</section>
			)}

			<Panel title="What WorkPulse may write to Zoho" hint="Reminder only, time logs, or full" keywords="zoho mode permissions write reminder timelogs full">
				<div className="wp-seg" role="group" aria-label="Zoho mode">
					{MODES.map((m) => (
						<button key={m.id} aria-pressed={form.zohoMode === m.id} onClick={() => set('zohoMode', m.id)}>
							{m.label}
						</button>
					))}
				</div>
				<div className="wp-muted">{MODES.find((m) => m.id === form.zohoMode)?.help}</div>
			</Panel>

			<Panel title="Schedule, alarms and nudges" hint="Shift times, how often you are asked, what rings" keywords="shift hours start end workdays prompt interval chime sound alarm ring break stand up learned journal schedule">
				<div className="wp-grid-3">
					<div>
						<label className="wp-label">Shift start</label>
						<TimeField label="Shift start" value={form.shiftStart} onChange={(v) => v && set('shiftStart', v)} />
					</div>
					<div>
						<label className="wp-label">Shift end</label>
						<TimeField label="Shift end" value={form.shiftEnd} onChange={(v) => v && set('shiftEnd', v)} />
					</div>
					<div>
						<label className="wp-label">Grace (minutes)</label>
						<input className="wp-input wp-num" type="number" value={form.graceMinutes} onChange={(e) => set('graceMinutes', Number(e.target.value))} />
					</div>
					<div>
						<label className="wp-label">Prompt every (minutes)</label>
						<input className="wp-input wp-num" type="number" value={form.promptInterval} onChange={(e) => set('promptInterval', Number(e.target.value))} />
					</div>
					<div>
						<label className="wp-label">Hours a day</label>
						<input className="wp-input wp-num" type="number" step="0.5" value={form.minHours} onChange={(e) => set('minHours', Number(e.target.value))} />
						<div className="wp-muted wp-small" style={{ marginTop: 4 }}>
							Once this much is written down, the hourly card stops for the day. Working on is your business — add the time whenever you like.
						</div>
					</div>
				</div>
				<div className="wp-stack-sm">
					<label className="wp-row" style={{ gap: 8 }}>
						<input type="checkbox" checked={form.sound} onChange={(e) => set('sound', e.target.checked)} />
						<span>Chime with forced reminders</span>
					</label>
					<label className="wp-row" style={{ gap: 8 }}>
						<input type="checkbox" checked={form.alarmCheckIn} disabled={!form.sound} onChange={(e) => set('alarmCheckIn', e.target.checked)} />
						<span>
							Ring when the check-in is overdue <span className="wp-muted wp-small">— once a day, and when the laptop starts</span>
						</span>
					</label>
					<label className="wp-row" style={{ gap: 8 }}>
						<input type="checkbox" checked={form.alarmCheckOut} disabled={!form.sound} onChange={(e) => set('alarmCheckOut', e.target.checked)} />
						<span>
							Ring at the end of the shift <span className="wp-muted wp-small">— so the day gets closed</span>
						</span>
					</label>
					<label className="wp-row" style={{ gap: 8 }}>
						<input type="checkbox" checked={form.learnPrompt} onChange={(e) => set('learnPrompt', e.target.checked)} />
						<span>
							Ask what you learned at the end of the day <span className="wp-muted wp-small">— once, and not at all if you have already written something</span>
						</span>
					</label>
					<label className="wp-row" style={{ gap: 8 }}>
						<input type="checkbox" checked={form.learnLoop} onChange={(e) => set('learnLoop', e.target.checked)} />
						<span>
							Tell me when a mistake keeps coming back <span className="wp-muted wp-small">— once a week, by name</span>
						</span>
					</label>
				</div>
				<div>
					<label className="wp-label">Work days</label>
					<div className="wp-row">
						{DAYS.map((d, i) => {
							const n = i + 1
							const on = form.workDays.includes(n)
							return (
								<button key={n} className="wp-day-toggle" aria-pressed={on} onClick={() => set('workDays', on ? form.workDays.filter((x) => x !== n) : [...form.workDays, n])}>
									{d}
								</button>
							)
						})}
					</div>
				</div>
			</Panel>

			{/* Saved on the spot rather than with the form: a zone is a choice, not
			    a field you fill in. The whole of settings comes back, so the form
			    above cannot overwrite it on its next save. */}
			<Backup
				settings={form}
				onPatch={async (patch) => {
					setForm(await call('saveSettings', patch))
					setSaved(false)
				}}
			/>

			<ClaudeCode
				settings={form}
				onPatch={async (patch) => {
					setForm(await call('saveSettings', patch))
					setSaved(false)
				}}
			/>

			<Health
				settings={form}
				onPatch={async (patch) => {
					setForm(await call('saveSettings', patch))
					setSaved(false)
				}}
			/>

			<Recall />

			<Prefixes
				settings={form}
				onPatch={async (patch) => {
					setForm(await call('saveSettings', patch))
					setSaved(false)
				}}
			/>

			<Shortcuts />

			<Blocks />

			<Strays
				settings={form}
				onPatch={async (patch) => {
					setForm(await call('saveSettings', patch))
					setSaved(false)
				}}
			/>

			<Zones
				settings={form}
				onPatch={async (patch) => {
					setForm(await call('saveSettings', patch))
					setSaved(false)
				}}
			/>

			<Meetings />

			{/* First, not buried: somebody wary of being watched should not have
			    to scroll past the shift times to satisfy themselves. */}
			<TrustCentre />

			<Llm />

			<Panel title="Pro" hint="What it covers, and what it deliberately does not" keywords="pro paid licence license subscription sponsor free tier upgrade key billing">
				<div className="wp-stack">
					<p className="wp-muted wp-small" style={{ margin: 0, maxWidth: 560 }}>
						WorkPulse is free and open source, and the daily loop — the card, the entry, the
						timesheet, the export — stays that way in every build. Pro covers the things that
						need something on our side: a hosted backup to write to, and a person to answer.
					</p>
					<p className="wp-muted wp-small" style={{ margin: 0, maxWidth: 560 }}>
						The long-range panels in <b>Your record</b> are Pro too, and they run regardless —
						they are arithmetic over your own data on your own machine, and withholding that
						would be theatre.
					</p>
					<div className="wp-grid-2">
						<div>
							<label className="wp-label" htmlFor="wp-licence-key">Licence key</label>
							<input
								className="wp-input"
								id="wp-licence-key"
								value={form.licenceKey}
								placeholder="Paste the key from your receipt"
								onChange={(e) => set('licenceKey', e.target.value.trim())}
							/>
							<p className="wp-muted wp-small" style={{ marginTop: 4 }}>
								Checked by the server that serves the feature, never by this extension.
							</p>
						</div>
						<div>
							<label className="wp-label" htmlFor="wp-licence-tier">Tier</label>
							<select className="wp-input" id="wp-licence-tier" value={form.licence} onChange={(e) => set('licence', e.target.value as typeof form.licence)}>
								<option value="free">Free</option>
								<option value="pro">Pro</option>
							</select>
							<p className="wp-muted wp-small" style={{ marginTop: 4 }}>
								Yes, you can set this yourself — the code is open, so pretending otherwise
								would be a lie. It stops the asking; it buys nothing that runs on our side.
							</p>
						</div>
					</div>
				</div>
			</Panel>

			<Panel title="Advanced" hint="Grace, wrap-up delay, data centre, clearing a day" keywords="advanced grace wrapup delay scopes data centre clear restore test">
				<div className="wp-stack">
					<div className="wp-grid-2">
						<div>
							<label className="wp-label">Grace before the check-in is forced (minutes)</label>
							<input className="wp-input wp-num" type="number" value={form.graceMinutes} onChange={(e) => set('graceMinutes', Number(e.target.value))} />
						</div>
						<div>
							<label className="wp-label">Wrap-up delay after shift end (minutes)</label>
							<input className="wp-input wp-num" type="number" value={form.wrapupDelay} onChange={(e) => set('wrapupDelay', Number(e.target.value))} />
						</div>
					</div>
					<div>
						<label className="wp-label">Zoho attendance page (opened by reminders)</label>
						<input className="wp-input" value={form.attendanceUrl} onChange={(e) => set('attendanceUrl', e.target.value)} />
						<div className="wp-muted wp-small">Set it in one click from Connect Zoho, or paste it here.</div>
					</div>

					{API_ENABLED && (
						<div className="wp-row-wrap">
							<button className="wp-btn wp-btn-soft" disabled={busy || !data.auth} onClick={() => run(async () => { setTest(await call('testConnection')); await reloadJobs() })}>
								Test the connection
							</button>
							{data.auth && (
								<button className="wp-btn wp-btn-ghost" disabled={busy} onClick={() => run(async () => { await call('signOut'); setTest(null); await reload() })}>
									Disconnect Zoho
								</button>
							)}
						</div>
					)}
					{test && (
						<div className="wp-card-flat wp-stack-sm wp-small">
							{Object.entries({ "Today's attendance": test.attendance, Jobs: test.jobs, 'Month report': test.report }).map(([k, v]) => (
								<div key={k} className="wp-between">
									<span>{k}</span>
									<span className={v.ok ? 'wp-ok-text' : v.blocked ? 'wp-muted' : 'wp-error'}>{v.detail}</span>
								</div>
							))}
						</div>
					)}

			<Panel title="Jobs and billing" hint="The Zoho job each entry is logged against" keywords="job project billable non-billable default refresh cache">
				<div className="wp-between">
					{API_ENABLED && (
						<button className="wp-btn wp-btn-sm" disabled={busy || !data.auth} onClick={() => run(async () => { await call('jobs', true); await reloadJobs() })}>
							Refresh jobs
						</button>
					)}
				</div>
				<div className="wp-grid-2">
					<div>
						<label className="wp-label">Default job</label>
						<select className="wp-select" value={form.defaultJobId} onChange={(e) => set('defaultJobId', e.target.value)}>
							<option value="">None</option>
							{(jobs ?? []).map((j) => (
								<option key={j.id} value={j.id}>
									{j.name}
								</option>
							))}
						</select>
					</div>
					<div>
						<label className="wp-label">Billing status for time logs</label>
						<select className="wp-select" value={form.billingStatus} onChange={(e) => set('billingStatus', e.target.value as Settings['billingStatus'])}>
							<option value="non-billable">Non-billable</option>
							<option value="billable">Billable</option>
						</select>
					</div>
				</div>
				<div className="wp-muted wp-small">{jobs?.length ? `${jobs.length} jobs cached from Zoho.` : 'No jobs cached yet. Connect Zoho and refresh.'}</div>
			</Panel>
					<div className="wp-stack-sm">
						<h3 className="wp-h2">Back up before a reinstall</h3>
						<div className="wp-muted wp-small">
							Removing the extension erases everything it knows, even if you install the same version again. Save a copy first, then load it back afterwards.
						</div>
						<div className="wp-row-wrap">
							<button
								className="wp-btn wp-btn-soft"
								disabled={busy}
								onClick={() =>
									run(async () => {
										const dump = await call('exportData')
										const url = URL.createObjectURL(new Blob([JSON.stringify(dump, null, 1)], { type: 'application/json' }))
										const a = document.createElement('a')
										a.href = url
										a.download = `workpulse-backup-${istDate(Date.now())}.json`
										a.click()
										URL.revokeObjectURL(url)
									})
								}
							>
								Save a backup
							</button>
							<label className="wp-btn" style={{ cursor: 'pointer' }}>
								Load a backup
								<input
									type="file"
									accept="application/json"
									hidden
									onChange={(e) => {
										const file = e.target.files?.[0]
										e.target.value = ''
										if (!file) return
										void run(async () => {
											const n = await call('importData', await file.text())
											setRestored(n)
											await reload()
										})
									}}
								/>
							</label>
							{restored != null && <span className="wp-ok-text wp-small">Restored {restored} records — reopen the dashboard.</span>}
						</div>
					</div>

					<div className="wp-stack-sm">
						<h3 className="wp-h2">Start over on a day</h3>
						<div className="wp-muted wp-small">Clears that day's entries, check-in and check-out from WorkPulse. Nothing in Zoho is touched.</div>
						<div className="wp-row">
							<input className="wp-input wp-num" style={{ width: 150 }} value={clearDate} onChange={(e) => setClearDate(e.target.value)} aria-label="Date to clear" />
							<button
								className="wp-btn wp-btn-ghost"
								disabled={busy || !/^\d{4}-\d{2}-\d{2}$/.test(clearDate)}
								onClick={() => run(async () => { await call('clearDay', clearDate); setCleared(true) })}
							>
								{cleared ? 'Cleared' : 'Clear that day'}
							</button>
						</div>
					</div>
				</div>
			</Panel>

			<Support />
		</div>
	)
}


/**
 * Where the model runs, and whose bill it is.
 *
 * Deliberately not a list of blessed vendors: almost everything speaks the
 * OpenAI chat shape now, so anything with an address works — including a model
 * on this machine, which is the only arrangement where the text never leaves
 * at all. The key lives under its own storage key, never in settings, so it is
 * not exported, not shown in a backup, and not in the file you send a colleague.
 */
function Llm() {
	const { data: st, reload } = useLive(() => call('llmState'))
	const { data: s } = useLive(() => call('state'))
	const [key, setKey] = useState('')
	const [said, setSaid] = useState('')
	const { busy, error, run } = useAction()
	if (!st || !s) return null

	const p = providerById(st.provider)
	const set = (patch: Partial<Settings>) =>
		run(async () => {
			await call('saveSettings', patch)
			setSaid('')
			await reload()
		})

	return (
		<Panel title="AI — your key, your account" hint="Bring any model: OpenRouter, Anthropic, OpenAI, Together, Groq, or one on this machine" keywords="ai llm model api key openrouter anthropic openai together groq ollama lm studio local byok bring your own key">
			<div className="wp-stack">
				<p className="wp-muted wp-small" style={{ margin: 0, maxWidth: 580 }}>
					WorkPulse never ships a model and never relays a request. The key is yours, the
					account is yours, and the bill is yours — which is the only arrangement that keeps
					the promise the rest of the app makes, because the most sensitive text in here is
					what you did and what you got wrong.
				</p>

				<div className="wp-grid-2">
					<div>
						<label className="wp-label" htmlFor="wp-llm-p">Where the model runs</label>
						<select
							className="wp-input"
							id="wp-llm-p"
							value={st.provider}
							onChange={(e) => {
								const next = providerById(e.target.value)
								// Carry the suggested model across, so the first run works
								// without anybody having to go and look one up.
								void set({ llmProvider: e.target.value, llmModel: next?.suggested ?? '', llmBaseUrl: '' })
							}}
						>
							<option value="">Not set up</option>
							{PROVIDERS.map((x) => (
								<option key={x.id} value={x.id}>
									{x.label}
								</option>
							))}
						</select>
					</div>
					<div>
						<label className="wp-label" htmlFor="wp-llm-m">Model</label>
						<input className="wp-input" id="wp-llm-m" value={st.model} placeholder={p?.suggested || 'the model name'} onChange={(e) => void set({ llmModel: e.target.value })} />
					</div>
				</div>

				{(st.provider === 'custom' || st.baseUrl) && (
					<div>
						<label className="wp-label" htmlFor="wp-llm-u">Address</label>
						<input className="wp-input" id="wp-llm-u" value={st.baseUrl} placeholder={p?.baseUrl || 'http://localhost:11434/v1'} onChange={(e) => void set({ llmBaseUrl: e.target.value })} />
					</div>
				)}

				{!p?.local && (
					<div>
						<label className="wp-label" htmlFor="wp-llm-k">
							Key {st.hasKey ? <span className="wp-ok-text">· saved</span> : null}
						</label>
						<div className="wp-row">
							<input
								className="wp-input wp-grow"
								id="wp-llm-k"
								type="password"
								value={key}
								placeholder={st.hasKey ? 'Saved. Paste a new one to replace it.' : p ? `From ${p.keyFrom}` : 'Pick a provider first'}
								onChange={(e) => setKey(e.target.value)}
							/>
							<button
								className="wp-btn wp-btn-sm"
								disabled={busy || !key.trim()}
								onClick={() => run(async () => void (await call('saveLlmKey', key), setKey(''), setSaid('Saved on this machine.'), await reload()))}
							>
								Save
							</button>
							{st.hasKey && (
								<button className="wp-action wp-muted" disabled={busy} onClick={() => run(async () => void (await call('saveLlmKey', ''), setSaid('Removed.'), await reload()))}>
									Remove
								</button>
							)}
						</div>
					</div>
				)}

				{/* The same sentence every AI surface shows, so the arrangement is
				    never a surprise at the moment somebody presses a button. */}
				<p className={p?.local ? 'wp-ok-text wp-small' : 'wp-muted wp-small'} style={{ margin: 0 }}>
					{st.where}
				</p>

				<div className="wp-row">
					<button className="wp-btn wp-btn-sm" disabled={busy || !!st.problem} onClick={() => run(async () => setSaid(`It answered: “${(await call('testLlm')).said}”`))}>
						Test it
					</button>
					{st.problem && <span className="wp-muted wp-small">{st.problem}</span>}
					{said && <span className="wp-ok-text wp-small">{said}</span>}
				</div>
				{error && <span className="wp-error wp-small">{error}</span>}
			</div>
		</Panel>
	)
}

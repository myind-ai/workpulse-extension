// How WorkPulse reads your Zoho. The ordinary way is one button and a minute of
// using Zoho normally; the technical way — pasting the calls by hand — lives
// under Advanced, because nobody should need DevTools to track their own hours.

import { useState } from 'react'

import { call } from '@/lib/rpc'
import { copyText, useAction, useLive } from '@/ui/hooks'
import { Icon } from '@/ui/Icon'
import { PasteCall } from '@/ui/PasteCall'
import { Art } from '@/ui/Art'

/** Said in terms of what you get, not which request it came from. */
const ABILITIES: { key: 'attendance' | 'tasks' | 'save' | 'logged'; title: string; why: string }[] = [
	{ key: 'attendance', title: 'See when you check in', why: 'Reminders stop once Zoho shows you are in.' },
	{ key: 'tasks', title: 'Know your projects and tasks', why: 'The hourly card offers real names instead of a blank box.' },
	{ key: 'save', title: 'Send your time logs', why: 'The timesheet fills itself at the end of the day.' },
	{ key: 'logged', title: 'See what Zoho already has', why: 'Stops the same hour being logged twice.' },
]

const short = (url: string) => {
	try {
		const u = new URL(url)
		return u.pathname + (u.search ? `?${u.searchParams.toString().slice(0, 60)}` : '')
	} catch {
		return url
	}
}

const clock = (at?: number) => (at ? new Date(at).toLocaleTimeString() : '')

export function PageSourcePanel() {
	const { data, reload } = useLive(() => call('pageState'))
	const { data: wiring, reload: reloadWiring } = useLive(() => call('wiring'))
	const { busy, error, run } = useAction()
	const [watching, setWatching] = useState(false)
	if (!data) return null

	const ready = ABILITIES.filter((a) => wiring?.[a.key]).length
	const refresh = async () => {
		await reload()
		await reloadWiring()
	}

	return (
		<section className="wp-card wp-stack">
			<div className="wp-between">
				<h2 className="wp-h2">How WorkPulse reads your Zoho</h2>
				<span className={ready === ABILITIES.length ? 'wp-chip wp-chip-ok' : 'wp-chip'}>
					{ready === ABILITIES.length && <span className="wp-dot" />} {ready} of {ABILITIES.length} ready
				</span>
			</div>

			<div className="wp-muted wp-small">
				It works from the Zoho People tab you are already signed in to — no admin, no password, nothing leaves your browser. It only needs to watch Zoho once, to
				learn where things are.
			</div>

			{/* The ordinary path: press the button, use Zoho for a minute. */}
			{!watching ? (
				<div className="wp-row-wrap">
					<button
						className="wp-btn wp-btn-primary wp-btn-lg wp-row"
						disabled={busy}
						onClick={() =>
							run(async () => {
								// Asked for here, from your click, rather than at install: watching
								// Zoho's own requests is the only thing that needs it.
								const granted = await chrome.permissions.request({ permissions: ['webRequest'] }).catch(() => false)
								if (!granted) throw new Error('WorkPulse needs permission to watch Zoho’s own requests for a minute. You can also set it up by hand under Advanced.')
								await call('startAutoSetup')
								setWatching(true)
							})
						}
					>
						<Icon name="play" /> {ready ? 'Set up the rest for me' : 'Set it up for me'}
					</button>
					<span className="wp-muted wp-small">Opens Zoho People and watches for a minute.</span>
				</div>
			) : (
				<div className="wp-card-flat wp-stack-sm">
					<strong>Now, in the Zoho tab that just opened:</strong>
					<ol className="wp-small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
						<li>
							Open <strong>Attendance</strong> and let it load.
						</li>
						<li>
							Open <strong>Time Logs</strong> (Time Tracker → My Time Logs).
						</li>
						<li>If you can, save one time-log row by hand — that is what teaches it to send yours.</li>
					</ol>
					<div className="wp-row-wrap">
						<button
							className="wp-btn wp-btn-primary"
							disabled={busy}
							onClick={() =>
								run(async () => {
									await call('stopRecording')
									setWatching(false)
									await refresh()
								})
							}
						>
							I have done that
						</button>
						<span className="wp-muted wp-small">Watching — nothing is sent anywhere.</span>
					</div>
				</div>
			)}

			<div className="wp-card-flat wp-stack-sm wp-small">
				{ABILITIES.map((a) => (
					<div key={a.key} className="wp-between">
						<span className="wp-grow" style={{ minWidth: 0 }}>
							<strong>{a.title}</strong>
							<div className="wp-muted">{a.why}</div>
						</span>
						{wiring?.[a.key] ? (
							<span className="wp-chip wp-chip-ok">
								<span className="wp-dot" /> ready
							</span>
						) : (
							<span className="wp-chip">not yet</span>
						)}
					</div>
				))}
			</div>

			{data.read && (
				<div className="wp-between wp-small">
					<span className="wp-muted">
						Last check at {clock(data.read.at)}: {data.read.data.firstIn ? `in at ${data.read.data.firstIn}` : 'no check-in found'}
					</span>
					<button className="wp-action" disabled={busy} onClick={() => run(async () => void (await call('readZohoPage'), await refresh()))}>
						check again
					</button>
					{busy && <Art name="reading" size={48} delay={400} />}
				</div>
			)}

			{/* Everything below is for when the button above cannot manage it. */}
			<details>
				<summary className="wp-small wp-muted" style={{ cursor: 'pointer' }}>
					Advanced — set it up by hand
				</summary>
				<div className="wp-stack-sm" style={{ marginTop: 12 }}>
					<div className="wp-muted wp-small">
						In Zoho, open DevTools (⌥⌘I) → <strong>Network</strong>, do the thing you want WorkPulse to learn, right-click the request →{' '}
						<strong>Copy as cURL</strong>, and paste it here. Cookies in the paste are thrown away.
					</div>
					<PasteCall onAdded={() => void refresh()} />

					{!!data.seen.length && (
						<details>
							<summary className="wp-small wp-muted" style={{ cursor: 'pointer' }}>
								{data.seen.length} call{data.seen.length === 1 ? '' : 's'} WorkPulse has seen
							</summary>
							<div className="wp-stack-sm" style={{ marginTop: 10 }}>
								{data.seen.slice(0, 20).map((s) => (
									<div key={`${s.method} ${s.url} ${s.body ?? ''}`} className="wp-row wp-small">
										<span className="wp-muted" style={{ width: 44, flex: 'none' }}>
											{s.method}
										</span>
										<span
											className="wp-grow"
											style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
											title={`${s.url}\n${s.body ?? ''}`}
										>
											{short(s.url)}
										</span>
									</div>
								))}
								<div className="wp-row-wrap">
									<button className="wp-action" onClick={() => void copyText(data.seen.map((s) => `${s.method} ${s.url}${s.body ? `\n  ${s.body}` : ''}`).join('\n'))}>
										Copy the list
									</button>
									<button className="wp-action" disabled={busy} onClick={() => run(async () => void (await call('forgetCalls'), await refresh()))}>
										Forget them and start again
									</button>
								</div>
							</div>
						</details>
					)}

					{data.last && (
						<div className="wp-card-flat wp-small">
							<div className="wp-between">
								<span className="wp-muted">{short(data.last.url)}</span>
								<span className={data.last.ok ? 'wp-ok-text' : 'wp-error'}>HTTP {data.last.status}</span>
							</div>
							<pre className="wp-num" style={{ margin: '6px 0 0', maxHeight: 120, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
								{data.last.body.slice(0, 600) || '(empty reply)'}
							</pre>
						</div>
					)}
				</div>
			</details>

			{error && <div className="wp-error">{error}</div>}
		</section>
	)
}

// A team, which is one private repository everyone on it can write to.
//
// There is no server and no account: the repository is the team. That is what
// makes the privacy answer short — a private repository is a private team, and
// anyone can read exactly what is shared by opening it on GitHub.

import { useEffect, useState } from 'react'

import { ago } from '@/core/links'

import { fmtMinutes } from '@/core/time'
import { call } from '@/lib/rpc'
import { Busy } from '@/ui/Busy'
import { ConfirmButton } from '@/ui/Confirm'
import { Icon } from '@/ui/Icon'
import { copyText, useAction, useLive } from '@/ui/hooks'
import { Art } from '@/ui/Art'


export function TeamView() {
	return <TeamHome />
}

function TeamHome() {
	const { data, reload } = useLive(() => call('teamState'))
	const [repo, setRepo] = useState<string | null>(null)
	const [checked, setChecked] = useState<{ repo: string; private: boolean; canWrite: boolean; login: string } | null>(null)
	const [said, setSaid] = useState('')
	const { busy, error, run } = useAction()
	if (!data) return <div className="wp-muted">Loading…</div>

	const save = (patch: Parameters<typeof call<'saveSettings'>>[1]) =>
		run(async () => {
			await call('saveSettings', patch)
			await reload()
		})

	const connect = () =>
		run(async () => {
			await call('saveSettings', { teamRepo: (repo ?? data.repo).trim() })
			setChecked(await call('checkTeam'))
			await reload()
		})

	return (
		<div className="wp-stack">
			<header className="wp-page-head">
				<div>
					<span className="wp-eyebrow">Together, still private</span>
					<h1 className="wp-h1">Your team</h1>
					<p className="wp-muted wp-small" style={{ maxWidth: 560, margin: 0 }}>
						One private GitHub repository the team can all write to. Each person writes their own file; everyone reads the others'. No server, no accounts, nothing
						running anywhere — and you can see every byte of it on GitHub.
					</p>
				</div>
				<Art name="empty-team" size={88} />
			</header>

			<section className="wp-card wp-stack">
				<h2 className="wp-h2">The shared repository</h2>
				<div className="wp-row">
					<input className="wp-input wp-grow" placeholder="owner/team-repo" value={repo ?? data.repo} onChange={(e) => setRepo(e.target.value)} />
					<button className="wp-btn wp-btn-primary" disabled={busy || !(repo ?? data.repo).trim()} onClick={connect}>
						<Busy busy={busy} doing="Checking GitHub…">{data.repo ? 'Check again' : 'Connect'}</Busy>
					</button>
				</div>
				<div className="wp-muted wp-small">
					It uses the same token as your backup, so there is nothing new to create — the token needs <strong>Contents</strong> and <strong>Issues: Read and write</strong> on
					this repository. {!data.hasToken && <a href="#/settings/backup">Add the token first →</a>}
				</div>
				{checked && (
					<div className={checked.canWrite ? 'wp-card-flat wp-stack-sm' : 'wp-error'}>
						<div>
							<strong>{checked.repo}</strong> · {checked.private ? 'private' : 'public — anyone can read what you share'} · {checked.canWrite ? 'you can write to it' : 'the token cannot write to it'}
						</div>
						{checked.login && <div className="wp-muted wp-small">You appear as {checked.login}.</div>}
					</div>
				)}
			</section>

			{!!data.repo && (
				<>
					{/* The board is what anyone opens this page for; the switches are
					    set once and then in the way. */}
					<Board />

					<details className="wp-card">
						<summary className="wp-h2" style={{ cursor: 'pointer' }}>
							What the others see{' '}
							<span className="wp-muted wp-small" style={{ fontWeight: 400 }}>
								· {[data.shareHours && 'hours', data.shareWhat && 'tickets', data.shareLearnings && 'learnings'].filter(Boolean).join(', ') || 'nothing yet'}
								{data.at ? ` · shared ${new Date(data.at).toLocaleDateString()}` : ''}
							</span>
						</summary>
						<div className="wp-stack" style={{ marginTop: 14 }}>
						<p className="wp-muted wp-small" style={{ margin: 0 }}>
							Everything is off until you turn it on, and each of these is a different question. Nothing else leaves — not your notes, not your links, not your
							settings, not your Zoho anything.
						</p>
						<Toggle on={data.shareHours} label="The hours I logged" hint="Minutes a day, and when I checked in and out." onPick={(v) => save({ shareHours: v })} />
						<Toggle on={data.shareWhat} label="What I worked on" hint="Grouped by ticket — PAY-2433, 5h — not the sentences I wrote." onPick={(v) => save({ shareWhat: v })} />
						<Toggle on={data.shareLearnings} label="My learnings" hint="The lines I wrote about what I learned or got wrong." onPick={(v) => save({ shareLearnings: v })} />
						<Toggle
							on={data.pageNotes}
							label="Notes left on a page"
							hint="Right-click any page to raise an issue about it, with a screenshot. Everyone on the team sees it when they open that page."
							onPick={(v) => save({ pageNotes: v })}
						/>
						<div className="wp-row-wrap">
							<input className="wp-input" style={{ maxWidth: 220 }} placeholder="How I appear" defaultValue={data.member} onBlur={(e) => e.target.value !== data.member && save({ teamMember: e.target.value })} />
							<button
								className="wp-btn"
								disabled={busy}
								title="It also goes up on its own, once a day, when you close the day"
								onClick={() =>
									run(async () => {
										const r = await call('pushTeam')
										setSaid(`Shared ${r.days} day${r.days === 1 ? '' : 's'} — ${r.shared.join(', ')}.`)
										await reload()
									})
								}
							>
								<Busy busy={busy} doing="Sharing…">Share now</Busy>
							</button>
							<ConfirmButton
								label="Leave the team"
								question="Your file stays in the repository until someone deletes it. Nothing more will be shared from here."
								confirmLabel="Leave"
								disabled={busy}
								onConfirm={() => run(async () => void (await call('leaveTeam'), await reload()))}
							/>
						</div>
						{said && <div className="wp-ok-text wp-small">{said}</div>}
						{data.error && <div className="wp-error wp-small">{data.error}</div>}
						<span className="wp-muted wp-small">
							It goes up on its own once a day, when you close the day — the same moment the backup runs. Nothing is shared before that.
						</span>
						</div>
					</details>

					<Invite repo={data.repo} />
					<Notes />
				</>
			)}
			{error && <div className="wp-error">{error}</div>}
		</div>
	)
}

function Toggle({ on, label, hint, onPick }: { on: boolean; label: string; hint: string; onPick: (v: boolean) => void }) {
	return (
		<label className="wp-area" style={{ cursor: 'pointer' }}>
			<input type="checkbox" checked={on} onChange={(e) => onPick(e.target.checked)} />
			<span>
				<strong>{label}</strong>
				<div className="wp-muted wp-small">{hint}</div>
			</span>
		</label>
	)
}

/**
 * Getting the rest of the team on it.
 *
 * The hard half of a shared repository is not the repository, it is telling
 * four people the same three things without typing it four times.
 */
function Invite({ repo }: { repo: string }) {
	const [copied, setCopied] = useState(false)
	const text = [
		`We are keeping our WorkPulse team board in ${repo} — it is a private GitHub repo, nothing else involved.`,
		'',
		`1. Accept the invite to ${repo} on GitHub.`,
		'2. In WorkPulse: Team → paste ' + repo + ' → Connect.',
		'3. Choose what you want the rest of us to see. Everything is off until you turn it on, and it stays off.',
		'',
		'It shares one file a day, with only what you picked. Nothing else leaves your machine.',
	].join('\n')

	return (
		<details className="wp-card">
			<summary className="wp-h2" style={{ cursor: 'pointer' }}>
				Getting the others on it <span className="wp-muted wp-small" style={{ fontWeight: 400 }}>· three steps, written for you</span>
			</summary>
			<div className="wp-stack-sm" style={{ marginTop: 12 }}>
				<ol className="wp-small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
					<li>
						On GitHub, invite them to <strong>{repo}</strong> — Settings → Collaborators.
					</li>
					<li>They paste the same name into Team here and press Connect.</li>
					<li>They choose what to share. Everything is off until each person turns it on.</li>
				</ol>
				<div className="wp-card-flat wp-small" style={{ whiteSpace: 'pre-wrap' }}>{text}</div>
				<div className="wp-row">
					<button
						className="wp-btn wp-btn-sm"
						onClick={async () => {
							await copyText(text)
							setCopied(true)
							setTimeout(() => setCopied(false), 1500)
						}}
					>
						{copied ? 'Copied' : 'Copy the message'}
					</button>
					<a className="wp-btn wp-btn-sm wp-btn-ghost" href={`https://github.com/${repo}/settings/access`} target="_blank" rel="noreferrer">
						Invite them on GitHub ↗
					</a>
				</div>
			</div>
		</details>
	)
}

/** The team's day: who logged what, and the day added up by ticket. */
function Board() {
	const [date, setDate] = useState<string | undefined>(undefined)
	const { data, error, reload } = useLive(() => call('teamBoard', date), [date])
	const [polled, setPolled] = useState<number | null>(null)
	const { busy, run } = useAction()

	// While the board is on screen it is worth keeping current: one request a
	// minute that usually answers "nothing moved" and costs nothing more.
	useEffect(() => {
		let live = true
		const read = async () => {
			const r = await call('pollTeam').catch(() => null)
			if (!live || !r) return
			setPolled(r.at)
			if (r.changed.length) await reload()
		}
		void read()
		const every = setInterval(read, 60_000)
		return () => {
			live = false
			clearInterval(every)
		}
	}, [])
	if (error) return <div className="wp-card wp-error">{error}</div>
	if (!data) return <div className="wp-card wp-muted">Reading the team…</div>
	if (!data.rows.length) return <div className="wp-card wp-muted">Nobody has shared anything yet. Press <strong>Share now</strong> above, and ask the others to do the same.</div>

	return (
		<section className="wp-card wp-stack-sm">
			<div className="wp-between">
				<h2 className="wp-h2">The team's day</h2>
				<input className="wp-input wp-sm" type="date" value={data.date} onChange={(e) => setDate(e.target.value)} style={{ maxWidth: 160 }} />
			</div>
			<div className="wp-muted wp-small">
				{data.totals.logged} of {data.totals.people} shared something · {fmtMinutes(data.totals.minutes)} between them
				{!!data.totals.tickets.length && ` · busiest: ${data.totals.tickets[0].label}`}
			</div>
			<div className="wp-timeline">
				{data.rows.map((r) => (
					<div key={r.member} className="wp-tl-item">
						<span>
							<strong>{r.member}</strong>
							{r.you && <span className="wp-muted"> (you)</span>}
						</span>
						<span style={{ minWidth: 0 }}>
							{r.quiet ? (
								<span className="wp-muted">Nothing shared for this day.</span>
							) : (
								<>
									{r.lines.map((l) => (
										<span key={l.label} className="wp-chip" style={{ marginRight: 6 }}>
											{l.label} {fmtMinutes(l.minutes)}
										</span>
									))}
									{!!r.learnings.length && <div className="wp-muted wp-small">{r.learnings.map((l) => l.text).join(' · ')}</div>}
								</>
							)}
						</span>
						<span className="wp-muted">{r.minutes != null ? fmtMinutes(r.minutes) : r.in ? `${r.in}–${r.out ?? '…'}` : ''}</span>
					</div>
				))}
			</div>
		</section>
	)
}

/** Notes the team has left on pages, newest first. */
function Notes() {
	const { data: state } = useLive(() => call('teamState'))
	const [n, setN] = useState(0)
	const { busy, run } = useAction()
	if (!state?.pageNotes) return null
	return (
		<section className="wp-card wp-stack-sm">
			<div className="wp-between">
				<h2 className="wp-h2">Notes on pages</h2>
				<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => run(async () => setN(await call('refreshNotes')))}>
					<Busy busy={busy} doing="Reading GitHub…">Catch up on the team’s notes</Busy>
				</button>
			</div>
			<p className="wp-muted wp-small" style={{ margin: 0 }}>
				Notes live on <a className="wp-link" href="#/notes">your own page</a> first — nothing is shared until you press <strong>Share with the team</strong> on one. Shared
				ones become issues in this repository, and anyone who opens that page sees them. {n > 0 && <strong>{n} found.</strong>}
			</p>
		</section>
	)
}

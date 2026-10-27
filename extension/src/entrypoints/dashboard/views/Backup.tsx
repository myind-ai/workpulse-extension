// Setting up the backup, in the order GitHub's permissions actually require:
// the repository has to exist before a token can be scoped to it. Each step
// opens the right GitHub page already filled in — you are signed in there — and
// the step the wizard shows is worked out from what is true, not from a counter.

import { useEffect, useState } from 'react'

import { newRepoUrl, parseRepo, setupStep, TOKEN_URL, type SetupStep } from '@/core/sync'
import type { Settings } from '@/core/types'
import { call } from '@/lib/rpc'
import { ConfirmButton } from '@/ui/Confirm'
import { Busy } from '@/ui/Busy'
import { useAction, useLive } from '@/ui/hooks'
import { Panel } from '@/ui/Panel'

import { SOURCE_URL, SPONSOR_URL } from './Support'
import { TimeField } from '@/ui/TimeField'
import { Art } from '@/ui/Art'

type Patch = (patch: Partial<Settings>) => Promise<void>

export function Backup({ settings, onPatch }: { settings: Settings; onPatch: Patch }) {
	const { data: state, reload } = useLive(() => call('syncState'))
	const [name, setName] = useState('workpulse-notes')
	const [token, setToken] = useState('')
	const [repos, setRepos] = useState<{ full_name: string; private: boolean }[] | null>(null)
	const [said, setSaid] = useState('')
	const [open, setOpen] = useState(false)
	// Not persisted on purpose: it only moves the wizard on. Step 3 is what
	// actually confirms the repository exists, against GitHub's own list.
	const [madeRepo, setMadeRepo] = useState(false)
	const { busy, error, run } = useAction()

	// As soon as there is a token, the list it can reach is fetched — an empty
	// box and a button called "List mine" is a question nobody can answer.
	useEffect(() => {
		if (!state?.hasToken || repos || state.repo) return
		void call('githubRepos')
			.then((r) => setRepos(r.repos))
			.catch(() => setRepos([]))
	}, [state?.hasToken, state?.repo, repos])

	if (!state) return <div className="wp-card wp-muted">Loading…</div>

	const step: SetupStep = setupStep({ madeRepo, hasToken: state.hasToken, repo: state.repo, lastPushAt: state.at })
	const done = step === 'done'

	const saveToken = () =>
		run(async () => {
			await call('saveSyncToken', token)
			setToken('')
			const r = await call('githubRepos')
			setRepos(r.repos)
			if (!r.repos.length) {
				setSaid('')
				throw new Error('That token works, but it cannot write to any repository. On the token page, check it lists your repository and has Contents: Read and write.')
			}
			// A token scoped to one repository has already answered the question.
			// Asking "shall we use the only repository you allowed?" is a dialog
			// with one answer — so it is chosen, said out loud, and changeable on
			// the screen that follows.
			const only = r.repos.length === 1 ? r.repos[0] : null
			if (only) {
				await onPatch({ syncRepo: only.full_name })
				setSaid(`Backing up to ${only.full_name}${only.private ? ' (private)' : ''} — the only repository this token can write to. Change it below if that is wrong.`)
			} else {
				setSaid(`Token accepted${r.login ? ` for ${r.login}` : ''} — ${r.repos.length} repositories to choose from.`)
			}
			await reload()
		})

	const pick = (full: string) =>
		run(async () => {
			await onPatch({ syncRepo: full })
			setSaid(`Backing up to ${full}.`)
			await reload()
		})

	const backUpNow = () =>
		run(async () => {
			const r = await call('pushBackup')
			setSaid(
				r.pushed
					? `Saved ${r.pushed} file${r.pushed === 1 ? '' : 's'} to ${state.repo}${r.skipped ? ` · ${r.skipped} unchanged, so they were left alone` : ''}.`
					: 'Nothing had changed since the last backup, so nothing was written.',
			)
			await reload()
		})

	return (
		<Panel
			title="Backup to your own GitHub repository"
			hint={done ? `${state.repo} · last backup ${state.at ? new Date(state.at).toLocaleDateString() : '—'}` : 'Not set up — four steps, about two minutes'}
			keywords="backup github repository token sync private local export restore"
			open={!done}
			right={done ? <span className="wp-chip wp-chip-ok">On</span> : undefined}
		>
			<div className="wp-between">
				<div>
					<p className="wp-muted wp-small" style={{ marginBottom: 0 }}>
						Your learnings, tickets and time logs, written once a day to a repository you own. No account with us and no server of ours — if you stop using WorkPulse the
						repository is still yours and still readable.
					</p>
				</div>
			</div>

			{/* The three things people reasonably want to know before pasting a
			    token into anything. Said before the first step, not buried under it. */}
			<ul className="wp-assure">
				<li>
					<strong>One repository, and only that one.</strong> The token is scoped to the single repository you pick. WorkPulse cannot see, read or write any of your other
					repositories, your account, or anything else on GitHub — and it never asks for more.
				</li>
				<li>
					<strong>Private is fine, and what we suggest.</strong> The button below creates it private. A private repository works exactly the same: GitHub's API does not care,
					and nobody but you can read it.
				</li>
				<li>
					<strong>Everything stays on this computer.</strong> WorkPulse has no server. Nothing is sent anywhere except the files you can see in your own repository. The token is
					stored on this machine, separately from your settings — never shown again, never exported, never written into the backup, and only ever sent to api.github.com.
				</li>
				<li>
					<strong>One commit a day, on one branch (<code>brain</code> unless you change it).</strong> Not a branch and a merge per day — that would be 365 branches and 365 merge commits for no extra
					information. The day-by-day record is a file per day in <code>days/</code>, so the repository reads as a diary without reading git history, and the commit message
					carries the date and the day's note.
				</li>
				<li>
					<strong>Stopping is one click.</strong> Clear the repository here and nothing more is written; revoke the token on GitHub and WorkPulse loses its access entirely.
					What is already in the repository stays yours.
				</li>
			</ul>

			{done ? (
				<div className="wp-stack-sm">
					{/* The one screen that says the whole arrangement back to you, so
					    nothing about it has to be taken on trust. */}
					<div className="wp-assure" style={{ background: 'var(--wp-ok-soft)', borderColor: 'transparent' }}>
						<span>
							<strong>You are backed up.</strong> Everything WorkPulse knows is in{' '}
							<a className="wp-link" href={`https://github.com/${state.repo}`} target="_blank" rel="noreferrer">
								{state.repo}
							</a>
							, inside <code>{state.path || 'workpulse'}/</code>.
						</span>
						<span>
							<strong>From now on</strong> it writes itself {settings.syncDaily ? `once a day — when you check out, or by ${settings.syncAfter}` : 'only when you press Back up now'}. One
							commit, only the files that changed, nothing else sent anywhere.
						</span>
						<span>
							<strong>To stop</strong>, clear the repository below or revoke the token on GitHub. What is already there stays yours.
						</span>
					</div>

					<div className="wp-between wp-small">
						<span>
							<strong>{state.repo}</strong>
							<span className="wp-muted"> · {state.path || 'workpulse'}/ · last backup {state.at ? new Date(state.at).toLocaleString() : '—'}</span>
						</span>
						<span className="wp-row">
							<a className="wp-link" href={`https://github.com/${state.repo}`} target="_blank" rel="noreferrer">
								Open it →
							</a>
						</span>
					</div>
					<div className="wp-row-wrap">
						<button className="wp-btn wp-btn-sm wp-btn-primary" disabled={busy} onClick={backUpNow}>
							<Busy busy={busy} doing="Backing up…">Back up now</Busy>
						</button>
						{busy && <Art name="backup" size={56} delay={400} />}
						<ConfirmButton
							className="wp-btn wp-btn-sm"
							label="Restore from it"
							question="This replaces the learnings, tickets, tasks and time logs on this machine with the ones in the repository."
							confirmLabel="Replace what is here"
							disabled={busy}
							onConfirm={() =>
								run(async () => {
									const r = await call('restoreBackup')
									setSaid(`Restored ${r.learnings} learnings, ${r.tickets} tickets and ${r.days} days.`)
									await reload()
								})
							}
						/>
						<button className="wp-btn wp-btn-sm wp-btn-ghost" onClick={() => setOpen(!open)}>
							{open ? 'Done editing' : 'Change repository, token or schedule'}
						</button>
						<ConfirmButton
							className="wp-btn wp-btn-sm wp-btn-ghost"
							label="Stop backing up"
							question={`Nothing already in ${state.repo} is touched — it just stops being written to. Revoke the token on GitHub too if you want the access gone.`}
							confirmLabel="Stop"
							disabled={busy}
							onConfirm={() =>
								run(async () => {
									await onPatch({ syncRepo: '' })
									await call('saveSyncToken', '')
									setRepos(null)
									setMadeRepo(false)
									setSaid('Stopped. Nothing more will be written.')
									await reload()
								})
							}
						/>
					</div>
				</div>
			) : (
				<ol className="wp-steps">
					<Step n={1} title="Make the repository" active={step === 'repo'} done={step !== 'repo'}>
						<p className="wp-muted wp-small">
							It has to exist before a token can be limited to it. This opens GitHub's own form, already filled in and set to private — you are signed in, so it is one click
							on <strong>Create repository</strong>.
						</p>
						<div className="wp-row">
							<input className="wp-input wp-sm" style={{ width: 180 }} value={name} onChange={(e) => setName(e.target.value.replace(/[^\w.-]/g, '-'))} aria-label="Repository name" />
							{/* Opening GitHub's form is taken as doing it: a separate "I've created it"
							    was one more click with one answer. Step 3 checks against GitHub anyway. */}
							<a
								className="wp-btn wp-btn-sm wp-btn-primary"
								href={newRepoUrl(name)}
								target="_blank"
								rel="noreferrer"
								onClick={() => {
									setMadeRepo(true)
									setSaid('Press Create repository on GitHub, then make a token for it — step 2.')
								}}
							>
								Create it on GitHub →
							</a>
							{step === 'repo' && (
								<button
									className="wp-btn wp-btn-sm"
									onClick={() => {
										setMadeRepo(true)
										setSaid('Make a token for it — step 2.')
									}}
								>
									I already have one
								</button>
							)}
						</div>
					</Step>

					<Step n={2} title={state.hasToken ? 'Token saved' : 'Make a token for it'} active={step === 'token' || step === 'repo'} done={state.hasToken}>
						<p className="wp-muted wp-small">
							The page this opens is already filled in: name <em>WorkPulse Brain</em>, <strong>Contents: Read and write</strong>, 90 days. One thing is left for you:
						</p>
						<ul className="wp-md-list wp-small wp-muted">
							<li>
								<strong>Repository access</strong> → <em>Only select repositories</em> → <code>{name}</code>. Not <em>All repositories</em> — a backup token should be
								able to write to that one and nothing else.
							</li>
							<li>
								Then <strong>Generate token</strong> and paste it below. GitHub adds <em>Metadata: Read-only</em> by itself — that is normal. Leave every other
								permission on <em>No access</em>; WorkPulse writes files and does nothing else.
							</li>
						</ul>
						<div className="wp-row">
							<a className="wp-btn wp-btn-sm" href={TOKEN_URL} target="_blank" rel="noreferrer">
								Open the token page →
							</a>
						</div>
						<div className="wp-row" style={{ marginTop: 6 }}>
							<input
								className="wp-input wp-grow"
								type="password"
								autoComplete="off"
								placeholder={state.hasToken ? '•••••••• saved — paste a new one to replace it' : 'Paste the token here (github_pat_…)'}
								value={token}
								onChange={(e) => setToken(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === 'Enter' && token.trim()) void saveToken()
								}}
							/>
							<button className="wp-btn wp-btn-sm wp-btn-primary" disabled={busy || !token.trim()} onClick={saveToken}>
								Save
							</button>
						</div>
						<p className="wp-muted wp-small">
							Kept on this machine, apart from your settings. Never shown again, never exported, never written into the backup, and only ever sent to api.github.com.
							{state.hasToken && ' Pasting a new one replaces it; the one in use keeps working until you do.'}
						</p>
					</Step>

					<Step n={3} title={state.repo ? `Repository: ${state.repo}` : 'Which repository?'} active={step === 'pick'} done={!!state.repo && state.hasToken}>
						{repos == null && state.hasToken ? (
							<span className="wp-muted wp-small">Asking GitHub which repositories this token can write to…</span>
						) : repos?.length ? (
							<div className="wp-stack-sm wp-small">
								{/* One repository means the token was scoped the way step 2 asked
								    for. More than one means it was not, and that is worth saying:
								    a backup token should not be able to write to everything you
								    own. It still works — it is just wider than it needs to be. */}
								{repos.length > 1 ? (
									<div className="wp-banner">
										<span className="wp-grow">
											This token can write to <strong>{repos.length} repositories</strong>, so it was made with <em>All repositories</em> rather than{' '}
											<em>Only select repositories</em>. It works, but it is wider than WorkPulse needs.{' '}
											<a className="wp-link" href={TOKEN_URL} target="_blank" rel="noreferrer">
												Make a narrower one
											</a>{' '}
											and paste it above, or carry on and pick below.
										</span>
									</div>
								) : (
									<span className="wp-muted">The one repository this token can write to:</span>
								)}
								<div className="wp-stack-sm wp-scroll-sm">
								{/* The token's own list: anything here is known to work. */}
								{/* The one you named in step 1 first, since that is the one you
								    just made. */}
								{[...repos]
									.sort((a, b) => Number(b.full_name.endsWith(`/${name}`)) - Number(a.full_name.endsWith(`/${name}`)))
									.map((r) => (
										<div key={r.full_name} className="wp-between">
											<span>
												{r.full_name} {r.private && <span className="wp-chip">private</span>}
												{r.full_name.endsWith(`/${name}`) && repos.length > 1 && <span className="wp-chip wp-chip-accent">the one you made</span>}
											</span>
											<button className={state.repo === r.full_name ? 'wp-btn wp-btn-sm wp-btn-soft' : 'wp-btn wp-btn-sm'} disabled={busy} onClick={() => pick(r.full_name)}>
												{state.repo === r.full_name ? 'Chosen' : 'Use this'}
											</button>
										</div>
									))}
								</div>
							</div>
						) : (
							<div className="wp-stack-sm">
								<span className="wp-muted wp-small">
									{state.hasToken
										? 'That token cannot write to any repository yet. On GitHub, edit the token and make sure it lists your repository with Contents: Read and write — or type it below.'
										: 'Finish step 2 first, and the repositories your token can reach will be listed here.'}
								</span>
								<div className="wp-row">
									<label className="wp-label wp-small" htmlFor="wp-repo-manual" style={{ flex: 'none' }}>
										Or type it
									</label>
									<input
										id="wp-repo-manual"
										className="wp-input wp-grow"
										placeholder="your-github-username/workpulse-notes"
										defaultValue={state.repo}
										onBlur={(e) => {
											const where = parseRepo(e.target.value)
											if (where) void pick(`${where.owner}/${where.repo}`)
										}}
									/>
									<button className="wp-btn wp-btn-sm" disabled={busy || !state.hasToken} onClick={() => run(async () => void setRepos((await call('githubRepos')).repos))}>
										Try again
									</button>
								</div>
							</div>
						)}
					</Step>

					<Step n={4} title="First backup" active={step === 'backup'} done={state.at != null}>
						<p className="wp-muted wp-small">
							This writes everything WorkPulse knows to <strong>{state.repo || 'your repository'}</strong>: your learnings and mistakes, your tickets with their links and
							notes, your time logs, and a page for each day. After this it happens on its own, once a day.
						</p>
						{/* Said here, before the first write: a repository that also holds
						    code should not get notes on its main branch by default. */}
						<div className="wp-row-wrap wp-small">
							<span>
								Branch: <code>{settings.syncBranch.trim() || 'the default branch'}</code>
							</span>
							{settings.syncBranch.trim() === 'brain' && (
								<span className="wp-muted">— its own branch, so notes never land next to code; the same one Claude Code uses.</span>
							)}
							{!settings.syncBranch.trim() && (
								<>
									<span className="wp-muted">— if this repository also holds code, give your notes their own branch.</span>
									<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => run(async () => void (await onPatch({ syncBranch: 'brain' }), setSaid('Notes go to the brain branch.')))}>
										Use <code>brain</code>
									</button>
								</>
							)}
						</div>
						<details className="wp-small">
							<summary className="wp-link" style={{ cursor: 'pointer' }}>
								What the files are called
							</summary>
							<ul className="wp-md-list wp-muted" style={{ marginTop: 6 }}>
								<li>
									<code>days/2026/2026-10-13.md</code> — one page per day: hours, what you logged, what you learned
								</li>
								<li>
									<code>learnings/2026-10.md</code> — learnings and mistakes, a file per month
								</li>
								<li>
									<code>tickets.md</code> — every ticket with its links and notes
								</li>
								<li>
									<code>timesheets/2026-10.csv</code> — the month's time log, for a spreadsheet
								</li>
								<li>
									<code>data/</code> and <code>index.json</code> — the machine-readable copy <strong>Restore</strong> reads, split by month and by ticket so a day's
									backup rewrites a day's worth of bytes rather than your whole history
								</li>
							</ul>
						</details>
						<div className="wp-row">
							<button className="wp-btn wp-btn-sm wp-btn-primary" disabled={busy || step !== 'backup'} onClick={backUpNow}>
								<Busy busy={busy} doing="Backing up…">Back up now</Busy>
							</button>
							{!!state.repo && (
								<a className="wp-link wp-small" href={`https://github.com/${state.repo}`} target="_blank" rel="noreferrer">
									Open the repository →
								</a>
							)}
						</div>
					</Step>
				</ol>
			)}

			{open && done && (
				<div className="wp-stack-sm wp-small" style={{ paddingTop: 10, borderTop: '1px solid var(--wp-border)' }}>
					<span className="wp-eyebrow">Connection</span>

					{/* Everything set during the wizard stays changeable afterwards:
					    tokens expire, repositories get renamed, and a setup screen you
					    cannot get back to is a dead end. */}
					<div className="wp-between">
						<span>
							<strong>{state.repo}</strong> <span className="wp-muted">· where the backup is written</span>
						</span>
						<button
							className="wp-btn wp-btn-sm"
							disabled={busy}
							onClick={() =>
								run(async () => {
									setRepos((await call('githubRepos')).repos)
									setSaid('Pick the repository to use from now on.')
								})
							}
						>
							<Busy busy={busy} doing="Asking GitHub…">Change</Busy>
						</button>
					</div>

					{!!repos?.length && (
						<div className="wp-stack-sm wp-scroll-sm">
							{repos.map((r) => (
								<div key={r.full_name} className="wp-between">
									<span>
										{r.full_name} {r.private && <span className="wp-chip">private</span>}
									</span>
									<button
										className={state.repo === r.full_name ? 'wp-btn wp-btn-sm wp-btn-soft' : 'wp-btn wp-btn-sm'}
										disabled={busy}
										onClick={() => run(async () => void (await pick(r.full_name), setRepos(null)))}
									>
										{state.repo === r.full_name ? 'In use' : 'Use this'}
									</button>
								</div>
							))}
							<button className="wp-action" onClick={() => setRepos(null)}>
								Cancel
							</button>
						</div>
					)}

					<div className="wp-row">
						<span className="wp-muted" style={{ width: 90 }}>
							Token
						</span>
						<input
							className="wp-input wp-sm wp-grow"
							type="password"
							autoComplete="off"
							placeholder="Paste a new token to replace the one in use"
							value={token}
							onChange={(e) => setToken(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter' && token.trim()) void saveToken()
							}}
						/>
						<button className="wp-btn wp-btn-sm" disabled={busy || !token.trim()} onClick={saveToken}>
							<Busy busy={busy} doing="Checking…">Replace</Busy>
						</button>
					</div>
					<span className="wp-muted">
						The one in use keeps working until you replace it. When it expires, backups stop and the error shows here —{' '}
						<a className="wp-link" href={TOKEN_URL} target="_blank" rel="noreferrer">
							make a new one
						</a>{' '}
						and paste it above.
					</span>

					<span className="wp-eyebrow" style={{ marginTop: 6 }}>
						Schedule
					</span>
					<Schedule settings={settings} onPatch={onPatch} busy={busy} />
				</div>
			)}

			{!done && (
				<div className="wp-stack-sm wp-small" style={{ paddingTop: 10, borderTop: '1px solid var(--wp-border)' }}>
					<Schedule settings={settings} onPatch={onPatch} busy={busy} />
				</div>
			)}

			{said && <div className="wp-ok-text wp-small">{said}</div>}
			{(error || state.error) && <div className="wp-error wp-small">{error || state.error}</div>}
		</Panel>
	)
}

/** When it runs, and where in the repository. Shared by the wizard and the edit view. */
function Schedule({ settings, onPatch, busy }: { settings: Settings; onPatch: Patch; busy: boolean }) {
	const { run } = useAction()
	return (
		<div className="wp-stack-sm wp-small">
			<label className="wp-row" style={{ cursor: 'pointer' }}>
				<input type="checkbox" checked={settings.syncDaily} disabled={busy} onChange={(e) => run(() => onPatch({ syncDaily: e.target.checked }))} />
				<span>
					Back up on its own, once a day <span className="wp-muted">— when you check out, or by the time below if you never did</span>
				</span>
			</label>
			<label className="wp-row">
				<span className="wp-muted" style={{ width: 90 }}>
					Latest by
				</span>
				<TimeField label="Back up by" value={settings.syncAfter} disabled={busy || !settings.syncDaily} onChange={(v) => run(() => onPatch({ syncAfter: v || '19:00' }))} />
			</label>

			{/* A picture is a hundred times the size of the words beside it, so it
			    is a choice rather than a default. The notes themselves always go. */}
			<label className="wp-row" style={{ cursor: 'pointer' }}>
				<input type="checkbox" checked={settings.backupShots} disabled={busy} onChange={(e) => run(() => onPatch({ backupShots: e.target.checked }))} />
				<span>
					Include the screenshots from your page notes{' '}
					<span className="wp-muted">— a few megabytes of JPEG, named for the day and the page. The notes themselves go either way.</span>
				</span>
			</label>

			<label className="wp-row" style={{ cursor: 'pointer' }}>
				<input type="checkbox" checked={settings.backupClips} disabled={busy} onChange={(e) => run(() => onPatch({ backupClips: e.target.checked }))} />
				<span>
					Include the recordings{' '}
					<span className="wp-muted">— a clip is twenty times the size of a picture, so this one is off unless you want it. Only the few that are kept locally go.</span>
				</span>
			</label>

			{/* Both of these have working defaults. They are here for the people who
			    want them and out of the way for everyone else. */}
			<details>
				<summary className="wp-link" style={{ cursor: 'pointer' }}>
					Where in the repository
				</summary>
				<div className="wp-stack-sm" style={{ marginTop: 8 }}>
					<label className="wp-row">
						<span className="wp-muted" style={{ width: 90 }}>
							Folder
						</span>
						<input className="wp-input wp-sm" style={{ width: 160 }} placeholder="workpulse" value={settings.syncPath} onChange={(e) => run(() => onPatch({ syncPath: e.target.value }))} />
						<span className="wp-muted">everything is written inside this folder</span>
					</label>
					<label className="wp-row">
						<span className="wp-muted" style={{ width: 90 }}>
							Branch
						</span>
						<input className="wp-input wp-sm" style={{ width: 160 }} placeholder="your default branch" value={settings.syncBranch} onChange={(e) => run(() => onPatch({ syncBranch: e.target.value }))} />
						<span className="wp-muted">leave empty unless you want a separate one</span>
					</label>
				</div>
			</details>
		</div>
	)
}

function Step({ n, title, active, done, children }: { n: number; title: string; active: boolean; done: boolean; children: React.ReactNode }) {
	// A finished step folds to one line but is never locked: tokens expire and
	// repositories get renamed, and a step you cannot reopen is a dead end.
	const [reopened, setReopened] = useState(false)
	const showing = active || !done || reopened

	return (
		<li className={done ? 'wp-step wp-step-done' : active ? 'wp-step wp-step-on' : 'wp-step'}>
			<span className="wp-step-mark" aria-hidden>
				{done ? '✓' : n}
			</span>
			<div className="wp-grow" style={{ minWidth: 0 }}>
				<div className="wp-between">
					<span className="wp-step-title">{title}</span>
					{done && !active && (
						<button className="wp-action wp-small" onClick={() => setReopened(!reopened)}>
							{reopened ? 'Close' : 'Change'}
						</button>
					)}
				</div>
				{showing && <div className="wp-stack-sm">{children}</div>}
			</div>
		</li>
	)
}

/** Free, open and unfunded. Asked once, in the quietest way that still works. */
export function Support() {
	return (
		<section className="wp-card wp-stack-sm" data-wp-section data-wp-keywords="sponsor donate open source licence github issues support">
			<div>
				<span className="wp-eyebrow">WorkPulse is free and open source</span>
				<p className="wp-muted wp-small">
					No account, no server, no telemetry — your data stays on this machine unless you point it at your own repository. If it saves you the hour a month it was built to
					save, sponsoring it keeps it maintained.
				</p>
			</div>
			<div className="wp-row-wrap">
				<a className="wp-btn wp-btn-sm wp-btn-primary" href={SPONSOR_URL} target="_blank" rel="noreferrer">
					Sponsor on GitHub
				</a>
				<a className="wp-btn wp-btn-sm" href={SOURCE_URL} target="_blank" rel="noreferrer">
					Source &amp; issues
				</a>
				<a className="wp-btn wp-btn-sm wp-btn-ghost" href={`${SOURCE_URL}/issues/new`} target="_blank" rel="noreferrer">
					Report something
				</a>
			</div>
		</section>
	)
}

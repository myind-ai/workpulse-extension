// Everything the bridge holds, in one place: what each ticket asked and what
// was done, the mistakes and their root causes, debugging sessions, reports,
// code and skills — for work and for your own side projects. The CLI writes
// most of it at the end of a session; you can add to it here, and ask the CLI
// for something through its inbox.
//
// It lives in your backup repository under bridge/, so it is yours, private,
// and readable on GitHub without this extension.

import { useEffect, useMemo, useState } from 'react'

import { filter, KIND_LABEL, KINDS, reportMarkdown, type BridgeEntry, type EntryKind, type Scope } from '@/core/bridge'
import { enabled } from '@/core/features'
import { fileName } from '@/core/export'
import { istDate, prettyDate } from '@/core/time'
import { call } from '@/lib/rpc'
import { Art } from '@/ui/Art'
import { Busy } from '@/ui/Busy'
import { useAction, useLive } from '@/ui/hooks'
import { Markdown } from '@/ui/Markdown'

import { Resume } from './Resume'

const PAGE = 40
const DAY = 86_400_000
const KIND_COLOUR: Partial<Record<EntryKind, string>> = { mistake: 'wp-chip-warn', ticket: 'wp-chip-accent', debug: 'wp-chip-accent' }

function download(name: string, text: string) {
	const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
	const a = document.createElement('a')
	a.href = url
	a.download = name
	a.click()
	setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function BrainView({ arg }: { arg?: string }) {
	const { data, reload } = useLive(() => call('bridge'))
	// Which ticket keys already have a ticket on the Tickets page, so an entry can
	// open it — or start it.
	const keys = useMemo(() => [...new Set((data?.entries ?? []).map((e) => e.ticket).filter((k): k is string => !!k))], [data])
	const { data: saved, reload: reloadSaved } = useLive(() => (keys.length ? call('brainTickets', keys) : Promise.resolve({} as Record<string, string | null>)), [keys.join(',')])
	const sync = useAction()
	const [kind, setKind] = useState<EntryKind | 'all'>('all')
	const [scope, setScope] = useState<Scope | 'all'>('all')
	const [query, setQuery] = useState('')
	const [ticket, setTicket] = useState<string | undefined>(arg)
	const [project, setProject] = useState<string | undefined>()
	const [adding, setAdding] = useState(false)
	const [asking, setAsking] = useState(false)
	const [show, setShow] = useState(PAGE)
	const personal = enabled('PERSONAL')

	// A link from a ticket page (#/brain/PAY-2433) lands filtered to that ticket,
	// also when the Brain is already open.
	useEffect(() => setTicket(arg), [arg])

	// While this page is open, look every minute; the background looks every fifteen.
	useEffect(() => {
		const poll = () => void call('pollBridge').then(reload, () => undefined)
		poll()
		const t = setInterval(poll, 60_000)
		return () => clearInterval(t)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	const found = useMemo(() => filter(data?.entries ?? [], { kind, scope, query, ticket, project }), [data, kind, scope, query, ticket, project])
	const shown = found.slice(0, show)
	const s = data?.summary

	const report = (days: number) => {
		const to = Date.now() + 1
		download(fileName(`brain-report-${days}d`, 'md', istDate(to)), reportMarkdown(found, to - days * DAY, to, days === 7 ? 'Week report' : `Last ${days} days`))
	}

	if (data && !data.on) {
		return (
			<div className="wp-card wp-muted">
				The bridge is switched off in this build. Remove <code>WXT_FEATURE_BRIDGE_SYNC=false</code> from <code>.env</code> and rebuild to turn it on.
			</div>
		)
	}

	return (
		<div className="wp-stack">
			<header className="wp-page-head">
				<div>
					<span className="wp-eyebrow">Shared with Claude Code, through your own repository</span>
					<h1 className="wp-h1">Brain</h1>
					<p className="wp-muted wp-small" style={{ maxWidth: 600, margin: 0 }}>
						Tickets, what they asked and what was done, mistakes and their root causes, debugging, reports, code and skills — for work
						{personal ? ' and your side projects' : ''}. The CLI skill writes it at the end of a session; it lives under <code>bridge/</code> in{' '}
						{data?.repo ? <code>{data.repo}</code> : 'your backup repository'}.
					</p>
				</div>
				<div className="wp-row-wrap">
					<button className="wp-btn wp-btn-sm wp-btn-primary" disabled={sync.busy || !data?.ready} onClick={() => sync.run(async () => void (await call('pollBridge', true), await reload()))}>
						<Busy busy={sync.busy} doing="Syncing…">
							Sync now
						</Busy>
					</button>
					<button className="wp-btn wp-btn-sm" disabled={!found.length} onClick={() => report(7)}>
						Week report .md
					</button>
					<button className="wp-btn wp-btn-sm" disabled={!found.length} onClick={() => report(30)}>
						Month report .md
					</button>
				</div>
			</header>

			{sync.busy && <Art name="reading" size={48} delay={400} />}
			{(sync.error || data?.error) && <div className="wp-banner wp-small">{sync.error || data?.error}</div>}

			{!!data?.queued && (
				<div className="wp-banner wp-small">
					{data.queued} {data.queued === 1 ? 'entry is' : 'entries are'} saved in this browser and not in the repository yet. {data.ready ? 'Sync now sends them.' : 'They go once a repository is set up.'}
				</div>
			)}

			{data?.ready && !ticket && <Resume limit={6} />}

			{data && !data.ready ? (
				<div className="wp-card wp-stack-sm">
					<Art name="empty-journal" size={96} />
					<strong>Connect a repository first.</strong>
					<span className="wp-muted wp-small">
						The Brain reads and writes the same private repository your backup uses. Set it up in <a href="#/settings/backup">Settings → Backup</a> (a fine-grained token with
						Contents: Read and write on that one repository). Then, in a terminal: <code>node cli/wp-brain.mjs init owner/repo</code>.
					</span>
				</div>
			) : (
				<>
					{!!s && (
						<div className="wp-row-wrap wp-small">
							<span className="wp-muted">{data?.polledAt ? `Synced ${prettyDate(istDate(data.polledAt))}, ${new Date(data.polledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Not synced yet'}</span>
							<span className="wp-muted">· this browser writes as <code>{data?.device}</code></span>
						</div>
					)}

					{!!s?.repeats.length && (
						<div className="wp-card wp-row-wrap wp-small">
							<span className="wp-eyebrow" style={{ marginRight: 4 }}>
								Mistakes that keep coming back
							</span>
							{s.repeats.slice(0, 8).map((r) => (
								<button key={r.tag} className="wp-chip wp-chip-warn" onClick={() => setQuery(r.tag)}>
									#{r.tag} ×{r.count}
								</button>
							))}
						</div>
					)}

					<div className="wp-row-wrap">
						<button className="wp-btn wp-btn-sm wp-btn-primary" onClick={() => setAdding(true)} disabled={adding}>
							+ Add
						</button>
						<button className="wp-btn wp-btn-sm" onClick={() => setAsking(true)} disabled={asking}>
							Ask Claude Code…
						</button>
						<span className="wp-row">
							{(['all', ...KINDS] as const).map((k) => (
								<button key={k} className={kind === k ? 'wp-btn wp-btn-sm wp-btn-soft' : 'wp-btn wp-btn-sm'} aria-pressed={kind === k} onClick={() => setKind(k)}>
									{k === 'all' ? 'Everything' : KIND_LABEL[k]}
									{k !== 'all' && !!s?.byKind[k] && <span className="wp-muted"> {s.byKind[k]}</span>}
								</button>
							))}
						</span>
					</div>
					<div className="wp-row-wrap">
						{personal && (
							<span className="wp-row">
								{(['all', 'work', 'personal'] as const).map((x) => (
									<button key={x} className={scope === x ? 'wp-btn wp-btn-sm wp-btn-soft' : 'wp-btn wp-btn-sm'} aria-pressed={scope === x} onClick={() => setScope(x)}>
										{x === 'all' ? 'Work and personal' : x === 'work' ? 'Work' : 'Personal'}
									</button>
								))}
							</span>
						)}
						<input className="wp-input wp-grow" style={{ minWidth: 180 }} placeholder="Search a word, a #tag, a ticket…" value={query} onChange={(e) => setQuery(e.target.value)} />
						{(ticket || project || query) && (
							<button className="wp-action" onClick={() => (setTicket(undefined), setProject(undefined), setQuery(''))}>
								clear {ticket ?? project ?? ''}
							</button>
						)}
					</div>

					{adding && <AddEntry ticket={ticket} project={project} onDone={() => setAdding(false)} onSaved={reload} />}
					{asking && <Ask ticket={ticket} project={project} onDone={() => setAsking(false)} />}

					<div className="wp-brain">
						<div className="wp-stack-sm">
							{!data?.entries.length ? (
								<div className="wp-card wp-muted">
									<Art name="empty-notes" size={96} />
									Nothing here yet. At the end of a ticket, the <code>workpulse-brain</code> skill writes what was asked, what was done and what was learned — or press{' '}
									<strong>+ Add</strong>.
								</div>
							) : !shown.length ? (
								<div className="wp-card wp-muted">Nothing matches that.</div>
							) : (
								shown.map((e) => (
									<EntryCard key={e.id} e={e} onTicket={setTicket} onProject={setProject} ticketId={e.ticket && saved && e.ticket in saved ? saved[e.ticket] : undefined} onCreated={reloadSaved} />
								))
							)}
							{shown.length < found.length && (
								<button className="wp-btn wp-btn-sm" onClick={() => setShow(show + PAGE)}>
									Show {Math.min(PAGE, found.length - shown.length)} more of {found.length - shown.length}
								</button>
							)}
						</div>
						<aside className="wp-stack-sm">
							{!!s?.tickets.length && (
								<div className="wp-card wp-stack-sm wp-small">
									<span className="wp-eyebrow">Tickets</span>
									{s.tickets.slice(0, 15).map((t) => (
										<button key={t.key} className="wp-between wp-action" style={{ textAlign: 'left' }} aria-pressed={ticket === t.key} onClick={() => setTicket(ticket === t.key ? undefined : t.key)}>
											<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
												<strong>{t.key}</strong> {t.title}
											</span>
											<span className="wp-muted wp-num">{t.count}</span>
										</button>
									))}
								</div>
							)}
							{!!s?.projects.length && (
								<div className="wp-card wp-stack-sm wp-small">
									<span className="wp-eyebrow">Projects</span>
									{s.projects
										.filter((p) => personal || p.scope === 'work')
										.slice(0, 15)
										.map((p) => (
											<button key={p.name} className="wp-between wp-action" aria-pressed={project === p.name} onClick={() => setProject(project === p.name ? undefined : p.name)}>
												<span>
													{p.name} {p.scope === 'personal' && <span className="wp-chip">personal</span>}
												</span>
												<span className="wp-muted wp-num">{p.count}</span>
											</button>
										))}
								</div>
							)}
						</aside>
					</div>
				</>
			)}
		</div>
	)
}

export function EntryCard({
	e,
	onTicket,
	onProject,
	ticketId,
	onCreated,
}: {
	e: BridgeEntry
	onTicket: (k: string) => void
	onProject: (p: string) => void
	/** The saved ticket for this entry's key: an id, null when there is none yet, undefined when not asked. */
	ticketId?: string | null
	onCreated?: () => void
}) {
	const [open, setOpen] = useState(false)
	const make = useAction()
	const detail = !!(e.body || e.asked || e.done || e.rootCause || e.next?.length || e.links)
	const newTicket = () =>
		make.run(async () => {
			const { id } = await call('ticketFromBrain', e.id)
			onCreated?.()
			location.hash = `#/links/${id}`
		})
	return (
		<article className="wp-card wp-stack-sm">
			<div className="wp-between wp-small">
				<span className="wp-row-wrap">
					<span className={`wp-chip ${KIND_COLOUR[e.kind] ?? ''}`}>{KIND_LABEL[e.kind]}</span>
					{e.scope === 'personal' && <span className="wp-chip">personal</span>}
					{e.ticket && (
						<button className="wp-action" onClick={() => onTicket(e.ticket!)}>
							{e.ticket}
						</button>
					)}
					{e.ticket && typeof ticketId === 'string' && (
						<a className="wp-link" href={`#/links/${ticketId}`} title="This ticket on the Tickets page">
							open ticket →
						</a>
					)}
					{e.ticket && ticketId === null && (
						<button className="wp-action" disabled={make.busy} onClick={newTicket} title={`Start ${e.ticket} on the Tickets page, with this entry's links`}>
							+ new ticket
						</button>
					)}
					{e.project && (
						<button className="wp-action wp-muted" onClick={() => onProject(e.project!)}>
							{e.project}
						</button>
					)}
					{e.status && <span className="wp-muted">· {e.status}</span>}
				</span>
				<span className="wp-muted" title={e.device}>
					{prettyDate(istDate(e.at))}
				</span>
			</div>
			<strong>{e.title}</strong>
			{detail && (
				<button className="wp-action wp-small" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(!open)} aria-expanded={open}>
					{open ? 'less' : 'more'}
				</button>
			)}
			{open && (
				<div className="wp-stack-sm wp-small">
					{e.asked && (
						<div>
							<span className="wp-eyebrow">Asked</span> {e.asked}
						</div>
					)}
					{e.done && (
						<div>
							<span className="wp-eyebrow">Done</span> {e.done}
						</div>
					)}
					{e.rootCause && (
						<div>
							<span className="wp-eyebrow">Root cause</span> {e.rootCause}
						</div>
					)}
					{!!e.next?.length && (
						<div>
							<span className="wp-eyebrow">Next</span> {e.next.join(' · ')}
						</div>
					)}
					{e.body && <Markdown text={e.body} />}
					{e.links && (
						<div className="wp-row-wrap">
							{e.links.pr && (
								<a className="wp-link" href={e.links.pr} target="_blank" rel="noreferrer">
									Pull request
								</a>
							)}
							{e.links.commits?.map((c) => (
								<code key={c}>{c.slice(0, 7)}</code>
							))}
							{e.links.related?.map((k) => (
								<button key={k} className="wp-action" onClick={() => onTicket(k)}>
									{k}
								</button>
							))}
							{e.links.urls?.map((u) => (
								<a key={u} className="wp-link" href={u} target="_blank" rel="noreferrer">
									{new URL(u).hostname}
								</a>
							))}
						</div>
					)}
					{!!e.tags?.length && <span className="wp-muted">{e.tags.map((t) => `#${t}`).join(' ')}</span>}
				</div>
			)}
		</article>
	)
}

function AddEntry({ ticket, project, onDone, onSaved }: { ticket?: string; project?: string; onDone: () => void; onSaved: () => void }) {
	const personal = enabled('PERSONAL')
	const [kind, setKind] = useState<EntryKind>('learning')
	const [scope, setScope] = useState<Scope>('work')
	const [title, setTitle] = useState('')
	const [body, setBody] = useState('')
	const [t, setT] = useState(ticket ?? '')
	const [p, setP] = useState(project ?? '')
	const [rootCause, setRootCause] = useState('')
	const { busy, error, run } = useAction()

	const save = () =>
		run(async () => {
			await call('bridgeAdd', {
				kind,
				scope,
				title,
				body: body.trim() || undefined,
				ticket: t.trim().toUpperCase() || undefined,
				project: p.trim() || undefined,
				rootCause: rootCause.trim() || undefined,
			})
			onSaved()
			onDone()
		})

	return (
		<div className="wp-card wp-stack-sm">
			<div className="wp-row-wrap">
				<select className="wp-input" value={kind} onChange={(e) => setKind(e.target.value as EntryKind)}>
					{KINDS.map((k) => (
						<option key={k} value={k}>
							{KIND_LABEL[k]}
						</option>
					))}
				</select>
				{personal && (
					<select className="wp-input" value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
						<option value="work">Work</option>
						<option value="personal">Personal</option>
					</select>
				)}
				<input className="wp-input" style={{ width: 120 }} placeholder="Ticket" value={t} onChange={(e) => setT(e.target.value)} />
				<input className="wp-input" style={{ width: 180 }} placeholder="Project or repo" value={p} onChange={(e) => setP(e.target.value)} />
			</div>
			<input className="wp-input" autoFocus placeholder="One line — what is worth remembering? #tags work" value={title} onChange={(e) => setTitle(e.target.value)} />
			{(kind === 'mistake' || kind === 'debug' || kind === 'ticket') && (
				<input className="wp-input" placeholder="Root cause" value={rootCause} onChange={(e) => setRootCause(e.target.value)} />
			)}
			<textarea className="wp-input" rows={4} placeholder="More, in Markdown (optional)" value={body} onChange={(e) => setBody(e.target.value)} />
			{error && <div className="wp-banner wp-small">{error}</div>}
			<div className="wp-row">
				<button className="wp-btn wp-btn-sm wp-btn-primary" disabled={busy || !title.trim()} onClick={save}>
					<Busy busy={busy} doing="Saving to the repository…">
						Save
					</Busy>
				</button>
				<button className="wp-btn wp-btn-sm" onClick={onDone}>
					Cancel
				</button>
			</div>
		</div>
	)
}

function Ask({ ticket, project, onDone }: { ticket?: string; project?: string; onDone: () => void }) {
	const [text, setText] = useState(ticket ? `Plan ${ticket} before standup` : '')
	const [sent, setSent] = useState(false)
	const { busy, error, run } = useAction()
	return (
		<div className="wp-card wp-stack-sm">
			<span className="wp-muted wp-small">
				Goes to <code>bridge/inbox/to-cli/</code>. The skill reads it the next time Claude Code starts, or when you run <code>node cli/wp-brain.mjs inbox</code>.
			</span>
			<textarea className="wp-input" rows={3} autoFocus value={text} onChange={(e) => setText(e.target.value)} />
			{error && <div className="wp-banner wp-small">{error}</div>}
			{sent && <div className="wp-ok-text wp-small">Sent.</div>}
			<div className="wp-row">
				<button className="wp-btn wp-btn-sm wp-btn-primary" disabled={busy || !text.trim() || sent} onClick={() => run(async () => void (await call('bridgeAsk', text, ticket, project), setSent(true)))}>
					<Busy busy={busy} doing="Sending…">
						Send
					</Busy>
				</button>
				<button className="wp-btn wp-btn-sm" onClick={onDone}>
					{sent ? 'Close' : 'Cancel'}
				</button>
			</div>
		</div>
	)
}

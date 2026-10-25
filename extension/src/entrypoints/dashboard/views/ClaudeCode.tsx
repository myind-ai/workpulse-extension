// Settings → Claude Code & the Brain: is this browser linked to Claude Code,
// and if not, exactly what to do about it.
//
// Linking is three things in the same repository and branch: this extension's
// backup settings (repository, branch, token — set in Backup above), the
// Brain reading and writing bridge/ there, and the wp-brain tool on each
// machine where Claude Code runs. This panel checks the first two itself, shows
// the third as soon as any Claude Code machine has written, and hands over the
// commands to link one.
//
// Checked before writing: Backup.tsx (the repository, token and branch fields —
// this panel points at them rather than repeating them) and BrainView (which
// shows the entries; this shows only the state of the link).

import { setupCommands } from '@/core/bridge'
import { enabled } from '@/core/features'
import { istDate, prettyDate } from '@/core/time'
import type { Settings } from '@/core/types'
import { call } from '@/lib/rpc'
import { Busy } from '@/ui/Busy'
import { copyText, useAction, useLive } from '@/ui/hooks'
import { Panel } from '@/ui/Panel'

type Patch = (patch: Partial<Settings>) => Promise<void>

const when = (at?: number) => (at ? `${prettyDate(istDate(at))}, ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'never')

function Step({ ok, warn, children }: { ok: boolean; warn?: boolean; children: React.ReactNode }) {
	return (
		<li className="wp-row" style={{ alignItems: 'flex-start', gap: 8 }}>
			<span aria-hidden style={{ width: 18, flex: 'none', color: ok ? 'var(--wp-ok)' : warn ? 'var(--wp-warn)' : 'var(--wp-muted)' }}>
				{ok ? '✓' : warn ? '!' : '○'}
			</span>
			<span className="wp-grow">{children}</span>
		</li>
	)
}

function Command({ label, text }: { label: string; text: string }) {
	const { busy, run } = useAction()
	return (
		<div className="wp-stack-sm">
			<span className="wp-muted wp-small">{label}</span>
			<div className="wp-row">
				<code className="wp-grow" style={{ overflowX: 'auto', whiteSpace: 'nowrap', padding: '6px 8px', borderRadius: 8, background: 'var(--wp-surface-2)' }}>
					{text}
				</code>
				<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => run(() => copyText(text))}>
					Copy
				</button>
			</div>
		</div>
	)
}

export function ClaudeCode({ settings, onPatch }: { settings: Settings; onPatch: Patch }) {
	const { data, reload } = useLive(() => call('bridge'))
	const act = useAction()
	if (!enabled('BRAIN') || !enabled('BRIDGE_SYNC')) return null

	const repo = data?.repo || settings.syncRepo
	const branch = data?.branch ?? settings.syncBranch.trim()
	const cli = data?.devices.filter((d) => d.kind === 'cli') ?? []
	const linked = !!repo && !!data?.hasToken
	const cmd = setupCommands(repo || 'owner/repo', branch)

	return (
		<Panel
			title="Claude Code & the Brain"
			hint={cli.length ? `Linked: ${cli.length} Claude Code machine${cli.length > 1 ? 's' : ''}` : linked ? 'Repository ready — link Claude Code' : 'Set up the backup first'}
			keywords="claude code cli skill brain bridge link connect hook rule wp-brain setup doctor github token branch repository sync learnings tickets mistakes"
			right={cli.length ? <span className="wp-chip wp-chip-ok">linked</span> : undefined}
		>
			<p className="wp-muted wp-small" style={{ margin: 0 }}>
				The Brain is a <code>bridge/</code> folder in your backup repository. This browser and Claude Code both read and write it — tickets, mistakes, debugging,
				learnings, reports, for work and side projects. Each device writes only its own file, and nothing is sent anywhere else.
			</p>

			<ol className="wp-stack-sm wp-small" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
				<Step ok={!!repo}>
					<strong>Repository</strong> {repo ? <code>{repo}</code> : '— none yet. Set it in Backup above.'}
				</Step>
				<Step ok={!!data?.hasToken}>
					<strong>Token</strong> {data?.hasToken ? 'saved (only this browser holds it)' : '— none yet. A fine-grained token, Contents: Read and write, on that one repository; paste it in Backup above.'}
				</Step>
				<Step ok={!!branch} warn={!branch && !!repo}>
					<strong>Branch</strong> {branch ? <code>{branch}</code> : 'the repository’s default branch.'}
					{!branch && repo && (
						<div className="wp-stack-sm" style={{ marginTop: 4 }}>
							<span className="wp-muted">
								If that repository also holds code, give the backup and the Brain their own branch so notes never land next to your code. Do it before the first backup.
							</span>
							<span>
								<button className="wp-btn wp-btn-sm" disabled={act.busy} onClick={() => act.run(async () => void (await onPatch({ syncBranch: 'brain' }), await reload()))}>
									<Busy busy={act.busy} doing="Saving…">
										Use a <code>brain</code> branch
									</Busy>
								</button>
							</span>
						</div>
					)}
				</Step>
				<Step ok={!!data?.polledAt && !data.error} warn={!!data?.error}>
					<strong>Brain sync</strong> {data?.error ? <span className="wp-error">{data.error}</span> : `last checked ${when(data?.polledAt)}`}
					{linked && (
						<button className="wp-action" style={{ marginLeft: 8 }} disabled={act.busy} onClick={() => act.run(async () => void (await call('pollBridge', true), await reload()))}>
							check now
						</button>
					)}
				</Step>
				<Step ok={cli.length > 0}>
					<strong>Claude Code</strong>{' '}
					{cli.length
						? cli.map((d) => (
								<span key={d.device} className="wp-chip" style={{ marginRight: 4 }} title={`${d.count} entries`}>
									{d.device} · {when(d.last)}
								</span>
							))
						: '— no machine has written yet. Run the commands below on the machine where you use Claude Code.'}
				</Step>
				<Step ok={!!data?.device}>
					<strong>This browser</strong> writes as <code>{data?.device ?? '…'}</code>
				</Step>
			</ol>
			{act.error && <div className="wp-error wp-small">{act.error}</div>}

			{linked && (
				<div className="wp-stack-sm">
					<span className="wp-eyebrow">Link Claude Code on a machine</span>
					<Command label="1. Get the tool and the skill (once per machine; Node 22.18 or newer)" text={cmd.clone} />
					<Command label="2. Set it up — it asks for the device name, the automatic brief and record, and the global rule, then installs them" text={cmd.setup} />
					<Command label="3. Check every part of the link" text={cmd.doctor} />
					<p className="wp-muted wp-small" style={{ margin: 0 }}>
						After that: Claude reads the Brain before a ticket, records mistakes as they happen, and after you commit it is asked once to record the session. What you
						write here on the Learnings page reaches Claude through the daily backup.
					</p>
				</div>
			)}

			<details className="wp-small">
				<summary className="wp-link" style={{ cursor: 'pointer' }}>
					What is uploaded, and when
				</summary>
				<table className="wp-table" style={{ marginTop: 8 }}>
					<tbody>
						<tr>
							<td>Daily, after check-out or by {settings.syncAfter || '19:00'}</td>
							<td>This extension’s backup: learnings, tickets, notes, time logs → <code>{settings.syncPath || 'workpulse'}/</code></td>
						</tr>
						<tr>
							<td>When you press + Add or Ask Claude Code… on the Brain page</td>
							<td>
								One line in this browser’s file → <code>bridge/</code>
							</td>
						</tr>
						<tr>
							<td>During and after a Claude Code session</td>
							<td>
								Mistakes and debugging as they happen; the ticket, what was done and learned at the end → <code>bridge/</code>
							</td>
						</tr>
						<tr>
							<td>Never</td>
							<td>Tokens, keys, passwords, customer data, logs, source code — both sides refuse anything token-shaped</td>
						</tr>
					</tbody>
				</table>
			</details>
		</Panel>
	)
}

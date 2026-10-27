// "1.4.0 is out": the notice for a zip install, at the top of the dashboard.
//
// Chrome will not update an extension loaded from a folder, so the notice
// carries the one line that does (update.sh, which replaces the files inside
// the same folder, so nothing saved is lost) and the Reload that loads them.
// After the reload it says once what it was updated from.

import { useState } from 'react'

import { updateNotice } from '@/core/update'
import { call } from '@/lib/rpc'
import { copyText, useLive } from '@/ui/hooks'

export function UpdateBanner() {
	const { data: u, reload } = useLive(() => call('updateState'))
	const [copied, setCopied] = useState(false)
	const [steps, setSteps] = useState(false)
	if (!u || u.storeInstall) return null
	const notice = updateNotice(u)
	if (!notice) return null

	if (notice.kind === 'updated') {
		return (
			<div className="wp-banner wp-small wp-row-wrap" role="status">
				<span className="wp-grow">
					Updated to <strong>WorkPulse {u.current}</strong> (from {notice.from}). Everything you had is still here.{' '}
					<a className="wp-link" href={`https://github.com/myind-ai/workpulse-extension/releases/tag/v${u.current}`} target="_blank" rel="noreferrer">
						What changed
					</a>
				</span>
				<button className="wp-btn wp-btn-sm" onClick={() => void call('seenVersion').then(reload)}>
					OK
				</button>
			</div>
		)
	}

	const r = notice.release
	return (
		<div className="wp-banner wp-small wp-stack-sm" role="status">
			<div className="wp-row-wrap">
				<span className="wp-grow">
					<strong>WorkPulse {r.version} is out</strong> — you have {u.current}.{' '}
					<a className="wp-link" href={r.url} target="_blank" rel="noreferrer">
						What’s new
					</a>
				</span>
				<button
					className="wp-btn wp-btn-sm wp-btn-primary"
					onClick={async () => {
						await copyText(u.command)
						setCopied(true)
						setSteps(true)
					}}
				>
					{copied ? 'Copied — paste it in a terminal' : 'Copy the update command'}
				</button>
				<button className="wp-btn wp-btn-sm" onClick={() => void call('reloadExtension')} title="After the command has run: load the new files. Nothing saved is lost.">
					Reload
				</button>
				<button className="wp-btn wp-btn-sm wp-btn-ghost" onClick={() => void call('dismissUpdate', r.version).then(reload)}>
					Not now
				</button>
			</div>
			{steps && (
				<div className="wp-stack-sm">
					<code style={{ display: 'block', whiteSpace: 'pre-wrap', wordBreak: 'break-all', padding: '6px 8px', borderRadius: 8, background: 'var(--wp-surface-2)' }}>
						{u.command}
					</code>
					<span className="wp-muted">
						1. Paste it in Terminal (Mac or Linux) and press Enter. It puts {r.version} in the folder you loaded and keeps the old one beside it. If you loaded a different
						folder than <code>~/WorkPulse/extension</code>, add <code>-s -- --dir "/that/folder"</code> after <code>bash</code> once; it remembers it.
						<br />
						2. Press <strong>Reload</strong>. Never Remove the extension to update it — that deletes its data.
						<br />
						On Windows, or without a terminal:{' '}
						<a className="wp-link" href={r.zip ?? r.url} target="_blank" rel="noreferrer">
							download the zip
						</a>
						, unzip it over the folder you loaded (replacing the files), then Reload.
					</span>
				</div>
			)}
		</div>
	)
}

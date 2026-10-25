// The WorkPulse helper card on Zoho's own pages during guided setup.
// On the API console: fills the client form and picks up the Client ID.
// On Zoho People: "Use this page" saves the attendance page address.

import { useEffect, useState } from 'react'

import { clientFormValues } from '@/core/setup'
import { fillForm, scanClientId } from '@/lib/page-helper'
import { call } from '@/lib/rpc'
import { Brand } from '@/ui/Brand'
import { copyText, useAction } from '@/ui/hooks'

type Check = { ok: boolean; detail: string; blocked?: boolean }
type Test = Record<string, Check>

const card: React.CSSProperties = { position: 'fixed', right: 20, bottom: 20, width: 380, maxHeight: 'calc(100vh - 40px)', overflow: 'auto', zIndex: 2147483647, boxShadow: 'var(--wp-shadow)' }

function TestLines({ test }: { test: Test }) {
	const rows: [string, Check][] = [
		["Today's attendance", test.attendance],
		['Jobs', test.jobs],
		['Month report', test.report],
	]
	return (
		<div className="wp-card-flat wp-stack-sm">
			{rows.map(([k, v]) => (
				<div key={k} className="wp-between wp-small">
					<span>{k}</span>
					<span className={v.ok ? 'wp-ok-text' : v.blocked ? 'wp-muted' : 'wp-error'}>{v.detail}</span>
				</div>
			))}
		</div>
	)
}

function Header({ onClose, title }: { onClose: () => void; title: string }) {
	return (
		<div className="wp-between">
			<span className="wp-row">
				<Brand /> <span className="wp-eyebrow">{title}</span>
			</span>
			<button className="wp-btn wp-btn-sm wp-btn-ghost" title="Close the helper" aria-label="Close helper" onClick={onClose}>
				✕
			</button>
		</div>
	)
}

export function ClientHelper({ redirectUrl, dataCenter, onClose }: { redirectUrl: string; dataCenter: 'in' | 'com' | 'eu' | 'com.au'; onClose: () => void }) {
	const values = clientFormValues(redirectUrl, dataCenter)
	const [fill, setFill] = useState<{ filled: string[]; missing: string[] } | null>(null)
	const [found, setFound] = useState<string | null>(null)
	const [manual, setManual] = useState('')
	const [copied, setCopied] = useState<string | null>(null)
	const [test, setTest] = useState<Test | null>(null)
	const { busy, error, run } = useAction()

	useEffect(() => {
		if (test) return
		const t = setInterval(() => {
			const id = scanClientId()
			if (id) setFound(id)
		}, 1000)
		return () => clearInterval(t)
	}, [test])

	const connect = (id: string) => run(async () => setTest(await call('connectWithClientId', id)))
	const ok = test && test.attendance.ok && test.jobs.ok && test.report.ok

	return (
		<div className="wp-root">
			<div className="wp-card wp-stack" style={card}>
				<Header title="Zoho setup" onClose={onClose} />
				{test ? (
					<>
						<div className={ok ? 'wp-banner' : 'wp-card-flat'}>{ok ? 'Connected to Zoho People.' : 'Signed in, but some checks failed:'}</div>
						<TestLines test={test} />
						<div className="wp-row">
							<button className="wp-btn wp-btn-primary" onClick={() => void call('openDashboard', 'connect')}>
								Open WorkPulse
							</button>
							<button className="wp-btn wp-btn-ghost" onClick={onClose}>
								Close
							</button>
						</div>
					</>
				) : (
					<>
						<div className="wp-stack-sm">
							<div className="wp-h2">1 · Create the client</div>
							<div className="wp-small wp-muted">
								In Zoho click <strong>Get started</strong> (or <strong>Add client</strong>) → <strong>Client-based Applications</strong> → <strong>Create now</strong>.
							</div>
						</div>
						<div className="wp-stack-sm">
							<div className="wp-between">
								<div className="wp-h2">2 · Fill the form</div>
								<button className="wp-btn wp-btn-sm wp-btn-primary" onClick={() => setFill(fillForm(values))}>
									Fill it for me
								</button>
							</div>
							{values.map((v) => (
								<div key={v.label} className="wp-between wp-small">
									<span className="wp-grow" style={{ minWidth: 0 }}>
										<span className="wp-muted">{v.label}</span>
										<div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.value}</div>
									</span>
									<button
										className="wp-btn wp-btn-sm"
										onClick={async () => {
											await copyText(v.value)
											setCopied(v.label)
										}}
									>
										{copied === v.label ? 'Copied' : 'Copy'}
									</button>
								</div>
							))}
							{fill && (
								<div className={`wp-small ${fill.missing.length ? 'wp-warn-text' : 'wp-ok-text'}`}>
									{fill.missing.length
										? `Filled ${fill.filled.length} of ${values.length}. Copy these by hand: ${fill.missing.join(', ')}.`
										: 'All 4 fields filled. Check them, then click Create in Zoho.'}
								</div>
							)}
						</div>
						<div className="wp-stack-sm">
							<div className="wp-h2">3 · Client ID</div>
							{found ? (
								<>
									<div className="wp-card-flat wp-small" style={{ wordBreak: 'break-all' }}>
										Found <strong>{found}</strong>
									</div>
									<button className="wp-btn wp-btn-primary wp-btn-block" disabled={busy} onClick={() => connect(found)}>
										{busy ? 'Waiting for Zoho sign-in…' : 'Save & sign in with Zoho'}
									</button>
								</>
							) : (
								<>
									<div className="wp-small wp-muted">After Create, open the client's <strong>Client Secret</strong> tab. WorkPulse spots the Client ID on this page by itself.</div>
									<div className="wp-row">
										<input className="wp-input wp-grow" placeholder="…or paste it: 1000.XXXX" value={manual} onChange={(e) => setManual(e.target.value)} />
										<button className="wp-btn" disabled={busy || !manual.trim()} onClick={() => connect(manual.trim())}>
											Sign in
										</button>
									</div>
								</>
							)}
						</div>
					</>
				)}
				{error && <div className="wp-error">{error}</div>}
			</div>
		</div>
	)
}

export function AttendanceHelper({ onClose }: { onClose: () => void }) {
	const [saved, setSaved] = useState<string | null>(null)
	const { busy, error, run } = useAction()
	return (
		<div className="wp-root">
			<div className="wp-card wp-stack" style={card}>
				<Header title="Attendance page" onClose={onClose} />
				{saved ? (
					<>
						<div className="wp-banner">Saved. Check-in and check-out reminders will open this page.</div>
						<div className="wp-small wp-muted" style={{ wordBreak: 'break-all' }}>
							{saved}
						</div>
						<button className="wp-btn" onClick={onClose}>
							Done
						</button>
					</>
				) : (
					<>
						<div className="wp-small wp-muted">Go to the Zoho People page where you click <strong>Check in</strong>, then press the button.</div>
						<button className="wp-btn wp-btn-primary wp-btn-block" disabled={busy} onClick={() => run(async () => setSaved(await call('captureAttendanceUrl', location.href)))}>
							Use this page as my attendance page
						</button>
					</>
				)}
				{error && <div className="wp-error">{error}</div>}
			</div>
		</div>
	)
}

// Guided "Connect Zoho People": one click opens each Zoho page, the helper on
// that page fills the form and returns the Client ID, then one click signs in
// and tests. Self Client and the attendance page live here too.

import { useState } from 'react'

import { API_ENABLED } from '@/core/features'
import type { DataCenter } from '@/core/types'
import { call } from '@/lib/rpc'

import { Ready } from './Ready'
import { ZohoAreas } from './ZohoAreas'
import { copyText, useAction, useLive } from '@/ui/hooks'

import { PageSourcePanel } from './PageSourcePanel'

type Check = { ok: boolean; detail: string; blocked?: boolean }
type Test = { attendance: Check; jobs: Check; report: Check }

function StepHead({ n, title, done }: { n?: number; title: string; done?: boolean }) {
	return (
		<div className="wp-between">
			<h2 className="wp-h2">
				{n != null && `${n} · `}
				{title}
			</h2>
			{done && (
				<span className="wp-chip wp-chip-ok">
					<span className="wp-dot" /> Done
				</span>
			)}
		</div>
	)
}

function CopyRow({ label, value }: { label: string; value: string }) {
	const [copied, setCopied] = useState(false)
	return (
		<div className="wp-row">
			<span className="wp-muted wp-small" style={{ width: 170, flex: 'none' }}>
				{label}
			</span>
			<input className="wp-input wp-grow wp-num" readOnly value={value} onFocus={(e) => e.target.select()} />
			<button
				className="wp-btn wp-btn-sm"
				onClick={async () => {
					await copyText(value)
					setCopied(true)
					setTimeout(() => setCopied(false), 1500)
				}}
			>
				{copied ? 'Copied' : 'Copy'}
			</button>
		</div>
	)
}

function TestResult({ test }: { test: Test }) {
	const rows: [string, Check][] = [
		["Today's attendance", test.attendance],
		['Jobs', test.jobs],
		['Month report', test.report],
	]
	return (
		<div className="wp-card-flat wp-stack-sm">
			{rows.map(([k, v]) => (
				<div key={k} className="wp-between">
					<span>{k}</span>
					<span className={v.ok ? 'wp-ok-text' : v.blocked ? 'wp-muted' : 'wp-error'}>{v.detail}</span>
				</div>
			))}
		</div>
	)
}

export function ConnectView() {
	const { data: info, reload } = useLive(() => call('setupInfo'))
	const [clientId, setClientId] = useState<string | null>(null)
	const [self, setSelf] = useState({ clientId: '', clientSecret: '', code: '' })
	const [showSelf, setShowSelf] = useState(false)
	const [test, setTest] = useState<Test | null>(null)
	const { busy, error, run } = useAction()
	if (!info) return <div className="wp-muted">Loading…</div>

	const id = clientId ?? info.clientId
	const save = (patch: { email?: string; dataCenter?: DataCenter }) => run(async () => {
		await call('saveSettings', patch)
		await reload()
	})

	return (
		<div className="wp-stack" style={{ gap: 20 }}>
			<div className="wp-page-head">
				<div>
					<div className="wp-eyebrow">Once, then it looks after itself</div>
					<h1 className="wp-title">Connect Zoho People</h1>
				</div>
				{API_ENABLED && info.auth ? (
					<span className="wp-chip wp-chip-ok">
						<span className="wp-dot" /> Connected ({info.auth === 'oauth' ? 'Sign in with Zoho' : 'Self Client'})
					</span>
				) : null}
			</div>

			{/* The answer first, once. The steps below it are for when it is no. */}
			<Ready always />

			{/* Zoho keeps attendance and time logs in different places, so "set up
			    Zoho" is four things, not one. */}
			<ZohoAreas />

			<section className="wp-card wp-stack">
				<StepHead n={1} title="Your Zoho account" done={!!info.email} />
				<div className="wp-grid-2">
					<div>
						<label className="wp-label">Zoho email</label>
						<input className="wp-input" defaultValue={info.email} placeholder="you@company.com" onBlur={(e) => e.target.value !== info.email && save({ email: e.target.value })} />
					</div>
					<div>
						<label className="wp-label">Data centre (from your Zoho address)</label>
						<select className="wp-select" value={info.dataCenter} onChange={(e) => save({ dataCenter: e.target.value as DataCenter })}>
							<option value="in">India — people.zoho.in</option>
							<option value="com">US — people.zoho.com</option>
							<option value="eu">EU — people.zoho.eu</option>
							<option value="com.au">Australia — people.zoho.com.au</option>
						</select>
					</div>
				</div>
			</section>

			<section className="wp-card wp-stack">
				<StepHead n={2} title="Your attendance page" done={info.attendanceSet} />
				<div className="wp-muted">
					Opens Zoho People. Go to the page where you click Check in and press <strong>Use this page</strong> on the WorkPulse helper. If Zoho shows its product page
					instead, you are signed out: click <strong>Sign in</strong> there, and the helper appears once you reach Zoho People.
				</div>
				<div className="wp-row-wrap">
					<button className="wp-btn wp-btn-lg" disabled={busy} onClick={() => run(() => call('startSetup', 'attendance'))}>
						Open Zoho People ↗
					</button>
					<span className="wp-muted wp-small" style={{ wordBreak: 'break-all' }}>
						{info.attendanceSet ? info.attendanceUrl : 'Not set yet'}
					</span>
				</div>
			</section>

			<PageSourcePanel />

			{API_ENABLED && (
			<details className="wp-card">
				<summary className="wp-h2" style={{ cursor: 'pointer' }}>
					Advanced · the official API
				</summary>
				<div className="wp-stack" style={{ marginTop: 14 }}>
					<div className="wp-muted wp-small">
						Zoho's documented API is the better source and WorkPulse prefers it whenever it answers. It needs your role to be allowed API access — ask your
						admin, then set it up here. Nothing below is needed for the reading path above.
					</div>
			<section className="wp-card wp-stack">
				<StepHead title="Create the WorkPulse client in Zoho" done={!!info.clientId} />
				<div className="wp-muted">
					Opens Zoho's API console in a new tab (sign in to Zoho if asked). A <strong>WorkPulse helper</strong> appears there: it fills Zoho's form for you and picks up the
					Client ID when Zoho shows it.
				</div>
				<div className="wp-row-wrap">
					<button className="wp-btn wp-btn-primary wp-btn-lg" disabled={busy} onClick={() => run(() => call('startSetup', 'client'))}>
						Open Zoho API console ↗
					</button>
					<span className="wp-muted wp-small">{info.consoleUrl}</span>
				</div>
				<details>
					<summary className="wp-small wp-muted" style={{ cursor: 'pointer' }}>
						Prefer to fill it by hand? The four values
					</summary>
					<div className="wp-stack-sm" style={{ marginTop: 10 }}>
						<div className="wp-small wp-muted">Client type: <strong>Client-based Applications</strong></div>
						{info.formValues.map((v) => (
							<CopyRow key={v.label} label={v.label} value={v.value} />
						))}
					</div>
				</details>
			</section>

			<section className="wp-card wp-stack">
				<StepHead title="Sign in with Zoho" done={info.auth === 'oauth'} />
				<div className="wp-row">
					<input
						className="wp-input wp-grow wp-num"
						placeholder="Client ID — filled in by the helper, or paste 1000.XXXX"
						value={id}
						onChange={(e) => setClientId(e.target.value)}
						onPaste={(e) => {
							const v = e.clipboardData.getData('text').trim()
							if (v) void run(async () => setClientId(await call('saveClientId', v)))
						}}
					/>
					<button className="wp-btn wp-btn-primary" disabled={busy || !id} onClick={() => run(async () => setTest(await call('connectWithClientId', id)))}>
						{busy ? 'Waiting for Zoho…' : 'Sign in with Zoho'}
					</button>
				</div>
				<div className="wp-muted wp-small">A Zoho window asks you to log in and accept read-only access. WorkPulse then tests attendance, jobs and the month report.</div>
				{test && <TestResult test={test} />}
				<button className="wp-action wp-small" style={{ alignSelf: 'flex-start' }} onClick={() => setShowSelf(!showSelf)}>
					{showSelf ? 'Hide Self Client option' : "Zoho won't accept the client, or asks you to sign in every hour? Use a Self Client"}
				</button>
				{showSelf && (
					<div className="wp-card-flat wp-stack-sm">
						<ol className="wp-small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
							<li>
								<button className="wp-action" onClick={() => run(() => call('startSetup', 'self'))}>
									Open the API console ↗
								</button>{' '}
								→ <strong>Add client</strong> → <strong>Self Client</strong> → <strong>Create</strong>. Copy the Client ID and Client Secret from the <strong>Client Secret</strong> tab.
							</li>
							<li>
								<strong>Generate Code</strong> tab: paste the scopes below, Time Duration <strong>10 minutes</strong>, description "WorkPulse", Create, copy the code.
							</li>
							<li>Paste all three here and Connect. WorkPulse swaps the code for a refresh token itself.</li>
						</ol>
						<CopyRow label="Scopes" value={info.scopes} />
						<div className="wp-grid-3">
							<input className="wp-input" placeholder="Client ID" value={self.clientId} onChange={(e) => setSelf({ ...self, clientId: e.target.value })} />
							<input className="wp-input" type="password" placeholder="Client Secret" value={self.clientSecret} onChange={(e) => setSelf({ ...self, clientSecret: e.target.value })} />
							<input className="wp-input" placeholder="Generated code" value={self.code} onChange={(e) => setSelf({ ...self, code: e.target.value })} />
						</div>
						<div className="wp-row">
							<button
								className="wp-btn wp-btn-primary"
								disabled={busy}
								onClick={() =>
									run(async () => {
										setTest(await call('connectSelfClient', self.clientId, self.clientSecret, self.code))
										setSelf({ clientId: '', clientSecret: '', code: '' })
									})
								}
							>
								Connect Self Client
							</button>
							<span className="wp-muted wp-small">Stored in this browser's extension storage, not encrypted.</span>
						</div>
					</div>
				)}
			</section>
				</div>
			</details>
			)}

			{error && <div className="wp-error">{error}</div>}
			<div className="wp-row-wrap">
				{API_ENABLED && (
					<button className="wp-btn wp-btn-soft" disabled={busy || !info.auth} onClick={() => run(async () => setTest(await call('testConnection')))}>
						Test connection again
					</button>
				)}
				<a className="wp-btn wp-btn-ghost" href="#/settings">
					Shift, work days and write mode →
				</a>
			</div>
		</div>
	)
}

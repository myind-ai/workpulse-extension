// "Is it working?" with an answer rather than a page of instructions.
//
// Reading your own Zoho session has a first-run problem: nothing tells you
// whether it worked. No error, no success — just a dashboard that may or may not
// be seeing anything. So this checks, says what it found, and offers one button
// for whatever is missing.

import type { Step } from '@/core/ready'
import { call } from '@/lib/rpc'
import { Busy } from '@/ui/Busy'
import { useAction, useLive } from '@/ui/hooks'

const FIX_LABEL: Record<NonNullable<Step['fix']>, string> = {
	openZoho: 'Open Zoho',
	check: 'Check now',
	refreshJobs: 'Read Zoho',
	settings: 'Set it',
}

export function Ready({ always }: { always?: boolean }) {
	const { data, reload } = useLive(() => call('readiness'))
	const { busy, error, run } = useAction()
	if (!data) return null
	// On the dashboard this is only in the way once everything works.
	if (!always && data.ready && data.steps.every((s) => s.ok)) return null

	const press = (fix: Step['fix']) =>
		run(async () => {
			// Jobs arrive with the page read, so three of these are the same action.
			if (fix === 'settings') location.hash = '#/settings/schedule'
			else await call('checkZoho')
			await reload()
		})

	return (
		<section className="wp-card wp-stack-sm">
			<div className="wp-between">
				<span>
					<span className="wp-eyebrow">Is WorkPulse working?</span>
					<div className={data.ready ? 'wp-ok-text' : 'wp-warn-text'} style={{ fontWeight: 600 }}>
						{data.summary}
					</div>
				</span>
				<button className="wp-btn wp-btn-sm wp-btn-primary" disabled={busy} onClick={() => press('check')}>
					<Busy busy={busy} doing="Checking…">Check now</Busy>
				</button>
			</div>

			<div className="wp-stack-sm wp-small">
				{data.steps.map((s) => (
					<div key={s.id} className="wp-between">
						<span style={{ minWidth: 0 }}>
							<span aria-hidden style={{ color: s.ok ? 'var(--wp-ok)' : 'var(--wp-muted)', marginRight: 8 }}>
								{s.ok ? '✓' : '○'}
							</span>
							<strong style={{ fontWeight: s.ok ? 500 : 600 }}>{s.label}</strong>
							<span className="wp-muted"> — {s.detail}</span>
						</span>
						{!s.ok && s.fix && (
							<button className="wp-btn wp-btn-sm" disabled={busy} onClick={() => press(s.fix)}>
								{FIX_LABEL[s.fix]}
							</button>
						)}
					</div>
				))}
			</div>

			{!data.ready && (
				<span className="wp-muted wp-small">
					WorkPulse reads the Zoho People page you are already signed into — it never asks for your password, and nothing is sent anywhere. Keep that tab open and press{' '}
					<strong>Check now</strong>.
				</span>
			)}
			{error && <div className="wp-error wp-small">{error}</div>}
		</section>
	)
}

// The one place WorkPulse asks for anything.
//
// It appears on a page you chose to open, never as a notification and never as a
// card that stops work. It appears only after a fortnight of real use and
// several timesheets it actually filled — and it says that number, because the
// number is the argument. "Not now" waits a season. "No thanks" is permanent and
// there is no second funnel behind it.

import { call } from '@/lib/rpc'
import { useAction, useLive } from '@/ui/hooks'

// One place for every outward link, so the footer, the settings panel and the
// ask can never drift apart.
export const AUTHOR = 'Shantanu Bombatkar'
export const AUTHOR_URL = 'https://github.com/shaantanu9'
export const SPONSOR_URL = 'https://github.com/sponsors/shaantanu9'
export const SOURCE_URL = 'https://github.com/myind-ai/workpulse-extension'

export function Support() {
	const { data, reload } = useLive(() => call('supportAsk'))
	const { busy, run } = useAction()
	if (!data?.show) return null

	const answer = (a: 'later' | 'never') => run(async () => void (await call('answerSupport', a), await reload()))

	return (
		<section className="wp-card wp-stack-sm">
			<div className="wp-between">
				<span className="wp-eyebrow">A small ask</span>
				<button className="wp-action wp-muted wp-small" disabled={busy} onClick={() => answer('never')}>
					Don't ask again
				</button>
			</div>
			<p className="wp-muted wp-small" style={{ marginBottom: 0 }}>
				{data.text}
			</p>
			<div className="wp-row-wrap">
				<a
					className="wp-btn wp-btn-sm wp-btn-primary"
					href={SPONSOR_URL}
					target="_blank"
					rel="noreferrer"
					onClick={() => void call('answerSupport', 'shown')}
				>
					Sponsor on GitHub
				</a>
				<a className="wp-btn wp-btn-sm" href={SOURCE_URL} target="_blank" rel="noreferrer">
					Star the repository
				</a>
				<button className="wp-btn wp-btn-sm wp-btn-ghost" disabled={busy} onClick={() => answer('later')}>
					Not now
				</button>
			</div>
		</section>
	)
}

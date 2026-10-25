// Quick capture from the toolbar: a todo, a link worth keeping, or a note —
// with an optional day and time to bring it back. Opens prefilled with the tab
// you are looking at, because that is almost always what you want to keep.

import { useEffect, useState } from 'react'

import { istDate } from '@/core/time'
import { call } from '@/lib/rpc'
import { useAction } from '@/ui/hooks'
import { WhenField } from '@/ui/TimeField'

/** "in an hour" / "tomorrow 09:30" beat typing a date, so offer both. */
function presets(now: number): { label: string; when: string }[] {
	const at = (ms: number) => {
		const d = new Date(ms)
		const pad = (n: number) => String(n).padStart(2, '0')
		return `${istDate(ms)}T${pad(d.getHours())}:${pad(d.getMinutes())}`
	}
	const tomorrow = new Date(now + 86_400_000)
	tomorrow.setHours(9, 30, 0, 0)
	return [
		{ label: 'in 1 hour', when: at(now + 3_600_000) },
		{ label: 'in 3 hours', when: at(now + 3 * 3_600_000) },
		{ label: 'tomorrow 09:30', when: at(tomorrow.getTime()) },
	]
}

export function Capture({ onSaved }: { onSaved?: () => void }) {
	const [text, setText] = useState('')
	const [url, setUrl] = useState('')
	const [when, setWhen] = useState('')
	const [kind, setKind] = useState<'task' | 'note'>('task')
	const [repeat, setRepeat] = useState(0)
	const [said, setSaid] = useState('')
	const { busy, error, run } = useAction()

	// The tab you are on, as the starting point.
	useEffect(() => {
		chrome.tabs
			?.query({ active: true, currentWindow: true })
			.then(([tab]) => {
				if (!tab?.url || /^chrome/.test(tab.url)) return
				setUrl(tab.url)
				setText((t) => t || (tab.title ?? ''))
			})
			.catch(() => undefined)
	}, [])

	const save = () =>
		run(async () => {
			await call('capture', { text, url: url || undefined, when: when || undefined, kind, repeatMinutes: repeat || undefined })
			setSaid(repeat ? `Saved — every ${repeat} minutes.` : when ? 'Saved — it will come back then.' : 'Saved.')
			setText('')
			setWhen('')
			onSaved?.()
		})

	return (
		<div className="wp-stack-sm">
			<textarea
				className="wp-input"
				rows={2}
				autoFocus
				placeholder="What do you want to keep?"
				value={text}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save()
				}}
			/>
			{url && (
				<div className="wp-row wp-small">
					<span className="wp-muted wp-grow" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={url}>
						{url}
					</span>
					<button className="wp-action" onClick={() => setUrl('')}>
						drop the link
					</button>
				</div>
			)}

			<div className="wp-row-wrap wp-small">
				<span className="wp-muted">Bring it back:</span>
				{presets(Date.now()).map((p) => (
					<button key={p.label} className={when === p.when ? 'wp-action wp-ok-text' : 'wp-action'} onClick={() => setWhen(when === p.when ? '' : p.when)}>
						{p.label}
					</button>
				))}
				<WhenField label="Remind me on" value={when} onChange={setWhen} width={190} />
			</div>

			{/* Water, posture, a tablet: the ones worth repeating all day. */}
			<div className="wp-row-wrap wp-small">
				<span className="wp-muted">Keep repeating:</span>
				{[
					{ label: 'no', m: 0 },
					{ label: 'every 30m', m: 30 },
					{ label: 'every 45m', m: 45 },
					{ label: 'hourly', m: 60 },
					{ label: 'every 2h', m: 120 },
				].map((r) => (
					<button key={r.m} className={repeat === r.m ? 'wp-action wp-ok-text' : 'wp-action'} onClick={() => setRepeat(r.m)}>
						{r.label}
					</button>
				))}
			</div>

			<div className="wp-row-wrap">
				<div className="wp-seg" role="group" aria-label="What this is">
					<button aria-pressed={kind === 'task'} onClick={() => setKind('task')}>
						To do
					</button>
					<button aria-pressed={kind === 'note'} onClick={() => setKind('note')}>
						Just keep it
					</button>
				</div>
				<button className="wp-btn wp-btn-sm wp-btn-primary" disabled={busy || !text.trim()} onClick={save}>
					Save
				</button>
				<span className={said ? 'wp-ok-text wp-small' : 'wp-muted wp-small'}>{said || (kind === 'task' ? 'Asked about later' : 'Kept, never nagged about')}</span>
			</div>
			{error && <div className="wp-error wp-small">{error}</div>}
		</div>
	)
}

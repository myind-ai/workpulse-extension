// The forced reminder UI, shared by the in-page overlay and the prompt window.
// It always renders what the background says is owed (overlayState).

import { useEffect, useRef } from 'react'

import { call, orphaned } from '@/lib/rpc'
import { useLive } from '@/ui/hooks'

import { CheckinView } from './CheckinView'
import { CloseoutView } from './CloseoutView'
import { Credit } from './Credit'
import { HealthView } from './HealthView'
import { MeetingView } from './MeetingView'
import { PromptView } from './PromptView'
import { RemindView } from './RemindView'
import { WrapupView } from './WrapupView'

export function Forced({ surface, version = 0, onEmpty }: { surface: 'overlay' | 'window'; version?: number; onEmpty?: () => void }) {
	const { data, error } = useLive(() => call('overlayState'), [version])
	const pending = data?.pending ?? null
	const root = useRef<HTMLDivElement>(null)
	/** Was the keyboard inside the card a moment ago? */
	const typing = useRef(false)

	useEffect(() => {
		// Nothing owed, or this card belongs to an extension load that is gone —
		// either way it should not be on the screen.
		if ((data && !pending) || (error && orphaned(error))) onEmpty?.()
	}, [data, pending, error, onEmpty])

	/**
	 * The card is drawn over the page, but the page keeps the keyboard unless we
	 * take it: without this you type into whatever input was focused behind. A
	 * blocking card also keeps focus, since the page can steal it back at any time.
	 */
	const blocking = !!pending?.blocking
	useEffect(() => {
		if (!pending) return
		if (surface === 'window') window.focus()
		const grab = () => {
			const el = root.current
			if (!el) return
			const first = el.querySelector<HTMLElement>('textarea, input, button, [tabindex]:not([tabindex="-1"])')
			;(first ?? el).focus({ preventScroll: true })
		}
		grab()
		// Pages often refocus their own field a tick after load, so take it back.
		const settle = setTimeout(grab, 150)

		const inCard = (node: Node | null | undefined): boolean => {
			const el = root.current
			return !!node && !!el && (el.contains(node) || el.getRootNode().contains(node))
		}

		const onFocusIn = (e: FocusEvent) => {
			const el = root.current
			if (!el) return
			const target = e.composedPath()[0] as Node | undefined
			if (inCard(target)) return
			// A blocking card holds the keyboard outright. A gentle one only takes
			// it back if it was already typing — a page that refocuses its own
			// field every second would otherwise eat a note half-written.
			if (blocking || typing.current) grab()
		}
		// Whether the keyboard was in the card a moment ago.
		const onFocusOut = () => {
			const shadow = root.current?.getRootNode() as Document | ShadowRoot | undefined
			typing.current = inCard(document.activeElement) || inCard(shadow?.activeElement ?? null)
		}
		document.addEventListener('focusout', onFocusOut, true)
		document.addEventListener('focusin', onFocusIn, true)
		return () => {
			clearTimeout(settle)
			document.removeEventListener('focusin', onFocusIn, true)
			document.removeEventListener('focusout', onFocusOut, true)
		}
	}, [pending?.kind, blocking, surface, version])

	if (!data || !pending) return null

	const body =
		pending.kind === 'health' ? (
			<HealthView pending={pending} />
		) : pending.kind === 'meeting' ? (
			<MeetingView pending={pending} />
		) : pending.kind === 'prompt' && data.prompt ? (
			<PromptView ctx={data.prompt} blocking={pending.blocking} />
		) : pending.kind === 'checkin' && data.checkin ? (
			<CheckinView ctx={data.checkin} blocking={pending.blocking} />
		) : pending.kind === 'closeout' ? (
			<CloseoutView pending={pending} />
		) : pending.kind === 'wrapup' && data.wrapup ? (
			<WrapupView ctx={data.wrapup} />
		) : pending.kind === 'remind' && data.remind ? (
			<RemindView ctx={data.remind} />
		) : null

	// Under every card: whose work this is. It asks for nothing and stops
	// nothing — the card already interrupted you.
	//
	// The wrapper stops key events escaping into the page. The card is drawn over
	// whatever you had open, and that page is still listening: typing a note into
	// a break card was starring things on GitHub and opening Jira's shortcuts,
	// because a keystroke that reaches `document` is the page's as far as the
	// page is concerned. Only the hourly card used to guard against it.
	const swallow = (e: React.KeyboardEvent) => {
		// Not preventDefault: the field still needs the key. Just not the page.
		e.stopPropagation()
	}
	const card = (
		<div className="wp-stack" onKeyDown={swallow} onKeyUp={swallow} onKeyPress={swallow}>
			{body}
			<Credit />
		</div>
	)

	if (surface === 'window') {
		return (
			<div className="wp-root wp-window" ref={root} tabIndex={-1}>
				<div className="wp-modal">{card}</div>
			</div>
		)
	}
	const soft = !pending.blocking && pending.kind === 'checkin'
	return (
		<div className="wp-root" ref={root} tabIndex={-1}>
			<div className={`wp-backdrop${soft ? ' wp-backdrop-soft' : ''}`} role="dialog" aria-modal={!soft} aria-label="WorkPulse reminder">
				<div className="wp-modal" style={soft ? { maxWidth: 380, pointerEvents: 'auto' } : undefined}>
					{card}
				</div>
			</div>
		</div>
	)
}

// "Are you sure?" without leaving the app.
//
// `confirm()` is the browser's dialog, not ours: it looks like a security
// warning from 2004, it cannot say anything in the app's own voice, and in a
// content script it freezes every other thing the extension is doing until it
// is answered. The same objection applies to `prompt()` for naming something,
// which is why the ticket rename stopped using one.
//
// So the question is asked where the button was. One click turns the button
// into the question; the answer is right there; Escape or Cancel puts it back.

import { useEffect, useRef, useState } from 'react'

export function ConfirmButton({
	label,
	question,
	confirmLabel = 'Yes, do it',
	onConfirm,
	className = 'wp-action wp-muted',
	title,
	disabled,
	danger = true,
	children,
}: {
	label?: string
	/** The consequence, in one line. Said at the moment it can still be avoided. */
	question: string
	confirmLabel?: string
	onConfirm: () => void | Promise<unknown>
	className?: string
	title?: string
	disabled?: boolean
	danger?: boolean
	/** Use instead of `label` when the trigger is an icon. */
	children?: React.ReactNode
}) {
	const [asking, setAsking] = useState(false)
	const box = useRef<HTMLSpanElement>(null)

	useEffect(() => {
		if (!asking) return
		const esc = (e: KeyboardEvent) => e.key === 'Escape' && setAsking(false)
		const away = (e: MouseEvent) => {
			if (!box.current?.contains(e.target as Node)) setAsking(false)
		}
		document.addEventListener('keydown', esc)
		document.addEventListener('pointerdown', away)
		return () => {
			document.removeEventListener('keydown', esc)
			document.removeEventListener('pointerdown', away)
		}
	}, [asking])

	if (!asking)
		return (
			<button className={className} title={title ?? question} disabled={disabled} onClick={() => setAsking(true)}>
				{children ?? label}
			</button>
		)

	return (
		<span className="wp-confirm wp-small" ref={box}>
			<span className="wp-muted">{question}</span>
			<button
				className={danger ? 'wp-btn wp-btn-sm wp-btn-danger' : 'wp-btn wp-btn-sm wp-btn-primary'}
				autoFocus
				disabled={disabled}
				onClick={() => {
					setAsking(false)
					void onConfirm()
				}}
			>
				{confirmLabel}
			</button>
			<button className="wp-action wp-muted" onClick={() => setAsking(false)}>
				Cancel
			</button>
		</span>
	)
}

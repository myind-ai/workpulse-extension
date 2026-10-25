// A ⋯ menu.
//
// A row of eight icons is a row of eight guesses: every one needs its tooltip
// read before it can be pressed, and the two you use daily are no easier to
// find than the one you use twice a year. So the row keeps what you reach for
// and everything else moves in here, with its name next to its icon.

import { useEffect, useRef, useState } from 'react'

import { Icon, type IconName } from '@/ui/Icon'

export interface MenuItem {
	icon: IconName
	label: string
	/** The longer sentence, for the tooltip. */
	title?: string
	/** Deleting things reads differently from everything else. */
	danger?: boolean
	disabled?: boolean
	onPick: () => void
}

export function Menu({ items, label = 'More actions', disabled }: { items: MenuItem[]; label?: string; disabled?: boolean }) {
	const [open, setOpen] = useState(false)
	const box = useRef<HTMLDivElement>(null)

	// Any click that is not in the menu closes it, which is what every other
	// menu on the computer does.
	useEffect(() => {
		if (!open) return
		const away = (e: MouseEvent) => {
			if (!box.current?.contains(e.target as Node)) setOpen(false)
		}
		const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
		document.addEventListener('pointerdown', away)
		document.addEventListener('keydown', esc)
		return () => {
			document.removeEventListener('pointerdown', away)
			document.removeEventListener('keydown', esc)
		}
	}, [open])

	if (!items.length) return null
	return (
		<div className="wp-menu" ref={box}>
			<button className="wp-icon-btn" disabled={disabled} title={label} aria-label={label} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}>
				<Icon name="dots" size={15} />
			</button>
			{open && (
				<div className="wp-menu-list" role="menu">
					{items.map((it) => (
						<button
							key={it.label}
							className={`wp-menu-item${it.danger ? ' wp-menu-danger' : ''}`}
							role="menuitem"
							disabled={it.disabled}
							title={it.title}
							onClick={() => {
								setOpen(false)
								it.onPick()
							}}
						>
							<Icon name={it.icon} size={14} /> {it.label}
						</button>
					))}
				</div>
			)}
		</div>
	)
}

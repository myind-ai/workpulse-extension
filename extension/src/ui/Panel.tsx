// A card that is closed until you want it. Built on `<details>`, so the browser
// keeps the open state, the keyboard works, and the page can be long without
// feeling long. `data-wp-section` lets the settings search find and open it.

import type { ReactNode } from 'react'

export function Panel({
	title,
	hint,
	keywords,
	open,
	right,
	children,
}: {
	title: string
	/** One line under the title, visible while the panel is shut. */
	hint?: string
	/** Words someone might search for that the contents do not contain. */
	keywords?: string
	open?: boolean
	/** A chip or count on the right of the summary. */
	right?: ReactNode
	children: ReactNode
}) {
	return (
		<details className="wp-panel" data-wp-section data-wp-keywords={keywords} open={open}>
			<summary className="wp-panel-head">
				<span className="wp-grow" style={{ minWidth: 0 }}>
					<span className="wp-panel-title">{title}</span>
					{hint && <span className="wp-panel-hint">{hint}</span>}
				</span>
				{right}
			</summary>
			<div className="wp-panel-body">{children}</div>
		</details>
	)
}

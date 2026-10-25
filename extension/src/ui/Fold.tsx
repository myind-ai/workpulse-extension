// A collapsible block, on `<details>` so the browser keeps the open state and
// the keyboard works without any of it being written here. For widget panels
// where a list grows past what a 380px popup should show at once.

import type { ReactNode } from 'react'

export function Fold({ title, count, open, children }: { title: string; count?: number; open?: boolean; children: ReactNode }) {
	return (
		<details className="wp-fold" open={open}>
			<summary className="wp-fold-head">
				<span className="wp-grow">{title}</span>
				{count != null && <span className="wp-muted wp-small">{count}</span>}
			</summary>
			<div className="wp-fold-body">{children}</div>
		</details>
	)
}

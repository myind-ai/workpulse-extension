// A button that says what it is doing while it does it. Anything that leaves
// this machine — GitHub, Zoho — takes long enough that a button which only
// greys out reads as broken.

import type { ReactNode } from 'react'

export function Busy({ busy, doing, children }: { busy: boolean; doing: string; children: ReactNode }) {
	return (
		<>
			{busy && <span className="wp-spin" aria-hidden />}
			<span>{busy ? doing : children}</span>
		</>
	)
}

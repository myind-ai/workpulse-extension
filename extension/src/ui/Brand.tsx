export function LogoMark({ size = 22 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
			<rect x="1" y="1" width="30" height="30" rx="8" fill="var(--wp-accent)" />
			<polyline points="6,17 11,17 13,12 17,22 19,15 21,17 26,17" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	)
}

export function Brand({ label = 'WorkPulse' }: { label?: string }) {
	return (
		<span className="wp-brand">
			<LogoMark />
			{label}
		</span>
	)
}

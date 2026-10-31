// A handful of line glyphs, drawn in currentColor so they take the colour of
// whatever they sit in. Inline rather than a sprite: eight icons are not worth
// a font, a build step or a network request.

const PATHS = {
	check: 'M4 10.5l4 4 8-9',
	clock: 'M10 5v5l3 2M17 10a7 7 0 11-14 0 7 7 0 0114 0z',
	pencil: 'M4 16l1-4 8-8 3 3-8 8-4 1z',
	list: 'M7 6h9M7 10h9M7 14h6M4 6h.01M4 10h.01M4 14h.01',
	bookmark: 'M6 4h8v13l-4-3-4 3V4z',
	bell: 'M10 3a4 4 0 014 4v4l2 2H4l2-2V7a4 4 0 014-4zM8 15a2 2 0 004 0',
	grid: 'M4 4h5v5H4zM11 4h5v5h-5zM4 11h5v5H4zM11 11h5v5h-5z',
	cog: 'M10 7.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM10 2v2M10 16v2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M2 10h2M16 10h2M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4',
	external: 'M8 4H4v12h12v-4M12 3h5v5M17 3l-7 7',
	plus: 'M10 4v12M4 10h12',
	trash: 'M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10M9 9v4M11 9v4',
	github: 'M10 2.3a7.7 7.7 0 00-2.43 15c.38.07.52-.17.52-.37v-1.3c-2.14.47-2.6-1.03-2.6-1.03-.35-.9-.86-1.13-.86-1.13-.7-.48.06-.47.06-.47.78.05 1.18.8 1.18.8.69 1.18 1.81.84 2.25.64.07-.5.27-.84.49-1.03-1.71-.2-3.5-.86-3.5-3.8 0-.84.3-1.53.79-2.07-.08-.2-.34-.98.07-2.05 0 0 .65-.2 2.12.79a7.3 7.3 0 013.86 0c1.47-1 2.12-.79 2.12-.79.41 1.07.15 1.85.07 2.05.49.54.79 1.23.79 2.07 0 2.95-1.8 3.6-3.51 3.79.28.24.52.71.52 1.43v2.12c0 .2.14.45.53.37A7.7 7.7 0 0010 2.3z',
	group: 'M3 5h6v4H3zM11 5h6v4h-6zM3 11h6v4H3zM11 11h6v4h-6z',
	layers: 'M10 3l7 4-7 4-7-4 7-4zM3 11l7 4 7-4',
	dashboard: 'M3 5.5h14v9.5a1 1 0 01-1 1H4a1 1 0 01-1-1V5.5zM3 5.5V4.5a1 1 0 011-1h12a1 1 0 011 1v1M5.2 4.6h.01M7 4.6h.01',
	bulb: 'M10 2.5a4.5 4.5 0 00-2.6 8.2V13h5.2v-2.3A4.5 4.5 0 0010 2.5zM8.4 15.5h3.2M9 17.5h2',
	play: 'M6 4l10 6-10 6V4z',
	dots: 'M5 10h.01M10 10h.01M15 10h.01',
	copy: 'M7 7h8v9H7zM5 13H3V4h9v2',
	move: 'M4 10h12M12 6l4 4-4 4',
	archive: 'M3 4h14v4H3zM5 8v8h10V8M8 11h4',
	stop: 'M5 5h10v10H5z',
	mic: 'M10 3a2 2 0 012 2v4a2 2 0 01-4 0V5a2 2 0 012-2zM5 9a5 5 0 0010 0M10 14v3M8 17h4',
	'mic-off': 'M10 3a2 2 0 012 2v3M8 6v3a2 2 0 002.8 1.8M5 9a5 5 0 007.6 4.3M10 14v3M8 17h4M3 3l14 14',
	download: 'M10 3v9M6.5 8.5L10 12l3.5-3.5M4 15h12',
	refresh: 'M16 7V3l-1.7 1.7A7 7 0 103 12M4 13v4l1.7-1.7A7 7 0 0017 8',
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 15 }: { name: IconName; size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
			<path d={PATHS[name]} />
		</svg>
	)
}

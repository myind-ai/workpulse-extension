// One way to open the box, that everything else goes through.
//
// The sidebar button used to work by firing a synthetic ⌘K at the window, which
// meant the button and the keystroke shared a single point of failure: if the
// key handler was not listening, neither worked, and the one thing meant to
// rescue the other was broken in the same way.
//
// So the opener is its own event. The keystroke calls it, the button calls it,
// the widget calls it, and any of them works when the others do not.

const EVENT = 'workpulse:palette'

export function openPalette() {
	document.dispatchEvent(new CustomEvent(EVENT))
}

export function onOpenPalette(fn: () => void): () => void {
	const on = () => fn()
	document.addEventListener(EVENT, on)
	return () => document.removeEventListener(EVENT, on)
}

/**
 * Two keystrokes, for two places, and the difference matters.
 *
 * On WorkPulse's own pages — the dashboard, the widget — ⌘K is free and is what
 * muscle memory reaches for, so it is used there and steals nothing from
 * anybody.
 *
 * On somebody else's page it would steal everything: ⌘K belongs to Slack,
 * Linear, Notion, GitHub and half the web besides, and an extension that claims
 * it claims it on every page for ever. Out there the chord is **Alt+Shift+K**,
 * a corner neither Chrome nor the sites people actually use have taken.
 *
 * `code` as well as `key`, because Alt on a Mac produces a different character
 * — ⌥K is `˚` — and the physical key is the only reliable half.
 */
const isK = (e: KeyboardEvent) => e.key?.toLowerCase() === 'k' || e.code === 'KeyK'

/** On our own pages: ⌘K or ⌃K. */
export function isPaletteKey(e: KeyboardEvent): boolean {
	if (!(e.metaKey || e.ctrlKey) || e.altKey) return false
	return isK(e)
}

/** On anybody else's page: Alt+Shift+K, which nothing else wants. */
export function isPaletteChord(e: KeyboardEvent): boolean {
	if (!e.altKey || !e.shiftKey || e.metaKey || e.ctrlKey) return false
	return isK(e)
}

/**
 * What closes it. Escape, with or without anything held down.
 *
 * Here beside the keys that open it, because the pair has to stay symmetrical:
 * a box that opens from a keystroke and cannot be closed by one is a box people
 * stop opening.
 */
export const isDismissKey = (e: KeyboardEvent): boolean => e.key === 'Escape'

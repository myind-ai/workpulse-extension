// Getting above a website's own modal.
//
// Both overlays already sit at the maximum z-index there is, and it is still
// not enough on some sites — because z-index is not what beats them. A modal
// opened with `<dialog>.showModal()` or a `[popover]` is promoted to the
// browser's **top layer**, which paints above every z-index in the document by
// specification. There is no number high enough; 2147483647 loses to it just
// as surely as 1 does.
//
// So the overlay joins the top layer rather than bidding higher. Within it the
// most recently shown element wins, and ours is shown when the keystroke is
// pressed — which is always after the page put its own dialog up.
//
// `manual` because dismissal is ours: Escape and clicking away are handled in
// the overlay itself, and letting the browser light-dismiss would close the box
// out from under half of what it does.

/**
 * The styles a popover gets for free and must not keep.
 *
 * A popover is a centred, `fit-content` box with a border, a background and
 * padding — perfectly sensible for a tooltip and completely wrong for a
 * full-screen overlay, which is what both of ours are.
 */
const RESET = [
	'position:fixed',
	'inset:0',
	'width:100vw',
	'height:100vh',
	'max-width:none',
	'max-height:none',
	'margin:0',
	'padding:0',
	'border:0',
	'background:transparent',
	'overflow:visible',
].join(';')

/**
 * Keep the keyboard inside the overlay.
 *
 * Being painted on top is only half of being on top. A `popover` does not
 * trap focus the way `dialog.showModal()` does, so Tab walks straight out of
 * our box and into whatever the page had open behind it — and on a site with
 * its own modal that is where every subsequent keystroke lands, while our
 * overlay sits visibly in front doing nothing.
 *
 * Events from inside a shadow root are retargeted to the host, so anything
 * still inside ours reports the host as its target and is left alone.
 * Anything else means focus has escaped and is taken back.
 *
 * Returns the undo, which the caller must run when the overlay goes — a
 * listener on `document` that outlives the thing it guards is a leak that also
 * makes the page unusable.
 */
export function trapFocus(host: HTMLElement): () => void {
	const back = (e: FocusEvent) => {
		if (e.target === host || host.contains(e.target as Node)) return
		// Not preventDefault: focus has already moved by the time this fires.
		host.focus({ preventScroll: true })
	}
	// Focusable at all, so there is somewhere to put it back to.
	if (!host.hasAttribute('tabindex')) host.setAttribute('tabindex', '-1')
	document.addEventListener('focusin', back, true)
	return () => document.removeEventListener('focusin', back, true)
}

/**
 * Put the host in the top layer, if this browser has one.
 *
 * Returns whether it worked. When it does not — an older Chrome, or a host
 * that is not in the document yet — the maximum z-index still applies, which
 * is above everything on the page that is not itself in the top layer.
 */
export function liftToTopLayer(host: HTMLElement): boolean {
	const el = host as HTMLElement & { showPopover?: () => void }
	if (typeof el.showPopover !== 'function') return false
	try {
		host.setAttribute('popover', 'manual')
		el.showPopover()
		// After showing, so the UA's own popover rules are already applied and
		// these win on specificity as inline styles.
		host.style.cssText += `;${RESET}`
		return true
	} catch {
		// Already showing, or not connected. Neither is worth a broken overlay.
		host.removeAttribute('popover')
		return false
	}
}

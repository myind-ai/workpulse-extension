// The keystroke, on every page, whatever Chrome did with it.
//
// Alt+Shift+K is a Chrome command, which is the right way to take a key: the
// page's own handlers never see it. But Chrome **silently refuses** a
// suggested key another extension already holds — no error, no warning, the
// command simply never fires.
//
// The palette script carried its own fallback listener for exactly that. It
// could not help: that script is injected on demand, so on a fresh tab with a
// refused command there was nothing in the page to listen, and no way to get
// it there without using the shortcut that did not work.
//
// So the listener lives here instead — everywhere, always, and deliberately
// tiny. No React, no styles, no DOM, no state: one capture-phase keydown and
// a message. The weight that justified keeping the palette out of every page
// is the palette itself, not a listener.

import { isPaletteChord } from '@/ui/palette-open'

export default defineContentScript({
	matches: ['<all_urls>'],
	runAt: 'document_start',
	main(ctx) {
		const onKey = (e: KeyboardEvent) => {
			if (!isPaletteChord(e)) return
			// Capture, and stopped here, so a page that binds the same chord
			// never sees it either.
			e.preventDefault()
			e.stopPropagation()
			chrome.runtime.sendMessage({ wp: 'palette-key' }).catch(() => {
				// The worker is asleep or the extension was reloaded. Nothing to
				// do and nothing worth saying to the page about it.
			})
		}
		document.addEventListener('keydown', onKey, true)
		ctx.onInvalidated(() => document.removeEventListener('keydown', onKey, true))
	},
})

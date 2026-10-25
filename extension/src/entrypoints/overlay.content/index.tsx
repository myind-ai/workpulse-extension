// The forced reminder overlay. Registered at runtime (not on every page): the
// background injects it into the active tab only when a reminder is owed, then
// pokes it with { wp: 'overlay' } to refresh or hide.

import ReactDOM from 'react-dom/client'
import type { ShadowRootContentScriptUi } from 'wxt/utils/content-script-ui/shadow-root'
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root'

import { liftToTopLayer, trapFocus } from '@/ui/top-layer'

import '@/ui/theme.css'
import { overlayExempt } from '@/core/setup'
import { call, orphaned } from '@/lib/rpc'
import { Forced } from '@/ui/forced/Forced'

export default defineContentScript({
	matches: ['<all_urls>'],
	registration: 'runtime',
	cssInjectionMode: 'ui',
	async main(ctx) {
		const w = window as unknown as { __workpulseOverlay?: boolean }
		if (w.__workpulseOverlay) return
		w.__workpulseOverlay = true

		let ui: ShadowRootContentScriptUi<ReactDOM.Root> | null = null
		// A page load and a background poke can both call sync() at once; create the UI only once.
		let creating: Promise<ShadowRootContentScriptUi<ReactDOM.Root>> | null = null
		let version = 0
		let savedOverflow: string | null = null

		const unlockScroll = () => {
			if (savedOverflow != null) document.documentElement.style.overflow = savedOverflow
			savedOverflow = null
		}
		let untrap: (() => void) | null = null
		const unmount = () => {
			// Before the host goes, or the listener outlives what it guarded and
			// keeps dragging focus to an element that is no longer there.
			untrap?.()
			untrap = null
			ui?.remove()
			ui = null
			creating = null
			unlockScroll()
		}

		// An overlay left behind by a previous extension load cannot be reached by
		// the background, so nothing can hide it and its buttons all fail with
		// "Extension context invalidated". It has to remove itself.
		ctx.onInvalidated(unmount)

		const sync = async () => {
			if (!ctx.isValid) return unmount()
			const state = await call('overlayState').catch((e: unknown) => {
				if (orphaned(e)) unmount()
				return null
			})
			if (!state?.pending || overlayExempt(location.href, state.pending.kind)) return unmount()
			version += 1
			if (!ui) {
				creating ??= createShadowRootUi(ctx, {
					name: 'workpulse-reminder',
					position: 'overlay',
					anchor: 'body',
					append: 'last',
					zIndex: 2147483647,
					onMount: (container) => ReactDOM.createRoot(container),
					onRemove: (root) => root?.unmount(),
				}).then((created) => {
					created.mount()
					// A site's own modal is in the top layer, where no z-index
					// reaches it. A forced card that cannot be seen is not forced.
					liftToTopLayer(created.shadowHost)
					// A forced card that the page can Tab focus out of is not forced.
					untrap = trapFocus(created.shadowHost)
					return created
				})
				ui = await creating
			}
			if (state.pending.blocking && savedOverflow == null) {
				savedOverflow = document.documentElement.style.overflow
				document.documentElement.style.overflow = 'hidden'
			}
			if (!state.pending.blocking) unlockScroll()
			ui.mounted?.render(<Forced surface="overlay" version={version} onEmpty={unmount} />)
		}

		chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
			const m = msg as { wp?: string; hide?: boolean }
			if (m?.wp !== 'overlay') return false
			// `hide` is the background saying the card belongs on another tab now;
			// without it this would re-show itself, since something is still owed.
			if (m.hide) unmount()
			else void sync()
			reply(true)
			return false
		})
		void sync()
	},
})

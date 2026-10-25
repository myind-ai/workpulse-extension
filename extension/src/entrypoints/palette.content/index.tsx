// The box, on whatever page you are on.
//
// Registered at runtime like the reminder overlay — not injected into every tab
// at load, but put there the moment the keystroke is pressed. The shortcut is a
// Chrome command, so Chrome itself delivers it and the page's own handlers
// never see the keystroke.

import ReactDOM from 'react-dom/client'
import type { ShadowRootContentScriptUi } from 'wxt/utils/content-script-ui/shadow-root'
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root'

import { liftToTopLayer, trapFocus } from '@/ui/top-layer'

import '@/ui/theme.css'
import { Palette } from '@/ui/Palette'

export default defineContentScript({
	matches: ['<all_urls>'],
	registration: 'runtime',
	cssInjectionMode: 'ui',
	async main(ctx) {
		let ui: ShadowRootContentScriptUi<ReactDOM.Root> | null = null
		let untrap: (() => void) | null = null

		const close = () => {
			// Before the host goes, or the listener outlives what it was guarding.
			untrap?.()
			untrap = null
			ui?.remove()
			ui = null
		}

		const open = async () => {
			// The same keystroke closes it: a box you cannot dismiss the way you
			// opened it is a box people stop opening.
			if (ui) return close()
			ui = await createShadowRootUi(ctx, {
				name: 'workpulse-palette',
				position: 'overlay',
				anchor: 'body',
				append: 'last',
				zIndex: 2147483646,
				onMount: (container) => {
					const root = ReactDOM.createRoot(container)
					root.render(<Palette onClose={close} page={{ title: document.title, url: location.href }} />)
					return root
				},
				onRemove: (root) => root?.unmount(),
			})
			ui.mount()
			// A site's own modal is in the top layer, where no z-index reaches it
			// — and keeps taking Tab even once we are painted in front of it.
			liftToTopLayer(ui.shadowHost)
			untrap = trapFocus(ui.shadowHost)
		}

		chrome.runtime.onMessage.addListener((msg: { wp?: string }) => {
			if (msg?.wp === 'palette') void open()
		})

		ctx.onInvalidated(close)
	},
})

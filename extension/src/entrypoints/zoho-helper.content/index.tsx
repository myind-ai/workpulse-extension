// Guided-setup helper on Zoho's pages. Registered at runtime: the background
// injects it only while a setup step is running (see entrypoints/background.ts),
// so ordinary Zoho visits load nothing.

import ReactDOM from 'react-dom/client'
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root'

import '@/ui/theme.css'
import { call } from '@/lib/rpc'
import { AttendanceHelper, ClientHelper } from '@/ui/SetupHelper'

export default defineContentScript({
	matches: ['https://*.zoho.in/*', 'https://*.zoho.com/*', 'https://*.zoho.eu/*', 'https://*.zoho.com.au/*'],
	registration: 'runtime',
	cssInjectionMode: 'ui',
	async main(ctx) {
		const w = window as unknown as { __workpulseHelper?: boolean }
		if (w.__workpulseHelper) return
		w.__workpulseHelper = true

		const [state, info] = await Promise.all([call('setupState'), call('setupInfo')]).catch(() => [null, null])
		if (!state || !info) return
		const onConsole = location.hostname.startsWith('api-console.')
		const onPeople = location.hostname.startsWith('people.')
		if (!(onConsole && state.flags.client) && !(onPeople && state.flags.attendance)) return

		const ui = await createShadowRootUi(ctx, {
			name: 'workpulse-setup',
			position: 'overlay',
			anchor: 'body',
			append: 'last',
			zIndex: 2147483647,
			onMount: (container) => {
				const root = ReactDOM.createRoot(container)
				const close = () => {
					void call('cancelSetup')
					ui.remove()
					w.__workpulseHelper = false
				}
				root.render(onConsole ? <ClientHelper redirectUrl={info.redirectUrl} dataCenter={info.dataCenter} onClose={close} /> : <AttendanceHelper onClose={close} />)
				return root
			},
			onRemove: (root) => root?.unmount(),
		})
		ui.mount()
	},
})

import { defineConfig } from 'wxt'

/** The official Zoho API ships off; `identity` is only needed by its sign-in. */
const apiEnabled = process.env.WXT_ENABLE_API === 'true'
/** A Web Store build: the Store issues the id, and the recorder is opt-in there. */
const forStore = process.env.WXT_STORE === 'true'

// WorkPulse extension. Boilerplate copied from openreply-agent-ext (WXT + React + TS + Vitest).
export default defineConfig({
	srcDir: 'src',
	// Store and local builds must never share an output folder: they differ by the
	// signing key, so overwriting one with the other changes the extension's id
	// under a folder Chrome has already loaded.
	outDir: forStore ? '.output/store' : '.output',
	modules: ['@wxt-dev/module-react'],
	// Specs live next to the code; keep *.test.* files from becoming entrypoints.
	hooks: {
		'entrypoints:found'(_wxt, infos) {
			for (let i = infos.length - 1; i >= 0; i--) {
				if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(infos[i].inputPath)) infos.splice(i, 1)
			}
		},
	},
	manifest: {
		name: 'WorkPulse',
		description: 'Hourly work log, check-in reminders and timesheet push that keep Zoho People gap-free. Works from your own signed-in Zoho tab.',
		version: '1.6.1',
		// Pins the extension ID for local installs (private key in .secrets/,
		// gitignored). The Web Store issues its own id, and rejects a build that
		// carries someone else's key, so the store build omits it.
		// Local ID: eipfgalnomnkdbehopenpiopogejenef
		...(forStore
			? {}
			: {
					key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsEMgIrMCTjjk2d0cKuzvzojUtN3Z0jC/LE6Mz7oQQZR1III3e2J4KRV97Q4hqRSObSxGDjX2XkCR6yNxXw5N83ZYHBnLs1P8B/XzEdcC/IWEc4PZhUy5FyO+TiwtBqgwMqjASZsZoWTbkQe3dXYxFq3OHWZDOSyScAon2UWj3+wNEiPpmE4XN2+u/aS+KeEIyXNTlCNhyhp/styyFsC1+j1JoOWYFO5+jDt/myozEi8GpIHpSmQBJexnOwhAyBduWJpYvAS95njbcsry2/hC2lpaWhTfed7k70p5BMvchpAj/fpGVfqJ1IFqcNRFepFl0HtZxx2Wqv6fGTqc6YBjOwIDAQAB',
				}),
		// webRequest is observation only (no blocking) and only while you run the
		// automatic setup, so it is optional: the Store install asks for nothing
		// the first screen does not need.
		permissions: ['alarms', 'idle', 'notifications', 'offscreen', 'storage', 'unlimitedStorage', 'tabs', 'scripting', 'contextMenus', ...(apiEnabled ? ['identity'] : [])],
		// `history` is asked for only when you switch the suggestion on: an install
		// prompt saying "read your browsing history" is a heavy price for a feature
		// most people will never turn on.
		// `desktopCapture` is optional and asked for the first time somebody
		// records: an install prompt saying "capture the contents of your screen"
		// is a heavy price for a feature most people will never use. It is what
		// lets a recording cover a whole screen or another application's window,
		// not only the tab in front of you — half of what makes a bug video worth
		// watching happens outside the tab.
		optional_permissions: ['webRequest', 'tabGroups', 'history', 'desktopCapture'],
		// <all_urls> lets the forced overlay appear on whatever page you are on.
		// Zoho hosts are listed for every data centre; 127.0.0.1/localhost are for the desktop app bridge.
		host_permissions: [
			'<all_urls>',
			'https://*.zoho.in/*',
			'https://*.zoho.com/*',
			'https://*.zoho.eu/*',
			'https://*.zoho.com.au/*',
			'http://127.0.0.1/*',
			'http://localhost/*',
		],
		action: { default_title: 'WorkPulse' },
		// One keystroke, on any page. Chrome delivers it, so the page's own
		// shortcut handlers never see it — and it works on pages a content script
		// has never been asked for.
		// Alt+Shift, deliberately. ⌘K and ⌃K belong to half the web — Slack,
		// Linear, Notion, GitHub — and an extension that takes one of those takes
		// it from every one of them, on every page, for ever. Alt+Shift is a
		// corner neither Chrome nor the sites people actually use have claimed.
		commands: {
			'open-palette': {
				suggested_key: { default: 'Alt+Shift+K', mac: 'Alt+Shift+K' },
				description: 'WorkPulse: log, note, find — on any page',
			},
			'log-now': {
				suggested_key: { default: 'Alt+Shift+L', mac: 'Alt+Shift+L' },
				description: 'WorkPulse: log the last slot',
			},
		},
		// The break and reminder illustrations. The overlay draws them on whatever
		// page you are on, so the page has to be allowed to load them — and an
		// art file that has not been drawn yet simply does not render.
		web_accessible_resources: [{ resources: ['art/*'], matches: ['<all_urls>'] }],
		icons: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' },
	},
})

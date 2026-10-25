// Checks you in or out on your own signed-in Zoho People tab — the no-API
// equivalent of Full mode's "Check in now". Injected only by an explicit click
// (never by a tick), kept in its own script so the attendance reader can never
// reach a write.
//
// Zoho's own punch is a multipart POST to AttendanceAction.zp?mode=punchIn|Out
// carrying conreqcsr and your coordinates. The token is read live off the page
// and the coordinates come from the browser now — a captured location is never
// replayed, because asserting a stale place to an attendance system is worse
// than sending none at all.
//
// Success is not assumed from the reply: the background then reads Zoho's own
// status, so the recorded time is Zoho's, not ours.

import { call } from '@/lib/rpc'

/** Zoho's CSRF token is a long hex string; where it lives moves between pages. */
const TOKENISH = /^[a-f0-9]{32,}$/i

/**
 * Hunts the page for Zoho's conreqcsr token: its cookie jar, its form fields,
 * then the markup itself. A punch without it comes back HTTP 400, so the
 * recorded value (same session) is the last resort before giving up.
 */
function csrfToken(fallback?: string): string | null {
	for (const c of document.cookie.split(';')) {
		const [k, ...rest] = c.split('=')
		const v = decodeURIComponent(rest.join('=').trim())
		if (/csr/i.test(k) && TOKENISH.test(v)) return v
	}
	for (const f of document.querySelectorAll<HTMLInputElement>('input[name*="csr" i], input[id*="csr" i]')) {
		if (TOKENISH.test(f.value)) return f.value
	}
	const inMarkup = document.documentElement.innerHTML.match(/conreqcsr["'\s:=]+([a-f0-9]{32,})/i)
	if (inMarkup) return inMarkup[1]
	return fallback && TOKENISH.test(fallback) ? fallback : null
}

/** Zoho's page asks for location itself, so the grant is usually already there. */
function here(): Promise<GeolocationPosition | null> {
	if (!navigator.geolocation) return Promise.resolve(null)
	return new Promise((resolve) => {
		navigator.geolocation.getCurrentPosition(
			(p) => resolve(p),
			() => resolve(null),
			{ timeout: 5000, maximumAge: 60_000 },
		)
	})
}

export default defineContentScript({
	matches: ['https://*.zoho.in/*', 'https://*.zoho.com/*', 'https://*.zoho.eu/*', 'https://*.zoho.com.au/*'],
	registration: 'runtime',
	async main() {
		const task = await call('punchTask').catch(() => null)
		if (!task) return

		const token = csrfToken(task.token)
		if (!token) {
			// Sending without it just earns an HTTP 400: say what is actually wrong.
			await call('reportPunch', {
				checkIn: task.checkIn,
				ok: false,
				status: 0,
				body: "Could not find Zoho's security token on this tab. Open Zoho People's own page (people.zoho.in/logiciel/zp) and try again.",
				located: false,
			})
			return
		}

		const body = new FormData()
		body.set('conreqcsr', token)
		body.set('urlMode', 'myspace')
		const pos = await here()
		if (pos) {
			body.set('latitude', String(pos.coords.latitude))
			body.set('longitude', String(pos.coords.longitude))
			body.set('accuracy', String(Math.round(pos.coords.accuracy)))
		}

		try {
			// No Content-Type header: the browser sets multipart with its own boundary.
			const res = await fetch(task.url, { method: 'POST', credentials: 'include', headers: { Accept: '*/*', 'X-Requested-With': 'XMLHttpRequest' }, body })
			const text = await res.text()
			await call('reportPunch', { checkIn: task.checkIn, ok: res.ok, status: res.status, body: text.slice(0, 1000), located: !!pos })
		} catch (e) {
			await call('reportPunch', { checkIn: task.checkIn, ok: false, status: 0, body: `could not send it: ${(e as Error).message}`, located: !!pos })
		}
	},
})

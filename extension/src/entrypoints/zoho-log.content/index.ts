// Saves the day's time logs through Zoho's own timesheet call, on your signed-in
// tab. Injected only by your push in Review — never by a tick — and kept in its
// own script so neither the attendance reader nor the punch can reach it.
//
// The bodies are molded in the worker from your captured save: the ids that
// identify your org stay exactly as Zoho wrote them, and only the date, hours,
// work item and notes are ours. Rows go one at a time so a failure halfway
// leaves a known state, and every outcome is reported back.

import { savedTimelog } from '@/core/zoho-page'
import { call } from '@/lib/rpc'

const TOKENISH = /^[a-f0-9]{32,}$/i

function cookie(name: string): string | null {
	const hit = document.cookie.split(';').find((c) => c.trim().toLowerCase().startsWith(`${name.toLowerCase()}=`))
	return hit ? decodeURIComponent(hit.slice(hit.indexOf('=') + 1).trim()) : null
}

/** The page's live token, so a captured one going stale cannot fail the push. */
function csrfToken(): string | null {
	for (const c of document.cookie.split(';')) {
		const [k, ...rest] = c.split('=')
		const v = decodeURIComponent(rest.join('=').trim())
		if (/csr/i.test(k) && TOKENISH.test(v)) return v
	}
	const field = document.querySelector<HTMLInputElement>('input[name*="csr" i]')
	if (field && TOKENISH.test(field.value)) return field.value
	return cookie('CSRF_TOKEN')
}

export default defineContentScript({
	matches: ['https://*.zoho.in/*', 'https://*.zoho.com/*', 'https://*.zoho.eu/*', 'https://*.zoho.com.au/*'],
	registration: 'runtime',
	async main() {
		const task = await call('writeTask').catch(() => null)
		if (!task) return
		const token = csrfToken()
		const headers: Record<string, string> = { Accept: '*/*', 'X-Requested-With': 'XMLHttpRequest' }
		headers['Content-Type'] = task.contentType ?? 'application/x-www-form-urlencoded; charset=UTF-8'

		const results: { ok: boolean; status: number; body: string }[] = []
		for (const body of task.bodies) {
			const params = new URLSearchParams(body)
			if (token) for (const [k] of [...params]) if (/csr/i.test(k)) params.set(k, token)
			try {
				const res = await fetch(task.url, { method: 'POST', credentials: 'include', headers, body: params.toString() })
				const text = await res.text()
				// Zoho answers 200 whether it worked or not; the verdict is the code
				// in the body, so that is what decides — see core/zoho-page.
				const verdict = savedTimelog(res.status, text)
				results.push({ ok: verdict.ok, status: res.status, body: (verdict.message ?? text).slice(0, 400) })
			} catch (e) {
				results.push({ ok: false, status: 0, body: `could not send it: ${(e as Error).message}` })
			}
		}
		await call('reportTimelogs', { date: task.date, results, uids: task.uids })
	},
})

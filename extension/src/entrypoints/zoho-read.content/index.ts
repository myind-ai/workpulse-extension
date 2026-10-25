// Reads your own attendance on your signed-in Zoho People tab, for roles whose
// API access is blocked. Injected on demand by the background (never on an
// ordinary Zoho visit), it tries two sources and reports the first that answers:
//
//  1. the request Zoho's own web app uses, replayed from this page — same-origin,
//     so the browser attaches your session itself and CORS does not apply. Zoho's
//     reads are POSTs (AttendanceAction.zp with mode=getStatus) whose CSRF token
//     travels in the body as conreqcsr, so the captured body is reused with a
//     fresh token when the page has one;
//  2. First In / Last Out / Total Hours read off the page.
//
// It only ever reads: a request that could punch you in or out is refused here
// as well as when it is chosen, so a stale saved request can never punch you.

import { allProjects, datedForm, datedUrl, readAttendance, readJobList, readJobs, readJson, readProjects, usable, withProject, writeLooking } from '@/core/zoho-page'
import { call } from '@/lib/rpc'
import type { SeenRequest } from '@/lib/store'

const FORM = 'application/x-www-form-urlencoded'

function cookie(name: string): string | null {
	const hit = document.cookie.split(';').find((c) => c.trim().toLowerCase().startsWith(`${name.toLowerCase()}=`))
	return hit ? decodeURIComponent(hit.slice(hit.indexOf('=') + 1).trim()) : null
}

/** The page's live CSRF value for `name`, when it exposes one. */
function freshToken(name: string): string | null {
	const field = document.querySelector<HTMLInputElement>(`input[name="${name}"]`)
	return field?.value || cookie(name)
}

/** Replaces each csrf-ish field in a form body with the page's current token. */
function refreshCsrf(body: string): string {
	const params = new URLSearchParams(body)
	for (const [k] of [...params]) {
		if (!/csrf|csr$/i.test(k)) continue
		const fresh = freshToken(k)
		if (fresh) params.set(k, fresh)
	}
	return params.toString()
}

export default defineContentScript({
	matches: ['https://*.zoho.in/*', 'https://*.zoho.com/*', 'https://*.zoho.eu/*', 'https://*.zoho.com.au/*'],
	registration: 'runtime',
	async main() {
		const task = await call('pageTask').catch(() => null)
		if (!task) return
		const req = task.req

		if (req && !writeLooking(req.url, req.body)) {
			const url = datedUrl(req.url, task.date)
			const form = (req.contentType ?? '').includes(FORM)
			const headers: Record<string, string> = { Accept: 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest' }
			if (req.contentType) headers['Content-Type'] = req.contentType
			const body = form ? refreshCsrf(datedForm(req.body, task.date) ?? '') : req.body
			try {
				// Cross-host would be a CORS request from here, with no session: say so
				// rather than report an opaque failure.
				if (new URL(url).origin !== location.origin) throw new Error(`open ${new URL(url).host} in this tab instead — that endpoint is on another Zoho host`)
				const res = await fetch(url, { method: req.method || 'GET', credentials: 'include', headers, body: req.method === 'GET' ? undefined : body })
				const text = await res.text()
				await call('reportProbe', { url, status: res.status, ok: res.ok, body: text })
				if (res.ok) {
					const parsed = readJson(JSON.parse(text) as unknown, task.date)
					if (usable(parsed)) return void (await call('reportPageRead', parsed, 'endpoint'))
				}
			} catch (e) {
				await call('reportProbe', { url, status: 0, ok: false, body: `could not read it: ${(e as Error).message}` })
			}
		}

		await call('reportPageRead', readAttendance(document), 'page')
		if (task.catalog) await refreshCatalog(task.catalog, task.date)
	},
})

/** At most this many projects per refresh: the prompt needs names, not an index of the org. */
const PROJECT_LIMIT = 12

/**
 * Zoho lists tasks per project, so the real names come from walking the project
 * list and asking for each one's jobs — the same two calls its own grid makes
 * when you pick Project then Task.
 */
async function refreshCatalog(catalog: { projects?: SeenRequest; jobs?: SeenRequest }, date: string) {
	const { projects: projectsReq, jobs: jobsReq } = catalog
	if (!jobsReq) return

	// One call for everything: projectId=0 with getCurUserJobs asks for every job
	// you have, and each carries its project name.
	const all = readJobList(await send(jobsReq, allProjects(jobsReq.body), date))
	if (all.length && all.every((j) => j.project)) return void (await call('reportCatalog', all))

	// Older portals answer per project, so fall back to walking the list.
	if (!projectsReq) return void (all.length && (await call('reportCatalog', all)))
	const projects = readProjects(await send(projectsReq, projectsReq.body, date))
	const out: { id: string; name: string; project: string }[] = []
	for (const project of projects.slice(0, PROJECT_LIMIT)) {
		const reply = await send(jobsReq, withProject(jobsReq.body, project.id), date)
		for (const job of readJobs(reply)) out.push({ id: job.id, name: job.name, project: project.name })
	}
	if (out.length) await call('reportCatalog', out)
	else if (all.length) await call('reportCatalog', all)
}

async function send(req: SeenRequest, body: string | undefined, date: string): Promise<unknown> {
	const url = datedUrl(req.url, date)
	if (new URL(url).origin !== location.origin) return null
	const form = (req.contentType ?? '').includes(FORM)
	const headers: Record<string, string> = { Accept: 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest' }
	if (req.contentType) headers['Content-Type'] = req.contentType
	const res = await fetch(url, {
		method: req.method || 'GET',
		credentials: 'include',
		headers,
		body: req.method === 'GET' ? undefined : form ? refreshCsrf(datedForm(body, date) ?? '') : body,
	}).catch(() => null)
	if (!res?.ok) return null
	return res
		.text()
		.then((t) => JSON.parse(t) as unknown)
		.catch(() => null)
}

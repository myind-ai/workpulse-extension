// Knowing there is a newer WorkPulse, for an extension Chrome cannot update.
//
// Loaded with "Load unpacked" (from the release zip), Chrome never updates an
// extension; only the Web Store, or a company's policy, does. So the extension
// asks GitHub once a day which release is the latest, and says so when it is
// newer than the one running, with the one line that updates the folder in
// place (update.sh) and a Reload button for after. Pure: no chrome, no fetch.

export const RELEASES_API = 'https://api.github.com/repos/myind-ai/workpulse-extension/releases/latest'
export const RELEASES_PAGE = 'https://github.com/myind-ai/workpulse-extension/releases/latest'
export const UPDATE_CMD = 'curl -fsSL https://raw.githubusercontent.com/myind-ai/workpulse-extension/main/update.sh | bash'
export const DAY = 86_400_000

/** Is version `a` newer than `b`? Numbers compared part by part: 1.10.0 > 1.9.2. */
export function newer(a: string, b: string): boolean {
	const pa = a.replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0)
	const pb = b.replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0)
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
	}
	return false
}

export interface Release {
	version: string
	url: string
	/** The release notes' first lines, for the notice. */
	notes: string
	at?: number
	zip?: string
}

/** GitHub's release JSON, or null when it is not one (a draft, an error body). */
export function readRelease(json: unknown): Release | null {
	const r = json as { tag_name?: unknown; html_url?: unknown; body?: unknown; published_at?: unknown; draft?: unknown; prerelease?: unknown; assets?: { browser_download_url?: unknown }[] }
	if (!r || typeof r.tag_name !== 'string' || r.draft || r.prerelease) return null
	const version = r.tag_name.replace(/^v/, '')
	if (!/^\d+(\.\d+){0,3}$/.test(version)) return null
	const zip = (r.assets ?? []).map((a) => a.browser_download_url).find((u): u is string => typeof u === 'string' && /-chrome\.zip$/.test(u))
	const notes = typeof r.body === 'string' ? r.body.replace(/\r/g, '').split('\n').filter((l) => /^\s*[-*]\s|^###\s/.test(l)).slice(0, 8).join('\n').slice(0, 900) : ''
	const at = typeof r.published_at === 'string' ? Date.parse(r.published_at) : NaN
	return { version, url: typeof r.html_url === 'string' ? r.html_url : RELEASES_PAGE, notes, ...(Number.isFinite(at) ? { at } : {}), ...(zip ? { zip } : {}) }
}

export interface UpdateState {
	current: string
	latest?: Release
	checkedAt?: number
	dismissed?: string
	/** The version that was running last time: lower than `current` right after an update. */
	seen?: string
	error?: string
}

/** What the notice should say, if anything. */
export function updateNotice(s: UpdateState): { kind: 'available'; release: Release } | { kind: 'updated'; from: string } | null {
	if (s.latest && newer(s.latest.version, s.current) && s.dismissed !== s.latest.version) return { kind: 'available', release: s.latest }
	if (s.seen && newer(s.current, s.seen)) return { kind: 'updated', from: s.seen }
	return null
}

/** Once a day; "Check now" skips this. */
export const dueForCheck = (checkedAt: number | undefined, now: number) => checkedAt == null || now - checkedAt >= DAY

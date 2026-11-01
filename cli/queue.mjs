// The queue of pages saved from the extension: who has picked each one up, and what is left.
// Pure apart from one folder read in ackOf. wp-brain.mjs does the git and the fetching.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { isSavedUrl, secretsIn } = await import(join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'src', 'core', 'bridge.ts'))

export { isSavedUrl }

const STATES = new Set(['claimed', 'done', 'failed'])
const VIDEO_HOSTS = ['youtube.com', 'youtu.be', 'instagram.com']

/** Every device's acknowledgement of message `id`. An ack with no (or an unknown) state counts as done. */
export function ackOf(cloneAbs, id) {
	const dir = join(cloneAbs, 'bridge', 'inbox', 'acks')
	if (!existsSync(dir)) return []
	const out = []
	for (const device of readdirSync(dir)) {
		const file = join(dir, device, `${id}.json`)
		if (!existsSync(file)) continue
		try {
			const j = JSON.parse(readFileSync(file, 'utf8'))
			out.push({ id, at: Number(j.at) || 0, by: typeof j.by === 'string' && j.by ? j.by : device, state: STATES.has(j.state) ? j.state : 'done', ...(typeof j.why === 'string' && j.why ? { why: j.why } : {}) })
		} catch {
			/* an unreadable ack is not an ack */
		}
	}
	return out
}

/** The device that acknowledged first: earliest `at`, ties by device name. */
export function ownerOf(acks) {
	if (!acks?.length) return null
	return [...acks].sort((a, b) => a.at - b.at || (a.by < b.by ? -1 : a.by > b.by ? 1 : 0))[0].by
}

/** youtube.com, youtu.be and instagram.com go to the video skill; everything else is read as a page. */
export function routeOf(url) {
	let host
	try {
		host = new URL(url).hostname.toLowerCase()
	} catch {
		return 'site'
	}
	return VIDEO_HOSTS.some((d) => host === d || host.endsWith(`.${d}`)) ? 'video' : 'site'
}

/**
 * One row per saved URL, oldest first. `state` is the first acknowledger's: waiting (nobody), claimed, done or failed;
 * a message that looks like it holds a secret is `refused` and carries no url or title. `device` is this device.
 */
export function queueRows(messages, acksById, device) {
	return messages
		.filter(isSavedUrl)
		.sort((a, b) => a.at - b.at)
		.map((m) => {
			if (secretsIn(JSON.stringify(m)).length) return { id: m.id, at: m.at, state: 'refused', owner: null, route: 'site' }
			const acks = acksById[m.id] ?? []
			const owner = ownerOf(acks)
			const ack = owner ? acks.find((a) => a.by === owner) : null
			return { id: m.id, url: m.url, title: m.title ?? '', at: m.at, state: ack ? ack.state : 'waiting', owner, route: routeOf(m.url), ...(ack?.why ? { why: ack.why } : {}) }
		})
}

/** Rows this device can still work on: waiting, or its own unfinished claim. */
export const countable = (rows, device) => rows.filter((r) => r.state === 'waiting' || (r.state === 'claimed' && r.owner === device))

/** The single line `brief` shows. No URL, no title. */
export const queueCountLine = (n) => (n > 0 ? `Saved to read: ${n} (say "process my queue")` : null)

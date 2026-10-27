// Readable views of the Brain, built from the entries.
//
//   bridge/records/<device>/<YYYY-MM>/<ticket>-<title>-<id8>.md   one per entry
//
// A record belongs to the device that wrote the entry and is written once, when
// the entry is, so the one-writer-per-file rule holds and a save costs one file,
// not the whole Brain. The index and the graph are derived from every device's
// entries, so nobody commits them: the extension builds them in memory and the
// CLI writes them next to its clone (`wp-brain index`). Nothing here touches the
// backup's own folder. Pure: no chrome, no fetch.

import type { BridgeEntry } from './bridge'

// bridge.ts's ROOT. Only types are imported from there, so the CLI can load this
// file with Node's own type stripping, which does not resolve extensionless paths.
const ROOT = 'bridge'

const slug = (text: string) =>
	text
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/(^-|-$)/g, '')
		.slice(0, 80) || 'untitled'

const yaml = (value: unknown) => JSON.stringify(String(value ?? ''))
const safe = (device: string) => device.replace(/[^a-zA-Z0-9_-]/g, '-') || 'unknown'

export interface BrainArtifact {
	path: string
	content: string
}

/** Where an entry's record lives: under the device that wrote it. */
export function recordPath(entry: BridgeEntry): string {
	const base = `${entry.ticket ? `${slug(entry.ticket)}-` : ''}${slug(entry.title)}`
	return `${ROOT}/records/${safe(entry.device)}/${new Date(entry.at).toISOString().slice(0, 7)}/${base}-${slug(entry.id).slice(-8)}.md`
}

export function brainRecord(entry: BridgeEntry): BrainArtifact {
	const date = new Date(entry.at)
	const section = (heading: string, value?: string) => (value ? ['', `## ${heading}`, '', value] : [])
	const next = entry.next?.filter(Boolean).map((x) => `- ${x}`).join('\n')
	const links = [entry.links?.pr ? ['Pull request', entry.links.pr] : null, ...(entry.links?.urls ?? []).map((url) => ['Link', url])].filter((x): x is string[] => !!x)
	const related = links.length ? links.map(([label, url]) => `- [${label}](${url})`).join('\n') : ''
	const front = [
		'---', `id: ${yaml(entry.id)}`, `title: ${yaml(entry.title)}`,
		...(entry.subtitle ? [`subtitle: ${yaml(entry.subtitle)}`] : []),
		`type: ${yaml(entry.kind)}`, `scope: ${yaml(entry.scope)}`, `created_at: ${yaml(date.toISOString())}`, `device: ${yaml(entry.device)}`,
		...(entry.ticket ? [`ticket: ${yaml(entry.ticket)}`] : []), ...(entry.project ? [`project: ${yaml(entry.project)}`] : []),
		...(entry.status ? [`status: ${yaml(entry.status)}`] : []), ...(entry.tags?.length ? [`tags: [${entry.tags.map(yaml).join(', ')}]`] : []),
		'---', '', `# ${entry.title}`, ...(entry.subtitle ? ['', `> ${entry.subtitle}`] : []),
	]
	return { path: recordPath(entry), content: [...front, ...section('Summary', entry.body), ...section('Asked', entry.asked), ...section('Done', entry.done), ...section('Root cause', entry.rootCause), ...section('Next action', next), ...section('Links', related), ''].join('\n') }
}

export interface OpenWork {
	/** The ticket key, or the project, or the entry's own title when it has neither. */
	key: string
	title: string
	next: string[]
	at: number
	ticket?: string
	entryId: string
}

/**
 * Where to pick up: per ticket (or project), the newest entry that names a next
 * action, unless a newer entry for the same work says it is done.
 */
export function openWork(entries: BridgeEntry[], since = 0): OpenWork[] {
	const newest = new Map<string, BridgeEntry>()
	const closed = new Map<string, number>()
	for (const e of [...entries].sort((a, b) => b.at - a.at)) {
		const key = e.ticket ?? e.project ?? `${e.kind}:${e.id}`
		if (e.status === 'done' && !closed.has(key)) closed.set(key, e.at)
		if (e.next?.some(Boolean) && e.status !== 'done' && !newest.has(key) && e.at >= since) newest.set(key, e)
	}
	return [...newest.entries()]
		.filter(([key, e]) => (closed.get(key) ?? 0) < e.at)
		.map(([key, e]) => ({ key: e.ticket ?? e.project ?? e.title, title: e.title, next: e.next!.filter(Boolean), at: e.at, ticket: e.ticket, entryId: e.id }))
		.sort((a, b) => b.at - a.at)
}

/**
 * The index and the graph, for reading: never committed. Edges join each entry
 * to the previous one on the same ticket, project or tag — a chain per group,
 * so it grows with the number of entries, not with its square.
 */
export function brainIndex(entries: BridgeEntry[], now = Date.now()): { index: string; graph: string } {
	const sorted = [...entries].sort((a, b) => b.at - a.at)
	const line = (e: BridgeEntry) => `- [${e.title}](${recordPath(e).slice(ROOT.length + 1)}) · ${e.kind}${e.ticket ? ` · ${e.ticket}` : ''}${e.subtitle ? ` — ${e.subtitle}` : ''}`
	const open = openWork(sorted)
	const index = [
		'# WorkPulse Brain index', '', `Generated ${new Date(now).toISOString()} · ${sorted.length} records`, '',
		'## Open next actions', '', ...(open.length ? open.slice(0, 40).map((o) => `- **${o.key}** — ${o.next.join(' · ')}`) : ['- None recorded.']), '',
		'## Recent records', '', ...sorted.slice(0, 100).map(line), '',
	].join('\n')
	const edges: { source: string; target: string; kind: string }[] = []
	const seen = new Set<string>()
	const last = new Map<string, string>()
	const link = (group: string, kind: string, id: string) => {
		const prev = last.get(group)
		last.set(group, id)
		if (!prev) return
		const key = `${[prev, id].sort().join('|')}|${kind}`
		if (!seen.has(key)) (seen.add(key), edges.push({ source: prev, target: id, kind }))
	}
	for (const e of sorted) {
		if (e.ticket) link(`t:${e.ticket}`, 'ticket', e.id)
		if (e.project) link(`p:${e.project}`, 'project', e.id)
		for (const tag of e.tags ?? []) link(`#:${tag}`, 'tag', e.id)
	}
	const nodes = sorted.map((e) => ({ id: e.id, label: e.title, type: e.kind, ticket: e.ticket, project: e.project, tags: e.tags ?? [], path: recordPath(e), status: e.status }))
	return { index, graph: `${JSON.stringify({ version: 2, generatedAt: new Date(now).toISOString(), nodes, edges }, null, 2)}\n` }
}

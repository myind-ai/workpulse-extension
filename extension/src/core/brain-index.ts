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

// Values may come from ./bridge.ts, written with the extension as brain-query.ts does, so the CLI can load this
// file with Node's own type stripping, which does not resolve extensionless paths.
import { SOURCE_LABEL, sourceKey, sourceLink, sourceOf, urlHost, type BridgeEntry } from './bridge.ts'

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

export type GraphNodeType = 'lesson' | 'source' | 'project' | 'ticket' | 'tag'
export type GraphEdgeKind = 'source' | 'project' | 'ticket' | 'related' | 'tag'

export interface GraphNode {
	/** A lesson keeps its entry id; hubs are `ticket:KEY`, `project:name`, `tag:name`, `source:<sourceKey>`. */
	id: string
	type: GraphNodeType
	label: string
	/** How many edges touch it. */
	degree: number
	/** Lessons: the entry kind and what the page shows beside it. Never body text. */
	kind?: string
	at?: number
	scope?: string
	status?: string
	path?: string
	/** Sources: the type, and a safe http(s) link when there is one. */
	sourceType?: string
	url?: string
	archived?: boolean
}

/** `source` is always the lesson. */
export interface GraphEdge {
	source: string
	target: string
	kind: GraphEdgeKind
}

export interface BrainGraph {
	version: 3
	generatedAt: string
	nodes: GraphNode[]
	edges: GraphEdge[]
}

/**
 * Every entry is a lesson node; ticket, project, tag and source are hubs they join. An edge goes from a lesson to a hub,
 * so it grows with the number of entries, not with its square. Ticket keys are upper-cased, tags lower-cased, a project's
 * id is lower-cased (its label as first written), and a source is one node per video or page whatever timestamp it carries.
 * A node holds no body text.
 */
export function brainGraph(entries: BridgeEntry[], now = Date.now()): BrainGraph {
	const lessons: GraphNode[] = []
	const hubs = new Map<string, GraphNode>()
	const edges: GraphEdge[] = []
	const seen = new Set<string>()
	const titled = new Set<string>()
	const hub = (id: string, type: GraphNodeType, label: string, more: Partial<GraphNode> = {}) => {
		let node = hubs.get(id)
		if (!node) hubs.set(id, (node = { id, type, label, degree: 0, ...more }))
		return node
	}
	const join = (lesson: GraphNode, target: GraphNode, kind: GraphEdgeKind) => {
		const key = `${lesson.id}|${target.id}|${kind}`
		if (seen.has(key)) return
		seen.add(key)
		edges.push({ source: lesson.id, target: target.id, kind })
		lesson.degree++
		target.degree++
	}
	// Oldest first, so a project's label and a source's title are the first written.
	for (const e of [...entries].filter((x) => typeof x.amends !== 'string').sort((a, b) => a.at - b.at)) {
		const lesson: GraphNode = { id: e.id, type: 'lesson', label: e.title, degree: 0, kind: e.kind, at: e.at, scope: e.scope, status: e.status, path: recordPath(e), ...(e.archived ? { archived: true } : {}) }
		lessons.push(lesson)
		const own = e.ticket?.trim().toUpperCase()
		if (own) join(lesson, hub(`ticket:${own}`, 'ticket', own), 'ticket')
		const project = e.project?.trim()
		if (project) join(lesson, hub(`project:${project.toLowerCase()}`, 'project', project), 'project')
		for (const t of e.tags ?? []) {
			const tag = String(t).trim().replace(/^#/, '').toLowerCase()
			if (tag) join(lesson, hub(`tag:${tag}`, 'tag', tag), 'tag')
		}
		for (const k of e.links?.related ?? []) {
			const key = String(k).trim().toUpperCase()
			if (key && key !== own) join(lesson, hub(`ticket:${key}`, 'ticket', key), 'related')
		}
		const s = sourceOf(e)
		const sk = sourceKey(s)
		if (s && sk) {
			const id = `source:${sk}`
			const title = s.title?.trim()
			const node = hub(id, 'source', title || (s.url && sourceLink(s) ? urlHost(s.url) : SOURCE_LABEL[s.type]), { sourceType: s.type, ...(sourceLink(s) ? { url: sourceLink(s) } : {}) })
			// The first lesson with a title names the source; before that, the host or the type.
			if (title && !titled.has(id)) (titled.add(id), (node.label = title))
			join(lesson, node, 'source')
		}
	}
	return { version: 3, generatedAt: new Date(now).toISOString(), nodes: [...lessons.reverse(), ...hubs.values()], edges }
}

/**
 * The index and the graph, for reading: never committed. The graph joins each entry to the ticket, project, tag and
 * source it names (see `brainGraph`), so it grows with the number of entries.
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
	return { index, graph: `${JSON.stringify(brainGraph(entries, now), null, 2)}\n` }
}

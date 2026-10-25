// Typed repository over chrome.storage.local (or an in-memory KV in tests).
// Keys mirror the desktop app's tables: settings, day:<date>, entries:<date>,
// issues, jobs, tasks, timer, runtime, auth. Every mutation runs under one
// in-process lock so service-worker events can't interleave read-modify-writes.

import type { DayPlan } from '@/core/briefing'
import type { Goal } from '@/core/goals'
import type { Learning } from '@/core/learn'
import type { Meeting } from '@/core/meetings'
import type { Auth, Day, Entry, Issue, Job, Runtime, Settings, Task, TimelogStatus, Timer } from '@/core/types'
import { DEFAULT_SETTINGS, emptyFlags } from '@/core/types'
import type { PageAttendance } from '@/core/zoho-page'

export interface KV {
	get(keys: string[]): Promise<Record<string, unknown>>
	set(items: Record<string, unknown>): Promise<void>
	remove(keys: string[]): Promise<void>
	/** Everything, for backing up before a reinstall. */
	all(): Promise<Record<string, unknown>>
}

export const chromeKV: KV = {
	get: (keys) => chrome.storage.local.get(keys),
	set: (items) => chrome.storage.local.set(items),
	remove: (keys) => chrome.storage.local.remove(keys),
	all: () => chrome.storage.local.get(null),
}

export function memoryKV(seed: Record<string, unknown> = {}): KV & { data: Record<string, unknown> } {
	const data: Record<string, unknown> = structuredClone(seed)
	return {
		data,
		async get(keys) {
			const out: Record<string, unknown> = {}
			for (const k of keys) if (k in data) out[k] = structuredClone(data[k])
			return out
		},
		async set(items) {
			for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v)
		},
		async remove(keys) {
			for (const k of keys) delete data[k]
		},
		async all() {
			return structuredClone(data)
		},
	}
}

export const uid = () => crypto.randomUUID()

/** Set when the user starts a guided step; the helper on Zoho's pages reads it. */
export interface SetupFlags {
	client: boolean
	attendance: boolean
	/** The shift times were looked at rather than left at the defaults. */
	shift?: boolean
}

export interface SeenRequest {
	at: number
	method: string
	url: string
	/** Form body, as Zoho sent it. Needed because its reads are POSTs. */
	body?: string
	contentType?: string
	/** Non-secret request headers (content-type, x-*, csrf); Cookie and Authorization are never recorded. */
	headers?: Record<string, string>
	/** You pasted this one: it survives trimming, recorder noise cannot push it out. */
	pinned?: boolean
}

/**
 * A piece of work you can come back to: the pages, the task and the note that
 * together were your context. Restoring it is cheaper than rebuilding it, which
 * is the cost every role in this tool pays on a switch.
 */
export const WORKSPACE_MAX = 500
export const LINKS_MAX = 200
export const NOTES_MAX = 500

export interface Workspace {
	id: string
	name: string
	at: number
	note?: string
	taskUid?: string
	tabs: WorkspaceLink[]
	lastOpenedAt?: number
	/** Last change to the ticket itself — a link, a label, a note, a rename. */
	updatedAt?: number
	/** What you thought it would take, in minutes. Asked once, when it is saved. */
	estimateMinutes?: number
	/** Finished with, but not thrown away: out of the list, still searchable. */
	archivedAt?: number
	/** The ticket's running notes, newest day first. */
	notes?: TicketNote[]
}

/**
 * A day's note on a ticket. Markdown, because a note worth keeping has a list
 * in it — and dated, because "what did we decide on Tuesday" is the question
 * notes actually get asked.
 */
export interface TicketNote {
	id: string
	/** IST date the note belongs to, which is not always the day it was typed. */
	date: string
	at: number
	editedAt?: number
	text: string
}

export interface WorkspaceLink {
	title: string
	url: string
	/** "merged on dev", "stage deploy", "test cases" — what this link is for. */
	note?: string
	addedAt?: number
}

/** Which of the two no-API sources answered. */
export type ReadSource = 'endpoint' | 'page'

/**
 * The no-API path: which of Zoho's own endpoints its web app calls, the one we
 * read from, and the last reply. Everything here stays in local storage.
 */
export interface PageSource {
	/** Recording is in-memory in the worker; this only tells the UI what it last did. */
	seen: SeenRequest[]
	/** The request the reader replays, same-origin, with your session. */
	req?: SeenRequest
	last?: { at: number; url: string; status: number; ok: boolean; body: string }
	read?: { at: number; data: PageAttendance; source: ReadSource }
	/** The last punch WorkPulse sent on your behalf, from your click. */
	punch?: { at: number; checkIn: boolean; ok: boolean; status: number; body: string; located: boolean }
	/** The last timesheet push: how many rows Zoho took. */
	write?: { at: number; date: string; done: number; total: number; failures: string[] }
}

const emptySource = (): PageSource => ({ seen: [] })

export class Store {
	private chain: Promise<unknown> = Promise.resolve()

	constructor(private kv: KV) {}

	/** Serialises mutations. Never await another locked call inside `fn`. */
	lock<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.chain.then(fn, fn)
		this.chain = run.catch(() => undefined)
		return run
	}

	private async read<T>(key: string, fallback: T): Promise<T> {
		const r = await this.kv.get([key])
		return (r[key] as T) ?? fallback
	}

	private write(key: string, value: unknown) {
		return this.kv.set({ [key]: value })
	}

	// ── settings ────────────────────────────────────────────────────────────
	async settings(): Promise<Settings> {
		return { ...DEFAULT_SETTINGS, ...(await this.read<Partial<Settings>>('settings', {})) }
	}

	saveSettings(patch: Partial<Settings>) {
		return this.lock(async () => this.write('settings', { ...(await this.settings()), ...patch }))
	}

	// ── days ────────────────────────────────────────────────────────────────
	async day(date: string): Promise<Day> {
		return this.read<Day>(`day:${date}`, { date, timelogStatus: 'pending', isOff: false })
	}

	updateDay(date: string, patch: Partial<Day>): Promise<Day> {
		return this.lock(async () => {
			const day = { ...(await this.day(date)), ...patch, date }
			const index = await this.read<string[]>('dayIndex', [])
			if (!index.includes(date)) await this.write('dayIndex', [...index, date].sort())
			await this.write(`day:${date}`, day)
			return day
		})
	}

	/**
	 * Day summaries in one storage round trip. Reading these one key at a time
	 * is what made the dashboard crawl: the heatmap alone asked for 240.
	 */
	async summaries(dates: string[]): Promise<{ date: string; minutes: number; fromZoho: boolean; status: TimelogStatus; isOff: boolean }[]> {
		if (!dates.length) return []
		const keys = dates.flatMap((d) => [`day:${d}`, `entries:${d}`])
		const bag = await this.kv.get(keys)
		return dates.map((date) => {
			const day = (bag[`day:${date}`] as Day | undefined) ?? { date, timelogStatus: 'pending' as TimelogStatus, isOff: false }
			const entries = (bag[`entries:${date}`] as Entry[] | undefined) ?? []
			const logged = entries.reduce((a, e) => (e.kind === 'work' ? a + e.minutes : a), 0)
			return {
				date,
				// What you wrote down, or failing that what Zoho says you worked —
				// so the months before WorkPulse existed are not a blank wall.
				minutes: logged || (day.zohoMinutes ?? 0),
				fromZoho: logged === 0 && (day.zohoMinutes ?? 0) > 0,
				status: day.timelogStatus,
				isOff: day.isOff,
			}
		})
	}

	/** Every day WorkPulse has a record of, oldest first. */
	dayIndex(): Promise<string[]> {
		return this.read<string[]>('dayIndex', [])
	}

	/** Worked days in [since, today) whose time logs were never pushed. */
	async pendingDays(since: string, today: string): Promise<string[]> {
		const index = await this.read<string[]>('dayIndex', [])
		const out: string[] = []
		for (const date of index.filter((d) => d >= since && d < today)) {
			const d = await this.day(date)
			if (!d.isOff && d.checkedInAt != null && (d.timelogStatus === 'pending' || d.timelogStatus === 'failed')) out.push(date)
		}
		return out
	}

	// ── hourly entries ─────────────────────────────────────────────────────
	async entries(date: string): Promise<Entry[]> {
		const list = await this.read<Entry[]>(`entries:${date}`, [])
		return list.sort((a, b) => a.slotStart - b.slotStart)
	}

	addEntry(e: Omit<Entry, 'uid' | 'synced'> & { uid?: string }): Promise<Entry> {
		return this.lock(async () => {
			const entry: Entry = { ...e, uid: e.uid ?? uid(), synced: false }
			await this.write(`entries:${e.date}`, [...(await this.entries(e.date)), entry])
			if (entry.kind === 'work') {
				await this.write('lastWork', entry)
				// Work logged after the day was sent reopens it: otherwise the
				// afternoon can never reach Zoho because the morning already did.
				const day = await this.day(e.date)
				if (day.timelogStatus === 'pushed') await this.write(`day:${e.date}`, { ...day, timelogStatus: 'pending' })
			}
			return entry
		})
	}

	setEntries(date: string, list: Entry[]) {
		return this.lock(() => this.write(`entries:${date}`, list))
	}

	async lastSlotEnd(date: string): Promise<number | null> {
		const list = await this.entries(date)
		return list.length ? Math.max(...list.map((e) => e.slotEnd)) : null
	}

	lastWorkEntry(): Promise<Entry | null> {
		return this.read<Entry | null>('lastWork', null)
	}

	// ── Zoho jobs cache ────────────────────────────────────────────────────
	async jobs(): Promise<Job[]> {
		return (await this.read<{ list: Job[] }>('jobs', { list: [] })).list
	}

	async jobsUpdatedAt(): Promise<number | null> {
		return (await this.read<{ at?: number }>('jobs', {})).at ?? null
	}

	saveJobs(list: Job[], at: number) {
		return this.lock(() => this.write('jobs', { list: [...list].sort((a, b) => a.name.localeCompare(b.name)), at }))
	}

	// ── regularisation issues ──────────────────────────────────────────────
	issues(): Promise<Issue[]> {
		return this.read<Issue[]>('issues', [])
	}

	saveIssues(list: Issue[]) {
		return this.lock(() => this.write('issues', list))
	}

	async openIssues(): Promise<Issue[]> {
		return (await this.issues()).filter((i) => i.resolvedAt == null).sort((a, b) => a.date.localeCompare(b.date))
	}

	/** Upserts flagged days and resolves open issues in [from, to] that no longer flag. */
	applyScan(found: Omit<Issue, 'firstSeen'>[], from: string, to: string, now: number) {
		return this.lock(async () => {
			const byDate = new Map((await this.issues()).map((i) => [i.date, i]))
			for (const f of found) {
				const old = byDate.get(f.date)
				byDate.set(f.date, { ...f, firstSeen: old?.firstSeen ?? now, resolvedAt: undefined })
			}
			const flagged = new Set(found.map((f) => f.date))
			for (const i of byDate.values()) {
				if (i.resolvedAt == null && i.date >= from && i.date <= to && !flagged.has(i.date)) i.resolvedAt = now
			}
			await this.write('issues', [...byDate.values()])
		})
	}

	// ── tasks and timer ────────────────────────────────────────────────────
	tasks(): Promise<Task[]> {
		return this.read<Task[]>('tasks', [])
	}

	saveTasks(list: Task[]) {
		return this.lock(() => this.write('tasks', list))
	}

	timer(): Promise<Timer | null> {
		return this.read<Timer | null>('timer', null)
	}

	setTimer(t: Timer | null) {
		return this.lock(() => (t ? this.write('timer', t) : this.kv.remove(['timer'])))
	}

	// ── runtime (engine state that must survive the service worker stopping) ──
	async runtime(): Promise<Runtime> {
		return this.read<Runtime>('runtime', { flags: emptyFlags(''), away: [], pending: null, snoozes: 0 })
	}

	updateRuntime(fn: (r: Runtime) => void): Promise<Runtime> {
		return this.lock(async () => {
			const r = await this.runtime()
			fn(r)
			await this.write('runtime', r)
			return r
		})
	}

	// ── guided setup (which helper should show on Zoho's pages) ─────────────
	setupFlags(): Promise<SetupFlags> {
		return this.read<SetupFlags>('setup', { client: false, attendance: false })
	}

	setSetupFlags(patch: Partial<SetupFlags>) {
		return this.lock(async () => this.write('setup', { ...(await this.setupFlags()), ...patch }))
	}

	// ── reading your own Zoho pages (when the API role is blocked) ──────────
	pageSource(): Promise<PageSource> {
		return this.read<PageSource>('pageSource', emptySource())
	}

	updatePageSource(fn: (p: PageSource) => void): Promise<PageSource> {
		return this.lock(async () => {
			const p = await this.pageSource()
			fn(p)
			// Keep every call you pasted; only the recorded ones are trimmed.
			const pinned = p.seen.filter((r) => r.pinned)
			p.seen = [...pinned, ...p.seen.filter((r) => !r.pinned).slice(0, 60)]
			await this.write('pageSource', p)
			return p
		})
	}

	/**
	 * Everything WorkPulse knows, as one object. Removing an extension wipes its
	 * storage even when it is reinstalled under the same id, so this is the way
	 * to carry a day's work across a reinstall.
	 */
	async exportAll(): Promise<Record<string, unknown>> {
		return this.kv.all()
	}

	/** Puts a backup back. Existing keys are overwritten, others left alone. */
	async importAll(data: Record<string, unknown>): Promise<number> {
		const keys = Object.keys(data)
		if (!keys.length) return 0
		await this.kv.set(data)
		return keys.length
	}

	// ── notes left on a page ───────────────────────────────────────────────
	/** Your own, on this machine. A team is an upgrade, never a requirement. */
	pageNotes<T>(): Promise<T[]> {
		return this.read<T[]>('pageNotes', [])
	}

	/** Trimmed by the caller, which knows what a screenshot costs. */
	savePageNotes(list: unknown[]) {
		return this.lock(() => this.write('pageNotes', list))
	}

	noteIndex<T>(fallback: T): Promise<T> {
		return this.read<T>('noteIndex', fallback)
	}

	saveNoteIndex(index: unknown) {
		return this.lock(() => this.write('noteIndex', index))
	}

	// ── recurring meetings ─────────────────────────────────────────────────
	meetings(): Promise<Meeting[]> {
		return this.read<Meeting[]>('meetings', [])
	}

	saveMeetings(list: Meeting[]) {
		return this.lock(() => this.write('meetings', list.slice(0, 20)))
	}

	// ── the plan for a day (the only part anyone types) ────────────────────
	plan(date: string): Promise<DayPlan> {
		return this.read<DayPlan>(`plan:${date}`, { date })
	}

	savePlan(date: string, patch: Partial<DayPlan>): Promise<DayPlan> {
		return this.lock(async () => {
			const next = { ...(await this.read<DayPlan>(`plan:${date}`, { date })), ...patch, date }
			await this.write(`plan:${date}`, next)
			return next
		})
	}

	/**
	 * Every goal and every day's plan, for the backup. Both are keyed by a date
	 * or a week, so there is no index to keep — `all()` already knows what is
	 * there, and an index that can drift is worse than a scan that cannot.
	 */
	async allGoals(): Promise<Goal[]> {
		const bag = await this.kv.all()
		return Object.entries(bag)
			.filter(([k]) => k.startsWith('goal:'))
			.map(([, v]) => v as Goal)
			.filter((g) => g?.key)
	}

	async allPlans(): Promise<DayPlan[]> {
		const bag = await this.kv.all()
		return Object.entries(bag)
			.filter(([k]) => k.startsWith('plan:'))
			.map(([, v]) => v as DayPlan)
			.filter((p) => p?.date)
			.sort((a, b) => a.date.localeCompare(b.date))
	}

	// ── goals bigger than a day ────────────────────────────────────────────
	goal(key: string): Promise<Goal | null> {
		return this.read<Goal | null>(`goal:${key}`, null)
	}

	saveGoal(g: Goal): Promise<Goal> {
		return this.lock(async () => {
			await this.write(`goal:${g.key}`, g)
			return g
		})
	}

	// ── the backup token ───────────────────────────────────────────────────
	/**
	 * Kept under its own key, never in `settings`: settings are exported, shown
	 * in the UI and written to the backup, and a token must be in none of those.
	 */
	async syncToken(): Promise<string> {
		return this.read<string>('syncToken', '')
	}

	saveSyncToken(token: string) {
		return this.lock(() => this.write('syncToken', token.trim()))
	}

	// ── the model key ──────────────────────────────────────────────────────
	/**
	 * Same reasoning as the backup token: settings are exported, shown in the
	 * UI and written to the backup, and a key must be in none of those. Yours,
	 * on this machine, and it never travels anywhere but the provider you chose.
	 */
	async llmKey(): Promise<string> {
		return this.read<string>('llmKey', '')
	}

	saveLlmKey(key: string) {
		return this.lock(() => this.write('llmKey', key.trim()))
	}

	// ── learnings (the record that cannot live in Jira) ────────────────────
	learnings(): Promise<Learning[]> {
		return this.read<Learning[]>('learnings', [])
	}

	saveLearnings(list: Learning[]) {
		return this.lock(() => this.write('learnings', list.slice(0, 2000)))
	}

	// ── workspaces (the context you can come back to) ──────────────────────
	workspaces(): Promise<Workspace[]> {
		return this.read<Workspace[]>('workspaces', [])
	}

	saveWorkspaces(list: Workspace[]) {
		// A cap that quietly drops the fifty-first ticket is data loss. It is high
		// enough not to be met in practice, and the commands refuse before it.
		return this.lock(() => this.write('workspaces', list.slice(0, WORKSPACE_MAX)))
	}

	// ── Zoho auth ──────────────────────────────────────────────────────────
	auth(): Promise<Auth | null> {
		return this.read<Auth | null>('auth', null)
	}

	setAuth(a: Auth | null) {
		return this.lock(() => (a ? this.write('auth', a) : this.kv.remove(['auth'])))
	}
}

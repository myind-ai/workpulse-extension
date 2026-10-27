// Everything the UI can ask the background to do. Pages call these through
// `call()` in lib/rpc.ts; the router in entrypoints/background.ts dispatches.

import { API_ENABLED } from '@/core/features'
import { awayMinutes, awayNote, groupEntries, isWorkDay } from '@/core/rules'
import { addDays, atIst, fmtMinutes, isHHMM, istDate, istTime, istWeekday, MIN } from '@/core/time'
import type { Day, Entry, Issue, Job, PendingKind, Settings, Task } from '@/core/types'
import { allowed } from '@/core/zoho-parse'
import { answerTask, createTask, deleteTask, runningTimer, startTimer, stopTimer, tasksToAsk, updateTask, type NewTask, type RunningTimer } from '@/lib/tasks'
import { countWater, healthNotes, noteForNext, type HealthNote } from '@/core/health'
import { meetingSlot, meetingSlots, timeOn, type Meeting, type MeetingKind } from '@/core/meetings'
import { askWindow } from '@/core/schedule'
import { allTags, forTicket, repeats, taggedMistakes, tagsOf, type LearnKind, type Learning, type Repeat, type TagCount } from '@/core/learn'
import { board, memberPath, NO_TEAM, shareFile, shareMessage, teamTotals, whoChanged, type BoardRow, type SharedMember, type ShareInput } from '@/core/team'
import {
	canonicalUrl,
	countFor,
	countLocal,
	EMPTY_INDEX,
	indexWith,
	issueBody,
	newNote,
	notesFor,
	pageOf,
	pagesWithNotes,
	textOf,
	trimNotes,
	urlKey,
	type LocalNote,
	type NoteIndex,
	type PageNote,
} from '@/core/page-notes'
import { firstLine } from '@/core/markdown'
import { ticketForPage, ticketKey } from '@/core/links'
import { calibrate, calibrationLine, type Calibration, type Estimated } from '@/core/calibrate'
import { handover, handoverText, type Handover, type HandoverTicket } from '@/core/handover'
import { hoursFor } from '@/core/leave'
import { overtime, overtimeLine, type Overtime, type WorkedDay } from '@/core/overtime'
import { periodReport, periodText, spanFrom, type PeriodReport, type Span } from '@/core/period'
import { countKinds, findAll, type Hit, type HitKind } from '@/core/find'
import { matchBrain, parseBrainQuery } from '@/core/brain-query'
import { fold, KIND_LABEL as BRAIN_KIND } from '@/core/bridge'
import { isComplete, lastDays, lockLine, owedDays, streakOf, type DayState, type Owed, type Streak } from '@/core/habit'
import { leftAt, regularisationNote } from '@/core/closeout'
import { describeAdd, shortTicket, undoLabel, undoOffered, type Undoable } from '@/core/undo'
import { shotName } from '@/core/sync'
import { BACKUP_MAX_BYTES, CLIP_RELEASE_TAG, clipName, clipsToKeep, clipUsable, MAX_SECONDS } from '@/core/clip'
import { headline, recoverable, sealed, type DayEvidence, type Recovery } from '@/core/recover'
import { novelWords, parseDraft, promptFor, reasonPrompt, REASON_SYSTEM, SYSTEM as DRAFT_SYSTEM } from '@/core/draft'
import { accountedFor, timeline, type Segment } from '@/core/timeline'
import { ALWAYS, NEVER, ON_REQUEST, trustLine, type Capability, type Holding } from '@/core/trust'
import { learningsCsv, learningsMarkdown, timesheetCsv } from '@/core/export'
import { deskLoad, driftLine, inferContext, keysIn as ticketKeysIn, spread, type Context } from '@/core/context'
import { badMoment, captured, predict, predictPrompt, PREDICT_SYSTEM, usablePrediction } from '@/core/predict'
import { assessPrompt, ASSESS_SYSTEM, checkCitations, evidenceFrom, scopeGrowth, type Evidence, type Growth } from '@/core/assess'
import { interrupted, meetingCosts, meetingLine, recoveryCost, type Interrupted, type Interruption, type MeetingCost } from '@/core/cost'
import { bodyFor, configProblem, endpoint, errorFor, headersFor, providerById, textFrom, whereItGoes, type LlmConfig, type Message } from '@/core/llm'
import { quietLinks, startedAndStopped, waitingLine, waitingOn } from '@/core/waiting'
import { weekLine, weekSplit, type WeekReview } from '@/core/week'
import { deepLine, deepStats, dueBlock, leftOf, progressOf, strayLine, strayMatch, suggestIntent, type Booked, type DeepStats, type Session } from '@/core/deepwork'
import { askText, shouldAsk } from '@/core/ask'
import { activity, draft, ticketsIn, type Activity } from '@/core/history'
import { readiness } from '@/core/ready'
import { briefing, dayReview, nextDay, type Briefing, type DayPlan, type DayReview } from '@/core/briefing'
import {
	cleanupMinutes,
	datesIn,
	goalKeyFor,
	goalTitle,
	plannedActual,
	progress,
	quickWins,
	switchNote,
	switches,
	type Goal,
	type GoalScope,
	type PlannedActual,
	type Progress,
	type QuickTask,
	type Switches,
} from '@/core/goals'
import { standup, standupDate, standupText, type Standup } from '@/core/standup'
import { backupDue, changedFiles, commitMessage, digestsOf, filesFor, parseRepo, safeSettings, syncTarget, type Backup, type Manifest } from '@/core/sync'
import { GitHub } from '@/lib/github'
import { keyPattern, keysIn, labelFor, mergePreview, mergeWorkspaces, pageMenu, type MenuItem, type TicketRow } from '@/core/links'
import { explain, localZone, type Conversion } from '@/core/timezone'
import { safeHref } from '@/core/markdown'
import { uid, LINKS_MAX, NOTES_MAX, WORKSPACE_MAX, type TicketNote, type Workspace, type WorkspaceLink } from '@/lib/store'
import type { ZohoClient } from '@/lib/zoho'

import type { Engine } from './engine'

export const MIN_TEXT = 10

/** Errors that only mean something when the official API is connected. */
const API_NOISE = /session expired|sign in again|access token|oauth|client id|api'?s|scope/i

export interface PromptContext {
	slotStart: number
	slotEnd: number
	/** The day behind this slot, so the card can show what answering moves. */
	loggedToday: number
	targetToday: number
	elapsedToday: number
	label: string
	minutes: number
	totalMinutes: number
	awayNote: string | null
	lastText: string
	/** What the focus block that just ended was for — the line you already wrote. */
	focusIntent?: string
	/** The guess, so the box is never empty, and why it was made. */
	guess: string
	guessWhy: string
	/** Whether a model could sharpen it. Shown as an offer, never done unasked. */
	canSharpen: boolean
	/** What answering has got you this week. Silent until worth saying. */
	captured: string | null
	defaultJobId: string
	jobs: Job[]
	tasks: Task[]
	timer: (RunningTimer & { minutesInSlot: number }) | null
	snoozes: number
	manual: boolean
}

export interface TodayState {
	today: string
	now: number
	day: Day
	settings: Settings
	pending: { kind: string; blocking: boolean; manual?: boolean } | null
	hasZoho: boolean
	authKind: 'oauth' | 'self' | null
	/** Zoho refuses the API for this role; your own pages are read instead. */
	roleBlocked: boolean
	lastError?: string
	awaiting?: 'in' | 'out'
	issues: Issue[]
	loggedMinutes: number
	nextPromptAt: number | null
	timer: RunningTimer | null
	pendingDays: string[]
	snoozeUntil?: number
	/** A quiet block in progress: when it ends, and what it is for. */
	focus?: { taskUid?: string; startedAt: number; endsAt: number }
}

export class DayCommands {
	constructor(
		protected engine: Engine,
		protected zoho: ZohoClient,
	) {
		// The engine raises the meeting toast; the standup lives up here. One line
		// of what you did goes in the toast, so it is worth reading on its own.
		engine.gist = async (id) => {
			const brief = await this.meetingBrief(id).catch(() => null)
			return brief?.points[0]?.lines.slice(0, 2).join(' · ') ?? ''
		}
	}

	protected get store() {
		return this.engine.store
	}
	protected get env() {
		return this.engine.env
	}
	protected now() {
		return this.env.now()
	}

	/** Runs one scheduler tick now (the alarm also runs it every minute). */
	async tickNow() {
		return this.engine.tick()
	}

	// ── state for the popup, dashboard and overlay ─────────────────────────
	async state(): Promise<TodayState> {
		const now = this.now()
		const today = istDate(now)
		const [day, settings, rt, issues, entries, timer, auth, pendingDays] = await Promise.all([
			this.store.day(today),
			this.store.settings(),
			this.store.runtime(),
			this.store.openIssues(),
			this.store.entries(today),
			runningTimer(this.store, now),
			this.store.auth(),
			this.store.pendingDays(addDays(today, -7), today),
		])
		const snap = await this.engine.snapshot()
		const nextPromptAt = day.checkedInAt != null && day.checkedOutAt == null && snap.slotStart != null ? snap.slotStart + settings.promptInterval * MIN : null
		return {
			today,
			now,
			day,
			settings,
			pending: rt.pending,
			hasZoho: API_ENABLED && auth != null,
			authKind: API_ENABLED ? auth?.kind ?? null : null,
			roleBlocked: !!rt.roleBlocked,
			lastError: API_ENABLED && auth != null ? rt.lastError : rt.lastError && !API_NOISE.test(rt.lastError) ? rt.lastError : undefined,
			awaiting: rt.awaiting,
			issues,
			loggedMinutes: entries.filter((e) => e.kind === 'work').reduce((s, e) => s + e.minutes, 0),
			nextPromptAt,
			timer,
			pendingDays,
			snoozeUntil: rt.snoozeUntil,
			focus: rt.focus,
		}
	}

	async overlayState() {
		const rt = await this.store.runtime()
		const p = rt.pending
		if (!p) return { pending: null }
		if (p.kind === 'prompt') return { pending: p, prompt: await this.promptContext(!!p.manual) }
		const s = await this.store.settings()
		if (p.kind === 'checkin') {
			// "Watched" means something will notice your punch: the API, or the
			// reader on your own Zoho tab.
			const watched = (API_ENABLED && (await this.store.auth()) != null) || (await this.store.pageSource()).req != null
			return { pending: p, checkin: { awaiting: rt.awaiting, hasZoho: watched, mode: s.zohoMode, shiftStart: s.shiftStart, lastError: rt.lastError } }
		}
		if (p.kind === 'remind') {
			const tasks = await this.store.tasks()
			const task = tasks.find((t) => t.uid === p.taskUid)
			if (!task) return { pending: null }
			return {
				pending: p,
				remind: {
					uid: task.uid,
					title: task.title,
					url: task.url,
					repeatMinutes: task.repeatMinutes,
					tasks: tasks.filter((t) => t.uid !== task.uid && t.kind !== 'note' && t.status !== 'done').map((t) => ({ uid: t.uid, title: t.title, key: t.key })),
				},
			}
		}
		const today = istDate(this.now())
		const entries = await this.store.entries(today)
		return { pending: p, wrapup: { date: today, loggedMinutes: entries.filter((e) => e.kind === 'work').reduce((a, e) => a + e.minutes, 0) } }
	}

	// ── hourly prompt ──────────────────────────────────────────────────────
	async promptContext(manual = false): Promise<PromptContext> {
		const now = this.now()
		const today = istDate(now)
		const [s, day, rt, lastEnd, last, jobs, tasks, timer, meetings] = await Promise.all([
			this.store.settings(),
			this.store.day(today),
			this.store.runtime(),
			this.store.lastSlotEnd(today),
			this.store.lastWorkEntry(),
			this.store.jobs(),
			this.store.tasks(),
			runningTimer(this.store, now),
			this.store.meetings(),
		])
		let start = day.checkedInAt != null ? Math.max(day.checkedInAt, lastEnd ?? 0) : Math.max(lastEnd ?? 0, now - s.promptInterval * MIN)
		const shiftEnd = atIst(today, s.shiftEnd)
		let end = !manual && now > shiftEnd && start < shiftEnd ? shiftEnd : now
		// The same cut the scheduler made when it decided to ask: a window that
		// runs through your stand-up would be logged over the top of it.
		const win = askWindow(start, end, meetingSlots(meetings, today))
		if (win) {
			start = win.from
			end = win.to
		}
		if (start > end) start = end
		const spans = [...rt.away, ...(rt.idleStart != null ? [[rt.idleStart, now] as [number, number]] : [])]
		const total = Math.round((end - start) / MIN)
		const away = awayMinutes(spans, start, end)
		const todayEntries = await this.store.entries(today)
		const loggedToday = todayEntries.filter((e) => e.kind === 'work').reduce((n, e) => n + e.minutes, 0)
		return {
			slotStart: start,
			slotEnd: end,
			loggedToday,
			targetToday: day.isOff ? 0 : hoursFor(day.offKind === 'half' ? 'half' : 'work', s.minHours) * 60,
			elapsedToday: day.checkedInAt != null ? Math.round(((day.checkedOutAt ?? now) - day.checkedInAt) / MIN) : 0,
			label: `${istTime(start)} – ${istTime(end)}`,
			minutes: Math.max(0, total - away),
			totalMinutes: total,
			awayNote: awayNote(spans, start, end),
			lastText: last?.text ?? '',
			// You said what the block was for when you started it. Asking again at
			// the end, with an empty box, is the app forgetting the one thing you
			// told it.
			focusIntent: rt.focus?.intent ?? rt.lastFocusIntent,
			...(await this.cardGuess(start, end, last?.text, rt.focus?.intent ?? rt.lastFocusIntent, timer?.task.title, meetings, today)),
			defaultJobId: timer?.task.jobId ?? last?.jobId ?? s.defaultJobId ?? '',
			jobs,
			// Saved links are not work to pick from: they belong under Saved, not here.
			tasks: tasks.filter((t) => t.status !== 'done' && t.kind !== 'note'),
			timer: timer ? { ...timer, minutesInSlot: Math.max(0, Math.round((end - Math.max(timer.startedAt, start)) / MIN)) } : null,
			snoozes: rt.snoozes,
			manual,
		}
	}

	/**
	 * What the card shows before anything is typed.
	 *
	 * A ladder, cheapest first, and the model is not on it — that rung is an
	 * offer the card makes, not a request it sends. Somebody with no key gets a
	 * slightly worse guess; nobody gets a blank box, and nobody waits on a
	 * network call to answer a question they already know the answer to.
	 */
	private async cardGuess(
		start: number,
		end: number,
		lastText: string | undefined,
		focusIntent: string | undefined,
		timerTitle: string | undefined,
		meetings: Meeting[],
		today: string,
	): Promise<{ guess: string; guessWhy: string; canSharpen: boolean; captured: string | null }> {
		const tabs = (await this.env.ui.windowTabs?.()) ?? []
		// A meeting that covered most of the slot is what the slot was.
		// A meeting that covered half the slot or more is what the slot was.
		const half = (end - start) / 2
		const meeting = meetings.find((m) => {
			const [slot] = meetingSlots([m], today)
			return slot && Math.min(slot.to, end) - Math.max(slot.from, start) >= half
		})?.name
		const p = predict({ lastText, focusIntent, timerTitle, tabs, meeting })

		const s = await this.store.settings()
		const earlier = await this.store.pendingDays(addDays(today, -6), today).catch(() => [])
		const days = [...new Set([...earlier, today])]
		const entries = (await Promise.all(days.map((d) => this.store.entries(d)))).flat()
		return {
			guess: p.text,
			guessWhy: p.why,
			canSharpen: !!s.llmProvider && !!s.llmModel,
			captured: captured(entries.map((e) => ({ date: e.date, minutes: e.minutes, kind: e.kind })), days).line,
		}
	}

	/**
	 * A sharper line, from the model somebody brought. Only on a press.
	 *
	 * Never called to fill the card: a guess that costs a network round trip is
	 * a guess that makes the card slower than typing, which defeats the point.
	 */
	async sharpenGuess(slotStart: number, slotEnd: number): Promise<string> {
		const tabs = (await this.env.ui.windowTabs?.()) ?? []
		const today = istDate(slotStart)
		const recent = (await this.store.entries(today))
			.filter((e) => e.kind === 'work' && e.text.trim())
			.slice(-4)
			.map((e) => e.text.trim())
		const body = predictPrompt({ tabs }, recent)
		if (!body) throw new Error('Nothing open and nothing written yet — there is nothing to go on.')
		const said = await this.ask([{ role: 'system', content: PREDICT_SYSTEM }, { role: 'user', content: body }], 60)
		const line = usablePrediction(said)
		if (!line) throw new Error('It answered with something that is not a log line. Try again.')
		return line
	}

	/** Why now is a bad time to force a card, or null when it is fine. */
	async askMoment(): Promise<string | null> {
		const [m, rt] = await Promise.all([this.env.ui.moment?.() ?? Promise.resolve({}), this.store.runtime()])
		return badMoment({ ...m, focusing: !!rt.focus })
	}

	async saveEntry(input: { slotStart: number; slotEnd: number; text: string; jobId?: string; taskUid?: string; minutes: number }): Promise<void> {
		const text = input.text.trim()
		if (text.length < MIN_TEXT) throw new Error(`Write at least ${MIN_TEXT} characters about what you did.`)
		const slotMinutes = Math.round((input.slotEnd - input.slotStart) / MIN)
		if (!Number.isFinite(input.minutes) || input.minutes < 0 || input.minutes > Math.max(slotMinutes, 1) + 5) {
			throw new Error(`Minutes must be between 0 and ${Math.max(slotMinutes, 1)}.`)
		}
		const jobs = await this.store.jobs()
		if (jobs.length && !input.jobId) throw new Error('Pick the Zoho job this time belongs to.')
		await this.store.addEntry({
			date: istDate(input.slotStart),
			slotStart: input.slotStart,
			slotEnd: input.slotEnd,
			text,
			jobId: input.jobId || undefined,
			taskUid: input.taskUid || undefined,
			minutes: Math.round(input.minutes),
			kind: 'work',
		})
		await this.afterAnswer(input.slotEnd)
		// The others would want to see this; it goes up with the next burst.
		await this.teamChanged().catch(() => undefined)
	}

	/**
	 * Remove an entry.
	 *
	 * The Review page has offered a Delete button on every unsynced row since
	 * it was written, and nothing was ever on the other end of it — pressing
	 * it reported an unknown command. It matters more now: logging a meeting
	 * without asking is only safe because undoing it is one click.
	 *
	 * A row that came from a meeting un-logs that meeting as well, so it can
	 * be added again if it turns out it did happen after all.
	 */
	async deleteEntry(date: string, uid: string): Promise<void> {
		const list = await this.store.entries(date)
		const gone = list.find((e) => e.uid === uid)
		if (!gone) throw new Error('That entry is already gone.')
		if (gone.synced) throw new Error('That one is already in Zoho — remove it there instead.')
		await this.store.setEntries(date, list.filter((e) => e.uid !== uid))
		if (gone.meetingId) {
			const meetings = await this.store.meetings()
			await this.store.saveMeetings(meetings.map((m) => (m.id === gone.meetingId && m.loggedOn === date ? { ...m, loggedOn: undefined } : m)))
		}
		await this.engine.reconcile()
		this.env.ui.changed()
	}

	async takeBreak(slotStart: number, slotEnd: number): Promise<void> {
		await this.store.addEntry({ date: istDate(slotStart), slotStart, slotEnd, text: 'Lunch / break', minutes: 0, kind: 'break' })
		await this.engine.noteBreak()
		await this.afterAnswer(slotEnd)
	}

	private async afterAnswer(slotEnd: number) {
		await this.store.updateRuntime((r) => {
			r.away = r.away.filter(([, b]) => b > slotEnd)
			r.snoozeUntil = undefined
			// You have just typed something into WorkPulse. Whether a card asked
			// for it or you opened the dashboard yourself, the next few minutes
			// belong to you: a break card on top of an answer you just gave is the
			// app talking over itself.
			r.gentle = { ...r.gentle, at: this.now() }
		})
		const rt = await this.store.runtime()
		if (rt.pending?.kind === 'prompt') await this.engine.clearPending()
		this.env.ui.changed()
	}

	/**
	 * Start a block of quiet. Running the task's timer too means the card at the
	 * end already knows what you were on, so the whole block logs in one answer.
	 */
	/**
	 * A block of time with one thing in it.
	 *
	 * `intent` is the part that makes it deep rather than merely long: a block
	 * you named before starting is one you notice yourself leaving. It is
	 * optional, because a required field at the moment someone finally has
	 * momentum is the worst possible place for one.
	 */
	async startFocus(minutes: number, taskUid?: string, intent?: string) {
		const now = this.now()
		const length = Math.min(240, Math.max(5, Math.round(minutes)))
		if (taskUid) await startTimer(this.store, taskUid, now)
		const task = taskUid ? (await this.store.tasks()).find((t) => t.uid === taskUid) : undefined
		await this.store.updateRuntime((r) => {
			r.focus = { taskUid, startedAt: now, endsAt: now + length * MIN, intent: (intent ?? task?.title)?.trim() || undefined, strayed: [] }
			r.snoozeUntil = undefined
		})
		await this.engine.clearPending()
		this.env.ui.changed()
		return { endsAt: now + length * MIN }
	}

	/** Ending early asks the same question as finishing: what did you get done? */
	async endFocus(ask = true): Promise<void> {
		const rt = await this.store.runtime()
		if (!rt.focus) return
		await this.engine.recordFocus(rt.focus, this.now(), false)
		await this.store.updateRuntime((r) => {
			r.lastFocusIntent = r.focus?.intent
			r.focus = undefined
		})
		if (ask) await this.engine.setPending({ kind: 'prompt', blocking: true, since: this.now() })
		this.env.ui.changed()
	}

	/**
	 * Ten more minutes. Counted, because "25 minutes" quietly becoming three
	 * hours is how a focus block turns into the thing it was meant to prevent.
	 */
	async extendFocus(minutes = 10): Promise<void> {
		const rt = await this.store.runtime()
		if (!rt.focus) return
		const add = Math.min(60, Math.max(5, Math.round(minutes))) * MIN
		await this.store.updateRuntime((r) => {
			if (r.focus) r.focus = { ...r.focus, endsAt: r.focus.endsAt + add, extended: (r.focus.extended ?? 0) + 1 }
		})
		this.env.ui.changed()
	}

	/** The block as it stands, for the widget's ring and the in-page strip. */
	async focusNow(): Promise<{ session: Session; left: number; progress: number; task?: string } | null> {
		const rt = await this.store.runtime()
		if (!rt.focus) return null
		const now = this.now()
		const task = rt.focus.taskUid ? (await this.store.tasks()).find((t) => t.uid === rt.focus!.taskUid)?.title : undefined
		return { session: rt.focus, left: leftOf(rt.focus, now), progress: progressOf(rt.focus, now), task }
	}

	/**
	 * You opened something during a block that you had said was not the work.
	 *
	 * It is recorded and answered with one line. Nothing is blocked: a blocker
	 * you can switch off is theatre, and one you cannot is uninstalled at the
	 * worst possible moment.
	 */
	async noteStray(url: string): Promise<{ line: string } | null> {
		const rt = await this.store.runtime()
		if (!rt.focus) return null
		const s = await this.store.settings()
		const host = strayMatch(url, s.strayHosts.length ? s.strayHosts : undefined)
		if (!host) return null
		const now = this.now()
		// Once per host per block: the second time you open the same tab you have
		// already had the thought.
		if ((rt.focus.strayed ?? []).some((x) => x.host === host)) return null
		await this.store.updateRuntime((r) => {
			if (r.focus) r.focus = { ...r.focus, strayed: [...(r.focus.strayed ?? []), { host, at: now }] }
		})
		return { line: strayLine(rt.focus, now, host) }
	}

	// ── blocks booked in advance ───────────────────────────────────────────

	async blocks(): Promise<Booked[]> {
		return (await this.store.settings()).blocks
	}

	/**
	 * Book one, or change it. Same shape as a recurring meeting, because that is
	 * what it is — one with yourself, and the only reliable way deep work
	 * actually happens.
	 */
	async saveBlock(b: { id?: string; time: string; minutes: number; days: number[]; intent?: string; enabled?: boolean }): Promise<Booked> {
		if (!isHHMM(b.time)) throw new Error('Use a time like 10:00.')
		const days = [...new Set(b.days.map(Number))].filter((d) => d >= 1 && d <= 7).sort()
		if (!days.length) throw new Error('Pick at least one day.')
		const list = await this.blocks()
		const existing = b.id ? list.find((x) => x.id === b.id) : undefined
		const saved: Booked = {
			id: existing?.id ?? uid(),
			time: b.time,
			minutes: Math.min(240, Math.max(15, Math.round(b.minutes))),
			days,
			intent: (b.intent ?? existing?.intent)?.trim() || undefined,
			enabled: b.enabled ?? existing?.enabled ?? true,
			// Changed: it may speak again today.
			offeredOn: existing && existing.time === b.time ? existing.offeredOn : undefined,
		}
		await this.store.saveSettings({ blocks: existing ? list.map((x) => (x.id === saved.id ? saved : x)) : [...list, saved] })
		this.env.ui.changed()
		return saved
	}

	/**
	 * Hold the first hour of the day.
	 *
	 * The most valuable hour of the day is reliably spent on mail, chat and the
	 * standup — everyone knows this and nobody defends against it. One tap books
	 * a block at your shift start, on your working days, for ever.
	 */
	async holdFirstHour(minutes = 60): Promise<Booked> {
		const s = await this.store.settings()
		const [h, m] = s.shiftStart.split(':').map(Number)
		// A few minutes after the shift starts, not on the dot: nobody sits down
		// at exactly nine, and a block that has already begun is one you ignore.
		const start = new Date(2000, 0, 1, h, m + 10)
		const time = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`
		return this.saveBlock({ time, minutes, days: s.workDays, intent: 'the first thing, before anything else' })
	}

	/** Is the first hour already held? For the one-tap offer. */
	async firstHourHeld(): Promise<boolean> {
		const s = await this.store.settings()
		const start = Number(s.shiftStart.slice(0, 2))
		return s.blocks.some((b) => b.enabled && Number(b.time.slice(0, 2)) <= start + 1)
	}

	/** Start the block that was just offered — what clicking its notification does. */
	async startBookedBlock(): Promise<void> {
		const today = istDate(this.now())
		const booked = (await this.blocks()).find((b) => b.offeredOn === today)
		if (!booked) return
		await this.startFocus(booked.minutes, undefined, booked.intent)
	}

	async deleteBlock(id: string): Promise<void> {
		await this.store.saveSettings({ blocks: (await this.blocks()).filter((b) => b.id !== id) })
		this.env.ui.changed()
	}

	/**
	 * What to put in a block — from what is already written down, so the box is
	 * never empty at the moment you finally have momentum.
	 */
	async blockIdeas(): Promise<{ text: string; why: string }[]> {
		const today = istDate(this.now())
		const [plan, tasks, timer] = await Promise.all([this.store.plan(today), this.store.tasks(), runningTimer(this.store, this.now())])
		return suggestIntent({
			goal: plan?.goal,
			planned: plan?.todos,
			running: timer ? (timer.task.key ? `${timer.task.key}: ${timer.task.title}` : timer.task.title) : undefined,
			tasks: tasks.filter((t) => t.kind !== 'note' && t.status !== 'done').map((t) => ({ title: t.title, key: t.key, priority: t.priority, blocked: t.blocked })),
		})
	}

	/** What focus came to, over a week or a month. */
	async deepWork(span: 'week' | 'month' = 'week'): Promise<{ stats: DeepStats; line: string | null }> {
		const today = istDate(this.now())
		const from = spanFrom(today, span === 'week' ? 'week' : 'month')
		const rt = await this.store.runtime()
		const stats = deepStats(rt.deep ?? [], from, today)
		return { stats, line: deepLine(stats) }
	}

	/** "Snooze 10 min (on a call)": the forced UI comes back after 10 minutes. */
	async snooze(): Promise<void> {
		const rt = await this.store.runtime()
		await this.store.updateRuntime((r) => {
			r.snoozeUntil = this.now() + 10 * MIN
			r.snoozes += 1
			if (rt.pending?.kind === 'wrapup') r.flags.wrapupBlocked = false
		})
		await this.engine.clearPending()
	}

	async dismiss(): Promise<void> {
		const rt = await this.store.runtime()
		if (rt.pending?.blocking) throw new Error('This reminder needs an answer.')
		await this.engine.clearPending()
	}

	async logNow(): Promise<void> {
		await this.engine.setPending({ kind: 'prompt', blocking: false, manual: true, since: this.now() })
	}

	/**
	 * Done / later / stop, from the reminder card. A repeating reminder keeps its
	 * next slot when you mark it done — that is what makes it repeating.
	 */
	async answerReminder(uid: string, answer: 'done' | 'snooze' | 'stop', minutes = 10): Promise<void> {
		const now = this.now()
		const list = await this.store.tasks()
		await this.store.saveTasks(
			list.map((t) => {
				if (t.uid !== uid) return t
				if (answer === 'snooze') return { ...t, remindAt: now + Math.max(1, minutes) * MIN, remindedAt: undefined }
				if (answer === 'stop') return { ...t, remindAt: undefined, repeatMinutes: undefined }
				return t.repeatMinutes ? t : { ...t, status: 'done' as const, remindAt: undefined }
			}),
		)
		await this.engine.clearPending()
		this.env.ui.changed()
	}

	/**
	 * "Remind me now, properly": the forced card for `kind` on every tab until
	 * it is answered — the same thing the schedule does, on demand, for when you
	 * know you will forget. Any snooze is dropped so it cannot be swallowed.
	 */
	async forceReminder(kind: PendingKind): Promise<void> {
		const today = istDate(this.now())
		const day = await this.store.day(today)
		if (day.isOff) throw new Error('Today is marked off. Undo that first.')
		if (kind === 'checkin' && day.checkedInAt != null) throw new Error('You are already checked in today.')
		if (kind === 'wrapup' && day.timelogStatus !== 'pending') throw new Error("Today's timesheet is already done.")
		await this.store.updateRuntime((r) => void (r.snoozeUntil = undefined))
		await this.engine.setPending({ kind, blocking: true, since: this.now() })
	}

	// ── attendance ─────────────────────────────────────────────────────────
	async checkIn() {
		return this.punch(true)
	}

	async checkOut() {
		return this.punch(false)
	}

	protected async punch(checkIn: boolean): Promise<{ result: 'done' | 'opened' | 'punching' }> {
		const s = await this.store.settings()
		const now = this.now()
		const today = istDate(now)
		const rt = await this.store.runtime()
		if (allowed(s.zohoMode, 'attendance') && !rt.roleBlocked && (await this.zoho.hasAuth())) {
			// Zoho's attendance API needs an employee: emailId, empId or mapId.
			if (!s.email) throw new Error('Set your Zoho email in Settings first — Zoho needs it to record the punch.')
			await this.zoho.punch(s.email, checkIn, now)
			await this.store.updateDay(today, checkIn ? { checkedInAt: now } : { checkedOutAt: now })
			await this.engine.reconcile()
			this.env.ui.changed()
			return { result: 'done' }
		}
		await this.store.updateRuntime((r) => void (r.awaiting = checkIn ? 'in' : 'out'))
		await this.env.ui.openUrl(s.attendanceUrl)
		this.env.ui.changed()
		return { result: 'opened' }
	}

	/** "I've checked in / out in Zoho" — records it locally without the API. */
	async confirmAttendance(kind: 'in' | 'out'): Promise<void> {
		const now = this.now()
		await this.store.updateDay(istDate(now), kind === 'in' ? { checkedInAt: now } : { checkedOutAt: now })
		await this.store.updateRuntime((r) => void (r.awaiting = undefined))
		// Checking in is arriving: the health clocks start now, not from whenever
		// they last spoke yesterday.
		if (kind === 'in') await this.engine.arrived()
		await this.teamChanged().catch(() => undefined)
		await this.engine.reconcile()
		this.env.ui.changed()
	}

	async refreshAttendance(): Promise<Day> {
		const today = istDate(this.now())
		if (await this.zoho.hasAuth()) await this.engine.syncAttendance(today)
		return this.store.day(today)
	}

	/** Today by default; a past date when a recovered day turns out to be one
	 *  nobody worked. `offTold` sticks, so the next report sync does not undo it. */
	async markOff(date?: string): Promise<void> {
		await this.store.updateDay(date ?? istDate(this.now()), { isOff: true, offTold: true })
		await this.engine.reconcile()
		this.env.ui.changed()
	}

	/**
	 * "It says leave, but I am working." Zoho's label is usually right and
	 * occasionally not — a holiday you came in on, leave that was cancelled.
	 * Saying so sticks: the next report sync does not quietly mark it off again.
	 */
	async workingToday(date?: string): Promise<void> {
		await this.store.updateDay(date ?? istDate(this.now()), { isOff: false, offTold: true })
		await this.engine.reconcile()
		this.env.ui.changed()
	}

	/**
	 * Close a day that was left open, at the time you actually stopped.
	 *
	 * Three endings, because there are three truths. You left at that time and
	 * Zoho needs telling (the usual one). You did check out, elsewhere, and only
	 * WorkPulse missed it. Or you were working all evening and today's clock is
	 * the honest answer.
	 */
	async closeOpenDay(date: string, at: number, how: 'regularise' | 'already' = 'regularise'): Promise<{ note: string }> {
		const day = await this.store.day(date)
		if (day.checkedInAt == null) throw new Error('That day was never checked in.')
		const when = Math.max(day.checkedInAt + MIN, Math.min(at, atIst(date, '23:59')))
		await this.store.updateDay(date, { checkedOutAt: when })
		await this.engine.clearPending()

		// A day fixed by hand still has to be right in Zoho, so the issue stays
		// until you say it is sorted — except when you had already checked out
		// there and it was only WorkPulse that missed it.
		if (how === 'already') {
			const list = await this.store.issues()
			await this.store.saveIssues(list.map((i) => (i.date === date && i.resolvedAt == null ? { ...i, resolvedAt: this.now() } : i)))
		}
		else await this.engine.scanBest().catch(() => 0)

		const left = leftAt({
			checkedInAt: day.checkedInAt,
			away: (await this.store.runtime()).away.filter(([a]) => istDate(a) === date),
			lastEntryEnd: (await this.store.entries(date)).at(-1)?.slotEnd,
			shiftEnd: atIst(date, (await this.store.settings()).shiftEnd),
			now: this.now(),
		})
		this.env.ui.changed()
		return { note: regularisationNote(date, istTime(when), left.why) }
	}

	/** Days before today that were checked in and never checked out. */
	openDays(): Promise<string[]> {
		return this.engine.openDays(istDate(this.now()))
	}

	/** What WorkPulse thinks you stopped at, for a day you are fixing by hand. */
	async whenLeft(date: string): Promise<{ at: number; why: string; guessed: boolean } | null> {
		const [day, entries, rt, s] = await Promise.all([this.store.day(date), this.store.entries(date), this.store.runtime(), this.store.settings()])
		if (day.checkedInAt == null) return null
		return leftAt({
			checkedInAt: day.checkedInAt,
			away: rt.away.filter(([a]) => istDate(a) === date),
			lastEntryEnd: entries.at(-1)?.slotEnd,
			lastTick: rt.lastTick != null && istDate(rt.lastTick) === date ? rt.lastTick : undefined,
			shiftEnd: atIst(date, s.shiftEnd),
			now: this.now(),
		})
	}

	// ── what the week actually costs ───────────────────────────────────────

	/**
	 * One tap, during the block, naming what pulled you out.
	 *
	 * It does not end the block and it does not scold. The block carries on;
	 * all that has happened is that the thing now has a name.
	 */
	async noteInterruption(what: string): Promise<void> {
		const at = this.now()
		await this.store.updateRuntime((r) => {
			if (!r.focus) return
			r.focus.broke = [...(r.focus.broke ?? []), { what, at }].slice(-20)
		})
		this.env.ui.changed()
	}

	/**
	 * Which meeting, and what broke the blocks — the two questions "where did
	 * the week go" raises and cannot answer.
	 */
	async weekCost(): Promise<{
		meetings: MeetingCost[]
		meetingLine: string | null
		interrupted: Interrupted
		recovery: { minutes: number; line: string | null }
	}> {
		const today = istDate(this.now())
		const meetings = await this.store.meetings()
		const costs = meetingCosts(
			meetings.map((m) => ({ id: m.id, name: m.name, logMinutes: m.logMinutes, days: m.days, enabled: m.enabled })),
		)
		// Blocks from the last week, with whatever each one said broke it.
		const since = addDays(today, -6)
		const rt = await this.store.runtime()
		const recent = (rt.deep ?? []).filter((d) => d.date >= since)
		const breaks: Interruption[] = recent.flatMap((d) =>
			(d.broke ?? []).map((b) => ({ what: b.what as Interruption['what'], at: b.at, intent: d.intent })),
		)
		const got = interrupted(breaks, recent.length)
		return { meetings: costs, meetingLine: meetingLine(costs), interrupted: got, recovery: recoveryCost(got.total) }
	}

	// ── the six months somebody is about to ask you about ──────────────────

	/**
	 * The evidence, numbered, before anything is written.
	 *
	 * Shown on its own first: somebody should be able to read what the draft
	 * will be built from, and decide it is right, before a word is generated.
	 */
	async assessEvidence(from: string, to: string): Promise<Evidence[]> {
		return evidenceFrom(await this.periodFor(from, to))
	}

	/**
	 * The draft, with every claim checked against the evidence it was given.
	 *
	 * This is the feature somebody pays for and the one that could end the
	 * product's credibility in a sentence: an achievement the person did not
	 * have, handed to their employer in writing, is a career risk rather than
	 * a feature. So nothing is saved, the sources come back beside the text,
	 * and any sentence with nothing behind it is surfaced rather than kept.
	 */
	async assessDraft(from: string, to: string): Promise<{ text: string; evidence: Evidence[]; uncited: string[]; bogus: number[]; ok: boolean }> {
		const evidence = await this.assessEvidence(from, to)
		if (!evidence.length) throw new Error('Not enough logged in that period to write anything honest from.')
		const said = await this.ask(
			[
				{ role: 'system', content: ASSESS_SYSTEM },
				{ role: 'user', content: assessPrompt(evidence, from, to) },
			],
			1400,
		)
		return { ...checkCitations(said, evidence.length), evidence }
	}

	/**
	 * Two periods side by side — what a raise is actually argued on.
	 *
	 * Nobody can remember what their scope was a year ago, which is precisely
	 * the thing an hourly log can answer and nothing else can. Facts only.
	 */
	async scopeSince(from: string, to: string): Promise<Growth> {
		const days = Math.max(1, Math.round((Date.parse(`${to}T12:00:00+05:30`) - Date.parse(`${from}T12:00:00+05:30`)) / (24 * 60 * MIN)))
		const earlier = await this.periodFor(addDays(from, -days), addDays(from, -1))
		return scopeGrowth(earlier, await this.periodFor(from, to))
	}

	/** One period, assembled. Shared by everything above. */
	private async periodFor(from: string, to: string): Promise<PeriodReport> {
		const dates: string[] = []
		for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d)
		const [jobs, tasks, tickets, learnings] = await Promise.all([this.store.jobs(), this.store.tasks(), this.store.workspaces(), this.store.learnings()])
		const entries = (await Promise.all(dates.map((d) => this.store.entries(d)))).flat()
		return periodReport(
			{ entries, jobs, tasks, tickets, learnings: learnings.map((l) => ({ date: l.date, text: l.text, kind: l.kind })) },
			from,
			to,
		)
	}

	// ── one desk, one job ──────────────────────────────────────────────────

	/**
	 * What is on the desk right now, and how much of it belongs.
	 *
	 * Two sources, and the difference between them matters more than either.
	 *
	 * Inside a focus block the context is the block: somebody said what they
	 * were doing, so a tab carrying a different ticket is a departure from
	 * their own stated plan and may be named as one.
	 *
	 * Outside a block it is inferred from the desk itself — the ticket most of
	 * the tabs are about — and then the app has no standing to call anything a
	 * departure, because nothing was promised. It describes the room, waits for
	 * more evidence before speaking at all, and suggests nothing.
	 */
	async deskState(): Promise<{
		context: { id: string; name: string; intent?: string; stated: boolean } | null
		belongs: number
		drifting: number
		unknown: number
		placed: number
		line: string | null
		load: { tabs: number; jobs: number; line: string | null }
	}> {
		const tabs = ((await this.env.ui.windowTabs?.()) ?? []).map((t, i) => ({ id: i, title: t.title, url: t.url }))
		const load = deskLoad(tabs)
		const rt = await this.store.runtime()
		const f = rt.focus
		let c: Context | null = null

		if (f) {
			// A focus block on a task borrows that task's ticket and its links: the
			// links somebody collected are the best statement of what belongs.
			const spaces = await this.store.workspaces()
			const space = f.taskUid ? spaces.find((w) => w.taskUid === f.taskUid) : undefined
			const name = space?.name ?? ticketKey(f.intent ?? '') ?? f.intent?.slice(0, 40) ?? 'this block'
			c = { id: space?.id ?? 'focus', name, intent: f.intent, kind: 'stated', urls: space?.tabs.map((t) => t.url) ?? [] }
		} else {
			// Nothing declared: read the desk, with the tickets written about most
			// recently breaking a tie. Two tickets with two tabs each is a genuine
			// ambiguity, and the one you just wrote about is the better guess.
			const today = await this.store.entries(istDate(this.now()))
			const recent = [...new Set(today.slice().reverse().flatMap((e) => ticketKeysIn(e.text)))]
			c = inferContext(tabs, recent)
		}

		if (!c) return { context: null, belongs: 0, drifting: 0, unknown: tabs.length, placed: 0, line: null, load }
		const sp = spread(tabs, c)
		return {
			context: { id: c.id, name: c.name, intent: c.intent, stated: c.kind === 'stated' },
			belongs: sp.belongs.length,
			drifting: sp.drifting.length,
			unknown: sp.unknown.length,
			placed: sp.placed,
			line: driftLine(sp, c),
			load,
		}
	}

	/**
	 * Park what is on the desk: kept under a name, taken off the screen.
	 *
	 * The tabs were never the problem. Losing which ones belonged together
	 * was — so nothing is discarded here, only set down somewhere it can be
	 * picked up whole.
	 */
	async parkDesk(name: string): Promise<{ id: string; name: string; count: number; closed: number }> {
		const saved = await this.saveWindowAsGroup(name)
		const tabs = (await this.env.ui.parkableTabs?.()) ?? []
		if (tabs.length) await this.env.ui.closeTabs?.(tabs)
		return { ...saved, closed: tabs.length }
	}

	/** Bring one back, whole, as its own group. */
	async resumeDesk(id: string, parkFirst?: string): Promise<void> {
		// Switching means the thing you are leaving is set down, not abandoned.
		if (parkFirst?.trim()) await this.parkDesk(parkFirst.trim())
		await this.openWorkspace(id, [])
	}

	// ── what WorkPulse can see ─────────────────────────────────────────────

	/**
	 * Every capability, whether it is held right now, and what is written down.
	 *
	 * Live rather than documented: a panel that describes the manifest is a
	 * second thing to keep in step, and the one that drifts is always the
	 * reassuring one.
	 */
	async trustState(): Promise<{
		always: Capability[]
		onRequest: (Capability & { granted: boolean })[]
		never: string[]
		line: string
		holding: Holding[]
	}> {
		const granted = (await this.env.ui.grantedPermissions?.()) ?? []
		const [days, entries, learnings, notes, spaces, blobs] = await Promise.all([
			this.store.dayIndex(),
			this.store.entries(istDate(this.now())),
			this.store.learnings(),
			this.store.pageNotes<LocalNote>(),
			this.store.workspaces(),
			this.env.ui.blobCount?.() ?? Promise.resolve(0),
		])
		return {
			always: ALWAYS,
			onRequest: ON_REQUEST.map((c) => ({ ...c, granted: granted.includes(c.id) })),
			never: NEVER,
			line: trustLine(granted),
			holding: [
				{ label: 'Days recorded', count: days.length, where: 'This machine' },
				{ label: 'Entries today', count: entries.length, where: 'This machine' },
				{ label: 'Learnings', count: learnings.length, where: 'This machine — never shared unless you turn it on' },
				{ label: 'Notes on pages', count: notes.length, where: 'This machine' },
				{ label: 'Tickets and groups', count: spaces.length, where: 'This machine' },
				{ label: 'Screenshots and recordings', count: blobs, where: 'This machine, in the browser’s own file store' },
			],
		}
	}

	/**
	 * Everything, readable, in one go.
	 *
	 * No account, no wait, no confirmation maze. The point of being able to
	 * leave easily is that somebody can check it before they commit, and a
	 * export that takes three screens is a export nobody checks.
	 */
	async exportAll(): Promise<{ name: string; text: string }[]> {
		const data = await this.backup()
		const [jobs, learn] = await Promise.all([this.store.jobs(), this.store.learnings()])
		const everyEntry = Object.values(data.entries ?? {}).flat()
		const stamp = istDate(this.now())
		return [
			{ name: `workpulse-${stamp}.json`, text: JSON.stringify(data, null, '\t') },
			{ name: `workpulse-timesheet-${stamp}.csv`, text: timesheetCsv(everyEntry, jobs) },
			{ name: `workpulse-learnings-${stamp}.csv`, text: learningsCsv(learn) },
			{ name: `workpulse-learnings-${stamp}.md`, text: learningsMarkdown(learn) },
		]
	}

	/**
	 * Delete everything, for good.
	 *
	 * No dark pattern, no "are you sure you want to lose…", no retention
	 * period, no soft delete. The export above sits beside this button so the
	 * honest order — take it with you, then go — is the obvious one.
	 */
	async deleteEverything(): Promise<void> {
		await this.env.ui.wipeAll?.()
	}

	// ── the Friday tax ─────────────────────────────────────────────────────

	/**
	 * Tidy the day's descriptions with the model the user brought.
	 *
	 * The rows themselves — the jobs, the minutes — are built here and are not
	 * in the model's reach. It is handed text and asked for text back, and the
	 * answer is discarded whole unless it has exactly as many rows as it was
	 * given. Nothing is saved: both versions come back so somebody can look
	 * before anything replaces anything.
	 */
	async draftTimesheet(date: string): Promise<{ rows: { jobName: string; minutes: number; was: string; now: string; novel: string[] }[] }> {
		const [entries, jobs] = await Promise.all([this.store.entries(date), this.store.jobs()])
		const base = groupEntries(entries, jobs).filter((r) => r.minutes > 0)
		if (!base.length) throw new Error('Nothing logged that day to tidy.')
		const said = await this.ask(
			[
				{ role: 'system', content: DRAFT_SYSTEM },
				{ role: 'user', content: promptFor(base.map((r) => ({ jobName: r.jobName, minutes: r.minutes, description: r.description }))) },
			],
			120 * base.length + 200,
		)
		const got = parseDraft(said, base.length)
		if (!got.ok) throw new Error(got.why)
		return {
			rows: base.map((r, i) => ({
				jobName: r.jobName,
				minutes: r.minutes,
				was: r.description,
				now: got.rows[i],
				// Not a guarantee, and the UI does not present it as one. It
				// catches a ticket key arriving from nowhere, which is worth catching.
				novel: novelWords(r.description, got.rows[i]),
			})),
		}
	}

	/** The sentence the regularisation form wants, from what actually happened. */
	async draftReason(date: string): Promise<string> {
		const [day, entries] = await Promise.all([this.store.day(date), this.store.entries(date)])
		const missing = day.checkedInAt == null && day.checkedOutAt == null ? 'both punches' : day.checkedInAt == null ? 'the check-in' : 'the check-out'
		const left = await this.whenLeft(date)
		const work = entries
			.filter((e) => e.kind === 'work' && e.text.trim())
			.slice(0, 6)
			.map((e) => e.text.trim())
			.join('; ')
		return this.ask(
			[
				{ role: 'system', content: REASON_SYSTEM },
				{
					role: 'user',
					content: reasonPrompt({
						date,
						inAt: day.checkedInAt ? istTime(day.checkedInAt) : undefined,
						outAt: day.checkedOutAt ? istTime(day.checkedOutAt) : undefined,
						missing,
						evidence: left?.why ?? 'what WorkPulse recorded that day',
						work,
					}),
				},
			],
			120,
		)
	}

	/**
	 * The day end to end, gaps included.
	 *
	 * The review screen shows what was logged and therefore cannot show what
	 * was not — which is the thing somebody is actually looking for on a Friday.
	 */
	async dayTimeline(date: string): Promise<{ segments: Segment[]; logged: number; gap: number; share: number }> {
		const [day, entries, rt, s] = await Promise.all([this.store.day(date), this.store.entries(date), this.store.runtime(), this.store.settings()])
		const from = day.checkedInAt ?? atIst(date, s.shiftStart)
		const to = day.checkedOutAt ?? Math.min(this.now(), atIst(date, s.shiftEnd))
		if (to <= from) return { segments: [], logged: 0, gap: 0, share: 100 }
		const segments = timeline({
			from,
			to,
			entries: entries.map((e) => ({ slotStart: e.slotStart, slotEnd: e.slotEnd, text: e.text, kind: e.kind, jobId: e.jobId, minutes: e.minutes })),
			away: rt.away.filter(([a]) => istDate(a) === date),
		})
		return { segments, ...accountedFor(segments) }
	}

	// ── the day that shows zero ────────────────────────────────────────────

	/**
	 * Every day in the last fortnight that Zoho is reading as an absence, with
	 * the punch WorkPulse would propose and what it built it from.
	 *
	 * The forced card only ever fires for a day that was checked *in*, so a day
	 * somebody never punched into at all has, until now, simply gone. This is
	 * the one surface that sees both failures at once — which is what makes it
	 * answerable on the first run rather than a day at a time.
	 */
	async missingPunches(back = 14): Promise<{ list: Recovery[]; headline: string }> {
		const now = this.now()
		const today = istDate(now)
		const s = await this.store.settings()
		const rt = await this.store.runtime()
		const dates: string[] = []
		for (let i = 1; i <= back; i++) dates.push(addDays(today, -i))

		const evidence: DayEvidence[] = []
		for (const date of dates) {
			const [day, entries] = await Promise.all([this.store.day(date), this.store.entries(date)])
			// A day Zoho itself called a holiday, a weekend or leave is not a fault.
			if (day.isOff || !isWorkDay(date, s.workDays)) continue
			evidence.push({
				date,
				checkedInAt: day.checkedInAt,
				checkedOutAt: day.checkedOutAt,
				isOff: day.isOff,
				entries: entries.map((e) => ({ slotStart: e.slotStart, slotEnd: e.slotEnd })),
				away: rt.away.filter(([a]) => istDate(a) === date),
				lastTick: rt.lastTick != null && istDate(rt.lastTick) === date ? rt.lastTick : undefined,
				shiftStart: atIst(date, s.shiftStart),
				shiftEnd: atIst(date, s.shiftEnd),
			})
		}
		// A sealed day needs a form, not a button: offering one click for
		// something that cannot be done in one click is worse than saying so.
		const list = recoverable(evidence, now).filter((r) => !sealed(r.date, now))
		return { list, headline: headline(list) }
	}

	/**
	 * Apply one. Writes only the punch that was missing, never both when only
	 * one was — the other was real and is not ours to overwrite.
	 */
	async recoverPunch(date: string, inAt?: number, outAt?: number): Promise<{ note: string; minutes: number }> {
		const day = await this.store.day(date)
		if (day.isOff) throw new Error('That day is marked as not a working day.')
		const patch: { checkedInAt?: number; checkedOutAt?: number } = {}
		if (day.checkedInAt == null && inAt != null) patch.checkedInAt = Math.max(atIst(date, '00:01'), Math.min(inAt, atIst(date, '23:58')))
		if (day.checkedOutAt == null && outAt != null) patch.checkedOutAt = Math.min(atIst(date, '23:59'), outAt)
		if (patch.checkedInAt == null && patch.checkedOutAt == null) throw new Error('That day already has both punches.')
		const start = patch.checkedInAt ?? day.checkedInAt!
		const end = patch.checkedOutAt ?? day.checkedOutAt!
		if (end <= start) throw new Error('That would end the day before it started — check the times.')
		await this.store.updateDay(date, patch)
		// Fixed here is not fixed in Zoho: the issue stays open until the
		// regularisation is actually filed, which is the whole point of the note.
		await this.engine.scanBest().catch(() => 0)
		this.env.ui.changed()
		return { note: regularisationNote(date, istTime(end), 'what WorkPulse recorded that day'), minutes: Math.round((end - start) / MIN) }
	}

	async openZoho(): Promise<void> {
		await this.env.ui.openUrl((await this.store.settings()).attendanceUrl)
	}

	/**
	 * Which page "this page" means.
	 *
	 * From a content script it is obvious — the page the script is in. From the
	 * dashboard or the widget it is not: the active tab there is WorkPulse
	 * itself. So it is the most recently used ordinary page, which is what
	 * anybody means when they open the box and type a note about "this page".
	 */
	async currentPage(): Promise<{ title: string; url: string } | null> {
		return (await this.env.ui.currentPage?.()) ?? null
	}

	/**
	 * A picture of the page you are looking at.
	 *
	 * `of` names the page it is meant to be of: from the dashboard the tab in
	 * front is WorkPulse, and a screenshot of WorkPulse attached to a note about
	 * somebody's staging site is worse than no screenshot — silently so.
	 */
	async capturePage(of?: string, flash = false): Promise<string | null> {
		const pic = (await this.env.ui.capturePage?.(of)) ?? null
		// The box draws its own pulse; the widget has none, so it asks for one.
		if (pic && flash) await this.env.ui.flashShot?.()
		return pic
	}

	/** Open the box on the page in front of you, without the keystroke. */
	async openPalette(): Promise<void> {
		await this.env.ui.openPalette?.()
	}

	async openDashboard(view = 'today'): Promise<void> {
		await this.env.ui.openDashboard(view)
	}

	/**
	 * Leave a forced card by going to do the thing it asked for. The card comes
	 * down and stays down for a while: you are doing it, and a reminder that
	 * reappears over the page it sent you to is the worst kind.
	 */
	async goAndDo(view: string, quietMinutes = 20): Promise<void> {
		await this.store.updateRuntime((r) => {
			r.snoozeUntil = this.now() + Math.max(1, quietMinutes) * MIN
			if (r.pending?.kind === 'wrapup') r.flags.wrapupBlocked = true
		})
		await this.engine.clearPending()
		await this.env.ui.openDashboard(view)
	}

	// ── tasks and timer ────────────────────────────────────────────────────
	async tasks() {
		const now = this.now()
		const [tasks, timer, s] = await Promise.all([this.store.tasks(), runningTimer(this.store, now), this.store.settings()])
		return { tasks, timer, ask: tasksToAsk(tasks, now, s.promptInterval) }
	}

	/** Tasks and saved links for one day: made then, finished then, or due then. */
	async tasksOn(date: string): Promise<{ open: Task[]; done: Task[]; notes: Task[] }> {
		const list = await this.store.tasks()
		const onDay = (t: Task) => istDate(t.createdAt) === date || (t.doneAt != null && istDate(t.doneAt) === date) || (t.remindAt != null && istDate(t.remindAt) === date)
		const mine = list.filter(onDay)
		return {
			open: mine.filter((t) => t.kind !== 'note' && t.status !== 'done'),
			done: mine.filter((t) => t.kind !== 'note' && t.status === 'done'),
			notes: mine.filter((t) => t.kind === 'note'),
		}
	}

	/** "Did you do this?" from the popup: answering quietens that task for an interval. */
	async answerTask(id: string, answer: 'done' | 'doing' | 'later') {
		await answerTask(this.store, id, answer, this.now())
		this.env.ui.changed()
	}

	/** Per-day totals for the heatmap: how much you logged, and how the day ended. */
	async history(days = 119): Promise<{ date: string; minutes: number; fromZoho: boolean; status: string; isOff: boolean }[]> {
		const today = istDate(this.now())
		const dates = Array.from({ length: days + 1 }, (_, i) => addDays(today, i - days))
		return this.store.summaries(dates)
	}

	/**
	 * Quick capture from the widget: a todo, a link worth keeping, or a note,
	 * with an optional day and time to bring it back. `when` is "YYYY-MM-DDTHH:mm"
	 * as the form gives it, read as IST like every other time in WorkPulse.
	 */
	async capture(c: { text: string; url?: string; when?: string; kind?: 'task' | 'note'; priority?: Task['priority']; repeatMinutes?: number }) {
		const text = c.text.trim()
		if (!text) throw new Error('Write what you want to keep.')
		let remindAt: number | undefined
		if (c.when) {
			const [date, time] = c.when.split('T')
			if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !isHHMM((time ?? '').slice(0, 5))) throw new Error('Use a date and time, like 2026-10-13 09:30.')
			remindAt = atIst(date, time.slice(0, 5))
		}
		// A repeat with no start time begins one interval from now.
		if (c.repeatMinutes && remindAt == null) remindAt = this.now() + c.repeatMinutes * MIN
		const task = await createTask(this.store, { title: text, url: c.url, kind: c.kind ?? 'task', priority: c.priority, remindAt, repeatMinutes: c.repeatMinutes }, this.now())
		this.env.ui.changed()
		return task
	}

	/**
	 * Save the tabs you are about to close, so closing them stops being a loss.
	 * Each becomes a kept link; only then are they closed, and only the ones you
	 * ticked — never a pinned tab, never the one you are looking at.
	 */
	async saveTabs(tabs: { title: string; url: string }[], close: number[] = []): Promise<number> {
		for (const t of tabs) {
			await createTask(this.store, { title: (t.title || t.url).slice(0, 200), url: t.url, kind: 'note' }, this.now())
		}
		if (close.length) await this.env.ui.closeTabs?.(close)
		this.env.ui.changed()
		return tabs.length
	}

	// ── recurring meetings ─────────────────────────────────────────────────
	meetings(): Promise<Meeting[]> {
		return this.store.meetings()
	}

	/** Adds or edits one. The id decides which. */
	async saveMeeting(m: { id?: string; name: string; kind?: MeetingKind; time: string; days: number[]; leadMinutes: number; enabled?: boolean; logMinutes?: number; jobId?: string; logText?: string }) {
		const name = m.name.trim()
		if (!name) throw new Error('Give the meeting a name.')
		if (!isHHMM(m.time)) throw new Error('Use a time like 09:45.')
		const days = [...new Set(m.days.map(Number))].filter((d) => d >= 1 && d <= 7).sort()
		if (!days.length) throw new Error('Pick at least one day.')
		const list = await this.store.meetings()
		const existing = m.id ? list.find((x) => x.id === m.id) : undefined
		const saved: Meeting = {
			id: existing?.id ?? uid(),
			name,
			kind: m.kind ?? existing?.kind ?? 'other',
			time: m.time,
			days,
			leadMinutes: Math.max(0, Math.min(120, Math.round(m.leadMinutes))),
			enabled: m.enabled ?? existing?.enabled ?? true,
			logMinutes: Math.max(0, Math.min(480, Math.round(m.logMinutes ?? existing?.logMinutes ?? 0))),
			jobId: m.jobId ?? existing?.jobId,
			logText: (m.logText ?? existing?.logText)?.trim() || undefined,
			loggedOn: existing?.loggedOn,
			movedOn: existing?.movedOn,
			skippedOn: existing?.skippedOn,
			// Changing a meeting lets it speak again today.
			notifiedOn: existing && existing.time === m.time ? existing.notifiedOn : undefined,
		}
		await this.store.saveMeetings(existing ? list.map((x) => (x.id === saved.id ? saved : x)) : [...list, saved])
		this.env.ui.changed()
		return saved
	}

	/**
	 * "Yes, it happened": the meeting goes on the timesheet for the slot it
	 * occupies, with its own text and job, and is not asked about again today.
	 */
	async logMeeting(id: string, minutes?: number): Promise<void> {
		const today = istDate(this.now())
		const list = await this.store.meetings()
		const m = list.find((x) => x.id === id)
		if (!m) throw new Error('That meeting is gone.')
		const length = Math.max(1, Math.round(minutes ?? m.logMinutes ?? 0))
		const { from } = meetingSlot(m, today)
		await this.store.addEntry({
			date: today,
			slotStart: from,
			slotEnd: from + length * 60_000,
			text: (m.logText || m.name).trim(),
			jobId: m.jobId,
			minutes: length,
			kind: 'work',
		})
		await this.store.saveMeetings(list.map((x) => (x.id === id ? { ...x, loggedOn: today } : x)))
		await this.engine.clearPending()
		this.env.ui.changed()
	}

	/** "It did not happen": nothing logged, and not asked again today. */
	async skipMeeting(id: string): Promise<void> {
		const today = istDate(this.now())
		const list = await this.store.meetings()
		await this.store.saveMeetings(list.map((x) => (x.id === id ? { ...x, loggedOn: today } : x)))
		await this.engine.clearPending()
		this.env.ui.changed()
	}

	/**
	 * A note written at a break: "my eyes are tired", "tablet at 3", "stand more
	 * tomorrow". Either kept, or said back on the next break — once.
	 */
	async saveHealthNote(text: string, opts: { kind?: string; showNext?: boolean } = {}): Promise<void> {
		const body = text.trim()
		if (!body) throw new Error('Nothing to save.')
		const note = { id: uid(), at: this.now(), text: body.slice(0, 300), kind: opts.kind, showNext: !!opts.showNext }
		await this.store.updateRuntime((r) => {
			r.health = { ...r.health, notes: [note, ...(r.health?.notes ?? [])].slice(0, 200) }
		})
		this.env.ui.changed()
	}

	/** What you have written at breaks, newest first. */
	async healthNotes(): Promise<HealthNote[]> {
		return healthNotes(((await this.store.runtime()).health?.notes ?? []) as HealthNote[])
	}

	async deleteHealthNote(id: string): Promise<void> {
		await this.store.updateRuntime((r) => {
			r.health = { ...r.health, notes: (r.health?.notes ?? []).filter((n) => n.id !== id) }
		})
		this.env.ui.changed()
	}

	/** A glass of water, counted for today only. */
	async logWater(change = 1): Promise<number> {
		const today = istDate(this.now())
		let water = 0
		await this.store.updateRuntime((r) => {
			const had = r.health?.waterDate === today ? (r.health?.water ?? 0) : 0
			water = countWater(had, change)
			r.health = { ...r.health, water, waterDate: today }
		})
		await this.engine.clearPending()
		this.env.ui.changed()
		return water
	}

	/** Glasses so far today, for the widget. */
	async water(): Promise<{ had: number; target: number }> {
		const [rt, s] = await Promise.all([this.store.runtime(), this.store.settings()])
		const today = istDate(this.now())
		return { had: rt.health?.waterDate === today ? (rt.health?.water ?? 0) : 0, target: s.waterTarget }
	}

	/** Stop reminding me about this one, from the card itself. */
	/**
	 * It moved. Today only — the weekly rule is untouched, which is the whole
	 * point: a standup that slips to ten past is not a different meeting, and
	 * editing the rule to say so means remembering to put it back tomorrow.
	 */
	async moveMeeting(id: string, time: string, date?: string): Promise<Meeting> {
		if (!isHHMM(time)) throw new Error('Use a time like 09:45.')
		const day = date ?? istDate(this.now())
		const list = await this.store.meetings()
		const m = list.find((x) => x.id === id)
		if (!m) throw new Error('That meeting is gone.')
		// Moved, so it is owed again: a nudge already given was for the old time.
		const moved: Meeting = { ...m, movedOn: { date: day, time }, skippedOn: m.skippedOn === day ? undefined : m.skippedOn, notifiedOn: m.notifiedOn === day ? undefined : m.notifiedOn }
		await this.store.saveMeetings(list.map((x) => (x.id === id ? moved : x)))
		await this.engine.clearPending()
		this.env.ui.changed()
		return moved
	}

	/** Not happening today. Tomorrow it is back, without anyone remembering to. */
	async callOffMeeting(id: string, date?: string): Promise<void> {
		const day = date ?? istDate(this.now())
		const list = await this.store.meetings()
		await this.store.saveMeetings(list.map((x) => (x.id === id ? { ...x, skippedOn: day, movedOn: x.movedOn?.date === day ? undefined : x.movedOn, loggedOn: day } : x)))
		await this.engine.clearPending()
		this.env.ui.changed()
	}

	/** Put back a meeting called off or moved by mistake. */
	async restoreMeeting(id: string, date?: string): Promise<void> {
		const day = date ?? istDate(this.now())
		const list = await this.store.meetings()
		await this.store.saveMeetings(
			list.map((x) => (x.id === id ? { ...x, skippedOn: x.skippedOn === day ? undefined : x.skippedOn, movedOn: x.movedOn?.date === day ? undefined : x.movedOn, notifiedOn: undefined, loggedOn: x.loggedOn === day ? undefined : x.loggedOn } : x)),
		)
		this.env.ui.changed()
	}

	async muteMeeting(id: string): Promise<void> {
		const list = await this.store.meetings()
		await this.store.saveMeetings(list.map((m) => (m.id === id ? { ...m, enabled: false } : m)))
		await this.engine.clearPending()
		this.env.ui.changed()
	}

	/**
	 * Fire a meeting's reminder now, exactly as the schedule would. The whole
	 * chain — the card, the chime, the notification — proved in one click, so
	 * "it did not work" becomes something you can see rather than guess at.
	 */
	async testMeeting(id: string): Promise<void> {
		const m = (await this.store.meetings()).find((x) => x.id === id)
		if (!m) throw new Error('That meeting is gone.')
		const now = this.now()
		const s = await this.store.settings()
		this.env.ui.notify(`meeting-${m.id}`, m.name, `Test · ${m.time}`, true)
		if (s.sound) this.env.ui.chime?.()
		await this.engine.setPending({ kind: 'meeting', blocking: false, since: now, meetingId: m.id, title: m.name, body: `Test reminder · ${m.time}`, until: now + 5 * MIN })
		this.env.ui.changed()
	}

	async deleteMeeting(id: string): Promise<void> {
		await this.store.saveMeetings((await this.store.meetings()).filter((m) => m.id !== id))
		this.env.ui.changed()
	}

	// ── time zones ─────────────────────────────────────────────────────────
	/**
	 * A time someone else wrote, in your clock. Reads whatever was selected on
	 * the page; the zone falls back to yours when none was given.
	 */
	async convertTime(text: string): Promise<Conversion | null> {
		const s = await this.store.settings()
		return explain(text, s.myZone || localZone(), s.otherZones ?? [], this.now())
	}

	/** Close tabs that have been saved somewhere — the only reason closing is safe. */
	async closeTabs(ids: number[]): Promise<void> {
		if (ids.length) await this.env.ui.closeTabs?.(ids)
	}

	// ── workspaces ─────────────────────────────────────────────────────────
	/**
	 * Keep a piece of work whole: its pages, the task it belongs to, and a line
	 * about where you had got to. The expensive part of a switch is not the tabs,
	 * it is remembering what you were doing with them.
	 */
	async saveWorkspace(w: { name: string; tabs: { title: string; url: string }[]; note?: string; taskUid?: string }) {
		const name = w.name.trim()
		if (!name) throw new Error('Give it a name you will recognise later.')
		if (!w.tabs.length) throw new Error('Pick at least one tab to keep.')
		const list = await this.store.workspaces()
		if (list.length >= WORKSPACE_MAX) throw new Error(`That is ${WORKSPACE_MAX} tickets — delete one you have finished with first.`)
		const space: Workspace = {
			id: uid(),
			name,
			at: this.now(),
			updatedAt: this.now(),
			note: w.note?.trim() || undefined,
			taskUid: w.taskUid,
			tabs: w.tabs.map((t) => ({ title: (t.title || t.url).slice(0, 200), url: t.url, note: labelFor(t.url), addedAt: this.now() })).slice(0, LINKS_MAX),
		}
		await this.store.saveWorkspaces([space, ...list])
		this.env.ui.changed()
		return space
	}

	/**
	 * Keep this window under a name, in one step.
	 *
	 * The name arrives before the tabs are saved rather than after — "save it
	 * now, name it later" is how a list of groups ends up called "Untitled",
	 * and a group nobody named is a group nobody reopens.
	 */
	async saveWindowAsGroup(name: string): Promise<{ id: string; name: string; count: number }> {
		const tabs = (await this.env.ui.windowTabs?.()) ?? []
		if (!tabs.length) throw new Error('Nothing open in this window worth keeping.')
		const space = await this.saveWorkspace({ name, tabs })
		return { id: space.id, name: space.name, count: space.tabs.length }
	}

	/** The saved groups, newest use first — the order you would reach for them. */
	async groups(): Promise<{ id: string; name: string; count: number; lastOpenedAt?: number }[]> {
		const list = await this.store.workspaces()
		return list
			.map((w) => ({ id: w.id, name: w.name, count: w.tabs.length, lastOpenedAt: w.lastOpenedAt }))
			.sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))
	}

	workspaces(): Promise<Workspace[]> {
		return this.store.workspaces()
	}

	/**
	 * The ticket list as the list page needs it: counts and dates, the newest
	 * note's first line, and one flattened string to search. At a hundred
	 * tickets the full records are a payload the list has no use for, and this
	 * ships on every change.
	 */
	async ticketList(includeArchived = false): Promise<TicketRow[]> {
		return (await this.store.workspaces())
			.filter((w) => includeArchived || w.archivedAt == null)
			.map((w) => ({
			id: w.id,
			name: w.name,
			links: w.tabs.length,
			notes: w.notes?.length ?? 0,
			at: w.at,
			updatedAt: w.updatedAt ?? w.at,
			lastOpenedAt: w.lastOpenedAt,
			latestNote: w.notes?.[0] ? firstLine(w.notes[0].text, 120) : undefined,
			// Capped: search wants the labels and the hosts, not every full URL.
			archived: w.archivedAt != null,
			hay: [w.note ?? '', ...w.tabs.flatMap((t) => [t.note ?? '', t.title, t.url])].join(' ').slice(0, 600),
		}))
	}

	/** One ticket in full, for its page. */
	async ticket(id: string): Promise<Workspace | null> {
		return (await this.store.workspaces()).find((w) => w.id === id) ?? null
	}

	/** Writes a change to one ticket and stamps when it happened. */
	private async touch(id: string, change: (w: Workspace) => Workspace): Promise<void> {
		const list = await this.store.workspaces()
		if (!list.some((w) => w.id === id)) throw new Error('That workspace is gone.')
		await this.store.saveWorkspaces(list.map((w) => (w.id === id ? { ...change(w), updatedAt: this.now() } : w)))
		this.env.ui.changed()
	}

	/**
	 * The right-click menu for a page, built from its title and address against
	 * your ticket prefixes and the tickets you already have.
	 */
	async pageMenuFor(page: { title?: string; url?: string; keys?: string[] }): Promise<MenuItem[]> {
		const s = await this.store.settings()
		return pageMenu(page, s.ticketPrefixes ?? [], await this.store.workspaces())
	}

	/** The ticket prefixes your teams use, tidied. */
	async prefixes(): Promise<string[]> {
		return (await this.store.settings()).ticketPrefixes ?? []
	}

	/** The pattern the in-page scan should look for, from your prefixes. */
	async keyPattern(): Promise<string> {
		return keyPattern((await this.store.settings()).ticketPrefixes ?? [])
	}

	/** Which of these keys already has a ticket, and which does not. */
	async ticketsForKeys(keys: string[]): Promise<{ key: string; ticketId?: string; name?: string }[]> {
		const prefixes = (await this.store.settings()).ticketPrefixes ?? []
		const spaces = await this.store.workspaces()
		return keys.map((key) => {
			const hit = spaces.find((w) => keysIn(w.name, prefixes).includes(key))
			return { key, ticketId: hit?.id, name: hit?.name }
		})
	}

	/**
	 * The ticket this page names, and where saving it would go.
	 *
	 * Read from the tab's own title and address, which the worker already has:
	 * no content script, no scan of the page, no listener left on it. A page
	 * for PAY-3110 says so in its title or its URL essentially always, and the
	 * handful that do not are still covered by the right-click menu, which
	 * scans the text properly because you asked it to.
	 *
	 * That is the whole answer to doing this without slowing a page down —
	 * never touch the page.
	 */
	async pageTicketOffer(): Promise<{
		page: { title: string; url: string }
		key: string
		saved: { id: string; name: string } | null
		recent: { id: string; name: string; links: number }[]
	} | null> {
		const page = await this.currentPage()
		if (!page) return null
		const prefixes = (await this.store.settings()).ticketPrefixes ?? []
		// First rather than most frequent: a title and an address are short, and
		// a stable answer matters more than a clever one here.
		const key = keysIn(`${page.title} ${page.url}`, prefixes)[0]
		if (!key) return null

		const spaces = await this.store.workspaces()
		const hit = spaces.find((w) => keysIn(w.name, prefixes).includes(key))
		// Already saved and already holding this page: nothing to offer.
		if (hit?.tabs.some((t) => t.url === page.url)) return null

		return {
			page,
			key,
			saved: hit ? { id: hit.id, name: hit.name } : null,
			// The ones you would actually reach for, so the destination can be
			// confirmed rather than assumed.
			recent: spaces
				.filter((w) => w.archivedAt == null && w.id !== hit?.id)
				.sort((a, b) => (b.lastOpenedAt ?? b.updatedAt ?? 0) - (a.lastOpenedAt ?? a.updatedAt ?? 0))
				.slice(0, 3)
				.map((w) => ({ id: w.id, name: w.name, links: w.tabs.length })),
		}
	}

	/**
	 * Start a ticket from a key the page carries — `PAY-2433`, with the page as
	 * its first link. The name is yours to improve later.
	 */
	async ticketFromKey(key: string, page: { title: string; url: string }): Promise<Workspace> {
		const name = key ? `${key} ${page.title}`.slice(0, 120) : page.title.slice(0, 120)
		return this.saveWorkspace({ name, tabs: [page] })
	}

	/**
	 * A ticket's links arrive over days — the PR, then the dev deploy, then stage,
	 * then the test cases. Adding to the same workspace is what makes it findable
	 * in a fortnight instead of being ten searches.
	 */
	async addToWorkspace(id: string, tabs: { title: string; url: string; note?: string }[]) {
		const list = await this.store.workspaces()
		const space = list.find((w) => w.id === id)
		// Taken before anything changes: "add every tab in this window" on the
		// wrong ticket is the accident this whole mechanism exists for.
		if (space) await this.remember({ kind: 'ticket', id, label: '', at: this.now(), before: space })
		if (!space) throw new Error('That workspace is gone.')
		if (space.tabs.length >= LINKS_MAX) throw new Error(`That ticket already holds ${LINKS_MAX} links — remove one first.`)
		const have = new Set(space.tabs.map((t) => t.url))
		const added = tabs
			// Pasted by hand or taken from a tab, it has to be an address a browser
			// will follow — this is where a typo would otherwise be saved forever.
			.filter((t) => safeHref(t.url) && !have.has(t.url))
			.map((t) => ({ title: (t.title || t.url).slice(0, 200), url: t.url, note: t.note?.trim() || labelFor(t.url), addedAt: this.now() }))
		if (!added.length) throw new Error(tabs.some((t) => !safeHref(t.url)) ? "That does not look like a link — it should start with http:// or https://." : 'Those links are already in there.')
		await this.touch(id, (w) => ({ ...w, tabs: [...w.tabs, ...added].slice(0, LINKS_MAX) }))
		await this.remember({ kind: 'ticket', id, label: describeAdd(added.length, space.name), at: this.now(), before: space })
		return added.length
	}

	/**
	 * A link's name and its label, in your words — a page title from six weeks
	 * ago rarely says what the link was for, and that is the whole job here.
	 */
	async editLink(id: string, url: string, patch: { title?: string; note?: string }): Promise<void> {
		const edit = (t: WorkspaceLink) => ({
			...t,
			title: patch.title !== undefined ? patch.title.trim().slice(0, 200) || t.url : t.title,
			note: patch.note !== undefined ? patch.note.trim() || undefined : t.note,
		})
		await this.touch(id, (w) => ({ ...w, tabs: w.tabs.map((t) => (t.url === url ? edit(t) : t)) }))
	}

	/**
	 * Take out the batch that went in together.
	 *
	 * The accident is always the same: "add every tab in this window" on the
	 * wrong ticket. Once the undo window has gone, the only thing that still
	 * tells them apart is that they share a timestamp.
	 */
	async removeLinks(id: string, urls: string[]): Promise<number> {
		const before = (await this.store.workspaces()).find((w) => w.id === id)
		if (!before) throw new Error('That ticket is gone.')
		const gone = new Set(urls)
		await this.remember({ kind: 'ticket', id, label: `removing ${urls.length} links from ${shortTicket(before.name)}`, at: this.now(), before })
		await this.touch(id, (w) => ({ ...w, tabs: w.tabs.filter((t) => !gone.has(t.url)) }))
		return urls.length
	}

	async removeLink(id: string, url: string): Promise<void> {
		const before = (await this.store.workspaces()).find((w) => w.id === id)
		if (before) await this.remember({ kind: 'ticket', id, label: `removing a link from ${shortTicket(before.name)}`, at: this.now(), before })
		await this.touch(id, (w) => ({ ...w, tabs: w.tabs.filter((t) => t.url !== url) }))
	}

	async renameWorkspace(id: string, name: string): Promise<void> {
		const trimmed = name.trim()
		if (!trimmed) throw new Error('Give it a name you will recognise later.')
		await this.touch(id, (w) => ({ ...w, name: trimmed }))
	}

	/** Open one link, without disturbing the rest of the workspace. */
	async openLink(url: string): Promise<void> {
		await this.env.ui.openTabs?.([url])
	}

	/**
	 * Fold one ticket into another. You save `PAY-2433` on Monday, someone sends
	 * a link on Thursday and you save `PAY-2433 financing`, and the ticket is in
	 * two halves. The one you merge *into* keeps its name; everything else is
	 * added rather than replaced, and the other is removed.
	 */
	async mergeTickets(fromId: string, intoId: string): Promise<{ links: number; notes: number; duplicates: number; name: string }> {
		if (fromId === intoId) throw new Error('That is the same ticket.')
		const list = await this.store.workspaces()
		const from = list.find((w) => w.id === fromId)
		const into = list.find((w) => w.id === intoId)
		if (!from || !into) throw new Error('One of those tickets is gone.')
		// A merge removes one of them; the whole list is the only honest snapshot.
		await this.remember({ kind: 'tickets', label: `merging ${shortTicket(from.name)} into ${shortTicket(into.name)}`, at: this.now(), before: list })
		const summary = mergePreview(from, into)
		const merged = mergeWorkspaces(from, into, this.now()) as Workspace
		await this.store.saveWorkspaces(list.filter((w) => w.id !== fromId).map((w) => (w.id === intoId ? merged : w)))
		// Anything filed against the half that is going now belongs to the whole.
		const learnings = await this.store.learnings()
		if (learnings.some((l) => l.ticketId === fromId)) {
			await this.store.saveLearnings(learnings.map((l) => (l.ticketId === fromId ? { ...l, ticketId: intoId } : l)))
		}
		this.env.ui.changed()
		return { ...summary, name: merged.name }
	}

	/** A link filed under the wrong ticket, moved rather than retyped. */
	async moveLink(fromId: string, toId: string, url: string): Promise<void> {
		if (fromId === toId) return
		const list = await this.store.workspaces()
		const from = list.find((w) => w.id === fromId)
		const to = list.find((w) => w.id === toId)
		if (!from || !to) throw new Error('One of those tickets is gone.')
		const link = from.tabs.find((t) => t.url === url)
		if (!link) throw new Error('That link is gone.')
		const now = this.now()
		await this.store.saveWorkspaces(
			list.map((w) => {
				if (w.id === fromId) return { ...w, tabs: w.tabs.filter((t) => t.url !== url), updatedAt: now }
				if (w.id === toId) return { ...w, tabs: w.tabs.some((t) => t.url === url) ? w.tabs : [...w.tabs, link], updatedAt: now }
				return w
			}),
		)
		this.env.ui.changed()
	}

	/**
	 * Done with, but not thrown away. An archived ticket leaves the list and
	 * keeps everything — the links, the notes, the learnings filed against it.
	 */
	async archiveTicket(id: string, archived = true): Promise<void> {
		await this.touch(id, (w) => ({ ...w, archivedAt: archived ? this.now() : undefined }))
	}

	/**
	 * A new ticket from an old one's links: the release checklist, the five tabs
	 * you open for every incident. The notes stay with the original — they were
	 * about that one.
	 */
	async duplicateTicket(id: string, name: string): Promise<Workspace> {
		const from = (await this.store.workspaces()).find((w) => w.id === id)
		if (!from) throw new Error('That workspace is gone.')
		return this.saveWorkspace({ name, tabs: from.tabs.map((t) => ({ title: t.title, url: t.url, note: t.note })) })
	}

	/** Reopens the pages, and starts the task again if it had one. */
	async openWorkspace(id: string, closeIds: number[] = []) {
		const list = await this.store.workspaces()
		const space = list.find((w) => w.id === id)
		if (!space) throw new Error('That workspace is gone.')
		// The ticket's own page leads its group: the notes, the dates and the
		// labelled links open with the work rather than waiting to be looked up.
		const brief = this.env.ui.pageUrl?.(`links/${space.id}`)
		await this.env.ui.openTabs?.([...(brief ? [brief] : []), ...space.tabs.map((t) => t.url)], space.name)
		if (closeIds.length) await this.env.ui.closeTabs?.(closeIds)
		await this.store.saveWorkspaces(list.map((w) => (w.id === id ? { ...w, lastOpenedAt: this.now() } : w)))
		if (space.taskUid && (await this.store.tasks()).some((t) => t.uid === space.taskUid)) {
			await startTimer(this.store, space.taskUid, this.now())
		}
		this.env.ui.changed()
		return space
	}

	// ── the backup to your own repository ──────────────────────────────────
	/**
	 * Everything worth keeping, in one object. The token, the client id and your
	 * email are left out — a backup that carries a credential is worse than no
	 * backup, and this one is written to a repository.
	 */
	async backup(): Promise<Backup> {
		const dates = await this.store.dayIndex()
		const entries: Record<string, Entry[]> = {}
		for (const date of dates) {
			const list = await this.store.entries(date)
			if (list.length) entries[date] = list
		}
		return {
			version: 1,
			exportedAt: this.now(),
			settings: safeSettings(await this.store.settings()),
			learnings: await this.store.learnings(),
			tickets: await this.store.workspaces(),
			jobs: await this.store.jobs(),
			meetings: await this.store.meetings(),
			tasks: (await this.store.tasks()) as unknown[],
			goals: await this.store.allGoals(),
			plans: await this.store.allPlans(),
			issues: await this.store.issues(),
			entries,
			pageNotes: await this.store.pageNotes<LocalNote>(),
			days: await Promise.all(dates.map((d) => this.store.day(d))),
		}
	}

	/** Where the backup goes, and whether it is set up at all. */
	async syncState(): Promise<{ repo: string; branch: string; path: string; hasToken: boolean; daily: boolean; after: string; at?: number; error?: string; pushed?: number }> {
		const [s, token, rt] = await Promise.all([this.store.settings(), this.store.syncToken(), this.store.runtime()])
		return { repo: s.syncRepo, branch: s.syncBranch, path: s.syncPath, hasToken: !!token, daily: s.syncDaily, after: s.syncAfter, ...rt.sync }
	}

	/** The token is written, never read back — the UI only ever learns that one is set. */
	async saveSyncToken(token: string): Promise<void> {
		await this.store.saveSyncToken(token)
		await this.store.updateRuntime((r) => void (r.sync = { ...r.sync, error: undefined }))
		this.env.ui.changed()
	}

	/**
	 * Who the token belongs to and which repositories it can reach. For a token
	 * scoped to selected repositories that list *is* the right list to choose
	 * from: anything in it is known to work before a single file is written.
	 */
	async githubRepos(): Promise<{ login: string; repos: { full_name: string; private: boolean; canWrite: boolean }[] }> {
		const [s, token] = await Promise.all([this.store.settings(), this.store.syncToken()])
		if (!token) throw new Error('Paste the token first.')
		const gh = new GitHub(token, parseRepo(s.syncRepo) ?? { owner: 'x', repo: 'x' })
		const [me, repos] = await Promise.all([gh.me().catch(() => ({ login: '' })), gh.repos()])
		return { login: me.login, repos: repos.filter((r) => r.canWrite) }
	}

	/** Names the repository and says whether the token can actually write to it. */
	async checkSync(): Promise<{ repo: string; private: boolean; canWrite: boolean; defaultBranch: string }> {
		const gh = await this.github()
		const r = await gh.check()
		return { repo: r.full_name, private: r.private, canWrite: r.canWrite, defaultBranch: r.defaultBranch }
	}

	private async github(): Promise<GitHub> {
		const [s, token] = await Promise.all([this.store.settings(), this.store.syncToken()])
		const where = parseRepo(s.syncRepo)
		if (!where) throw new Error('Set the repository first, as owner/name.')
		if (!token) throw new Error('Add a GitHub token with Contents: Read and write on that repository.')
		return new GitHub(token, { ...where, branch: s.syncBranch.trim() || undefined })
	}

	/**
	 * Writes the backup. Only the files whose contents changed are pushed, so a
	 * quiet day does not leave a commit behind.
	 */
	async pushBackup(): Promise<{ pushed: number; skipped: number }> {
		const gh = await this.github()
		const s = await this.store.settings()
		const rt = await this.store.runtime()
		const data = await this.backup()
		// Recordings are fetched one at a time and only the kept ones: a handful
		// of megabytes each, and no reason for the rest to pass through here.
		// A long recording is not one of them — git keeps every version of every
		// file for ever, so anything past the backup ceiling stays local.
		const clips: { id: string; at: number; url: string; title?: string; ticketId?: string; data: string }[] = []
		if (s.backupClips) {
			const notes = (data.pageNotes ?? []) as LocalNote[]
			for (const n of notes.filter((n) => n.clip && n.clip.bytes <= BACKUP_MAX_BYTES)) {
				const blob = await this.clipData(n.clip!.id)
				if (blob) clips.push({ id: n.id, at: n.at, url: n.url, title: n.title, ticketId: n.ticketId, data: blob })
			}
		}
		const files = filesFor(data, s.syncPath, this.now(), s.backupShots, clips)
		// Hashes from a different repository, branch or folder describe files that
		// are not there: start again rather than skip them.
		const target = syncTarget(s.syncRepo, s.syncBranch, s.syncPath)
		const changed = changedFiles(files, rt.sync?.target === target ? rt.sync.files : {})
		const message = commitMessage(data, this.now(), changed)
		try {
			// One commit for the whole backup, not one per file.
			await gh.commit(changed, message)
		} catch (e) {
			const error = e instanceof Error ? e.message : String(e)
			await this.store.updateRuntime((r) => void (r.sync = { ...r.sync, error }))
			this.env.ui.changed()
			throw e
		}
		await this.store.updateRuntime((r) => void (r.sync = { at: this.now(), target, files: digestsOf(files), pushed: changed.length, error: undefined }))
		this.env.ui.changed()
		return { pushed: changed.length, skipped: files.length - changed.length }
	}

	/**
	 * Reads the backup back. Replaces what it covers and leaves the rest alone;
	 * the token and anything else private was never in there to restore.
	 *
	 * The manifest says which shards to read, so a thousand days comes back as
	 * thirty-odd month files rather than one enormous one. A repository written
	 * by an older WorkPulse has a single `backup.json` instead, and that is read
	 * too.
	 */
	async restoreBackup(): Promise<{ learnings: number; tickets: number; days: number }> {
		const gh = await this.github()
		const dir = ((await this.store.settings()).syncPath || 'workpulse').replace(/^\/+|\/+$/g, '')

		const read = async <T>(path: string): Promise<T | null> => {
			const file = await gh.read(path)
			if (!file) return null
			try {
				return JSON.parse(file.text) as T
			} catch {
				throw new Error(`${path} in that repository is not readable JSON.`)
			}
		}

		const manifest = await read<Manifest>(`${dir}/index.json`)
		if (!manifest) {
			const old = await read<Backup>(`${dir}/backup.json`)
			if (!old) throw new Error('Nothing to restore from in that repository yet — push a backup first.')
			return this.applyBackup(old)
		}
		if (manifest.version !== 2) throw new Error(`That backup was written by a newer WorkPulse (version ${manifest.version}).`)

		const meta = (await read<{ jobs?: Job[]; meetings?: Meeting[]; tasks?: Task[]; goals?: Goal[]; issues?: Issue[] }>(manifest.shards.meta)) ?? {}
		const learnings: Learning[] = []
		for (const path of manifest.shards.learnings) learnings.push(...((await read<Learning[]>(path)) ?? []))
		const tickets: Workspace[] = []
		for (const path of manifest.shards.tickets) {
			const t = await read<Workspace>(path)
			if (t) tickets.push(t)
		}
		const days: Day[] = []
		const entries: Record<string, Entry[]> = {}
		for (const path of manifest.shards.days) {
			const shard = await read<{ days?: Day[]; entries?: Record<string, Entry[]> }>(path)
			if (!shard) continue
			days.push(...(shard.days ?? []))
			Object.assign(entries, shard.entries ?? {})
		}

		const plans: DayPlan[] = []
		for (const path of manifest.shards.plans ?? []) plans.push(...((await read<DayPlan[]>(path)) ?? []))

		// The notes, and then their pictures — a note whose screenshot did not
		// survive the restore is half a note, and the half that is missing is
		// the one that proves what you were looking at.
		const pageNotes: LocalNote[] = []
		for (const path of manifest.shards.pageNotes ?? []) pageNotes.push(...((await read<LocalNote[]>(path)) ?? []))
		if (manifest.shots) {
			for (const n of pageNotes) {
				if (!n.shot || n.shot.startsWith('data:')) continue
				const file = await gh.readBinary(`${manifest.shots}/${n.shot}`).catch(() => null)
				n.shot = file ? `data:image/jpeg;base64,${file}` : undefined
				if (!file) n.shotDropped = true
			}
		}

		return this.applyBackup({
			pageNotes,
			version: 1,
			exportedAt: manifest.exportedAt,
			settings: {},
			learnings,
			tickets,
			jobs: meta.jobs ?? [],
			meetings: meta.meetings ?? [],
			tasks: meta.tasks ?? [],
			goals: meta.goals ?? [],
			issues: meta.issues ?? [],
			plans,
			entries,
			days,
		})
	}

	/** Writes a read-back backup over what is here. Settings are left alone. */
	private async applyBackup(data: Backup): Promise<{ learnings: number; tickets: number; days: number }> {
		if (data.learnings) await this.store.saveLearnings(data.learnings)
		if (data.tickets) await this.store.saveWorkspaces(data.tickets as Workspace[])
		// Restored before the entries, so a timesheet row can name its job.
		if (data.jobs?.length) await this.store.saveJobs(data.jobs, this.now())
		if (data.meetings) await this.store.saveMeetings(data.meetings as Meeting[])
		if (data.tasks) await this.store.saveTasks(data.tasks as Task[])
		for (const [date, list] of Object.entries(data.entries ?? {})) await this.store.setEntries(date, list)
		for (const day of (data.days ?? []) as Day[]) if (day?.date) await this.store.updateDay(day.date, day)
		for (const g of (data.goals ?? []) as Goal[]) if (g?.key) await this.store.saveGoal(g)
		for (const p of (data.plans ?? []) as DayPlan[]) if (p?.date) await this.store.savePlan(p.date, p)
		if (data.issues?.length) await this.store.saveIssues(data.issues as Issue[])
		// The notes come back with their words; the pictures only if they were
		// backed up, and the ones that were not say so rather than looking broken.
		if (data.pageNotes) await this.store.savePageNotes(trimNotes(data.pageNotes as LocalNote[]))
		this.env.ui.changed()
		return { learnings: data.learnings?.length ?? 0, tickets: data.tickets?.length ?? 0, days: Object.keys(data.entries ?? {}).length }
	}

	/**
	 * What the browser remembers about an hour you have been asked about. Offered
	 * as a draft, never written: a page you had open is evidence of what you were
	 * doing, not a statement of it. Empty unless you have allowed history.
	 */
	async slotActivity(from: number, to: number): Promise<{ groups: Activity[]; draft: string; tickets: string[] }> {
		const visits = await (this.env.ui.visits?.(from, to) ?? Promise.resolve([]))
		if (!visits.length) return { groups: [], draft: '', tickets: [] }
		const groups = activity(visits, from, to, await this.prefixes())
		return { groups, draft: draft(groups), tickets: ticketsIn(groups) }
	}

	/**
	 * Fill the heatmap from Zoho's own report, further back than the
	 * regularisation scan looks. Blanks only: what you recorded here wins.
	 */
	async fillHistory(days = 120): Promise<{ filled: number; from: string; to: string }> {
		const today = istDate(this.now())
		const from = addDays(today, -Math.max(1, Math.min(400, days)))
		const to = addDays(today, -1)
		const s = await this.store.settings()
		if (!API_ENABLED || !(await this.zoho.hasAuth())) throw new Error('This reads Zoho\'s own report, which needs the Zoho API connected.')
		const report = await this.zoho.userReport(s.email, from, to)
		const filled = await this.engine.keepReport(report, today)
		this.env.ui.changed()
		return { filled, from, to }
	}

	// ── is it working? ─────────────────────────────────────────────────────
	/**
	 * What WorkPulse can actually see right now. Checked rather than explained:
	 * the first-run problem with reading your own Zoho session is that nothing
	 * tells you whether it worked.
	 */
	async readiness(): Promise<ReturnType<typeof readiness>> {
		const now = this.now()
		const [s, page, jobs, flags, rt] = await Promise.all([
			this.store.settings(),
			this.store.pageSource(),
			this.store.jobs(),
			this.store.setupFlags(),
			this.store.runtime(),
		])
		const apiReady = API_ENABLED && !rt.roleBlocked && (await this.zoho.hasAuth())
		return readiness({
			now,
			read: page.read
				? { at: page.read.at, firstIn: page.read.data.firstIn, lastOut: page.read.data.lastOut, source: page.read.source, missing: page.read.data.missing }
				: undefined,
			jobs: jobs.length,
			shift: { start: s.shiftStart, end: s.shiftEnd, confirmed: !!flags.shift },
			tabOpen: await (this.env.ui.hasZohoTab?.() ?? Promise.resolve(false)),
			apiReady,
		})
	}

	/**
	 * The one button: find or open your Zoho tab, read it, and say what changed.
	 * Everything the first run needs, without a page of instructions.
	 */
	async checkZoho(): Promise<ReturnType<typeof readiness>> {
		const had = await (this.env.ui.hasZohoTab?.() ?? Promise.resolve(false))
		if (!had) await this.openZoho()
		// A tab that has just opened needs a moment before it can be read.
		for (let i = 0; i < (had ? 1 : 6); i++) {
			const ok = await this.env.ui.readZohoPage?.().catch(() => false)
			if (ok) break
			await new Promise((r) => setTimeout(r, 700))
		}
		return this.readiness()
	}

	// ── goals bigger than a day ────────────────────────────────────────────
	/** This week's or this month's goal, with what the period has amounted to. */
	async goal(scope: GoalScope, date?: string): Promise<{ key: string; title: string; goal: Goal | null; progress: Progress }> {
		const now = this.now()
		const day = date ?? istDate(now)
		const key = goalKeyFor(scope, day)
		const dates = datesIn(scope, day)
		const s = await this.store.settings()
		const [stored, jobs, pendingDays] = await Promise.all([this.store.goal(key), this.store.jobs(), this.store.pendingDays(dates[0], addDays(dates[dates.length - 1], 1))])
		const names = new Map(jobs.map((j) => [j.id, j.name]))
		const entries: Entry[] = []
		const days: { date: string; checkedInAt?: number; isOff?: boolean }[] = []
		for (const d of dates) {
			entries.push(...(await this.store.entries(d)))
			const rec = await this.store.day(d)
			days.push({ date: d, checkedInAt: rec.checkedInAt, isOff: rec.isOff })
		}
		return {
			key,
			title: goalTitle(scope, day),
			goal: stored,
			progress: progress({ dates, today: istDate(now), workDays: s.workDays, entries, days, pendingDays, jobName: (id) => names.get(id) ?? id }),
		}
	}

	async saveGoal(scope: GoalScope, text: string, date?: string): Promise<Goal> {
		const day = date ?? istDate(this.now())
		const key = goalKeyFor(scope, day)
		const existing = await this.store.goal(key)
		const saved = await this.store.saveGoal({ key, scope, text: text.trim(), at: existing?.at ?? this.now(), verdict: existing?.verdict, why: existing?.why })
		this.env.ui.changed()
		return saved
	}

	async judgeGoal(key: string, verdict: Goal['verdict'], why?: string): Promise<void> {
		const existing = await this.store.goal(key)
		if (!existing) throw new Error('No goal set for that period.')
		await this.store.saveGoal({ ...existing, verdict, why: why?.trim() || undefined })
		this.env.ui.changed()
	}

	/** How scattered today was, and the small things worth clearing. */
	async dayShape(date?: string): Promise<{ switches: Switches; note: string; quick: QuickTask[]; cleanup: number; planned: PlannedActual[] }> {
		const day = date ?? istDate(this.now())
		const [entries, jobs, tasks] = await Promise.all([this.store.entries(day), this.store.jobs(), this.store.tasks()])
		const names = new Map(jobs.map((j) => [j.id, j.name]))
		const s = switches(entries, (id) => names.get(id) ?? id)
		const quick = quickWins(tasks)
		return { switches: s, note: switchNote(s), quick, cleanup: cleanupMinutes(quick), planned: plannedActual(tasks) }
	}

	// ── asking for support, at most three times ever ───────────────────────
	/** Whether the one-line ask is fair right now, and what it would say. */
	async supportAsk(): Promise<{ show: boolean; text: string; wins: number; days: number; never: boolean }> {
		const rt = await this.store.runtime()
		const use = rt.use ?? {}
		const days = (use.days ?? []).length
		const wins = use.wins ?? 0
		const show = shouldAsk({ now: this.now(), activeDays: days, wins, lastAskedAt: use.askedAt, asked: use.asked ?? 0, dismissedForever: use.never, busy: rt.pending != null })
		return { show, text: askText({ wins, activeDays: days }), wins, days, never: !!use.never }
	}

	/** Shown, put off, or never again — all three are answers and all are kept. */
	async answerSupport(answer: 'shown' | 'later' | 'never'): Promise<void> {
		await this.store.updateRuntime((r) => {
			const use = r.use ?? {}
			if (answer === 'never') r.use = { ...use, never: true }
			else r.use = { ...use, askedAt: this.now(), asked: (use.asked ?? 0) + (answer === 'shown' ? 1 : 0) }
		})
		this.env.ui.changed()
	}

	// ── the two ends of a day ──────────────────────────────────────────────
	/** The morning briefing: the last day you worked, what is open, what to start with. */
	async briefing(): Promise<Briefing> {
		const now = this.now()
		const s = await this.store.settings()
		const today = istDate(now)
		const about = standupDate(today, s.workDays, (d) => istWeekday(atIst(d, '12:00')))
		const [entries, jobs, tasks, tickets, plan, pendingDays, issues] = await Promise.all([
			this.store.entries(about),
			this.store.jobs(),
			this.store.tasks(),
			this.store.workspaces(),
			this.store.plan(today),
			this.store.pendingDays(addDays(today, -14), today),
			this.store.issues(),
		])
		return briefing({ today, about, now, entries, jobs, tasks, tickets, plan, pendingDays, issues: issues.filter((x) => x.resolvedAt == null) })
	}

	/** The day said back to you, for closing it. */
	async dayReview(date?: string): Promise<DayReview> {
		const now = this.now()
		const day = date ?? istDate(now)
		const [entries, jobs, tasks, tickets, plan, stored, pendingDays] = await Promise.all([
			this.store.entries(day),
			this.store.jobs(),
			this.store.tasks(),
			this.store.workspaces(),
			this.store.plan(day),
			this.store.day(day),
			this.store.pendingDays(addDays(day, -14), addDays(day, 1)),
		])
		const until = stored.checkedOutAt ?? now
		const elapsed = stored.checkedInAt != null ? Math.max(0, Math.round((until - stored.checkedInAt) / MIN)) : 0
		return dayReview({ date: day, entries, jobs, tasks, tickets, elapsed, plan, pendingDays, checkedOut: stored.checkedOutAt != null })
	}

	/**
	 * What tomorrow is for, in order. The first is what the morning suggests;
	 * anything that is not already a task becomes one, so it is tracked rather
	 * than written down twice.
	 */
	async planTomorrow(todos: string[]): Promise<DayPlan> {
		const next = nextDay(istDate(this.now()))
		const clean = todos.map((t) => t.trim()).filter(Boolean).slice(0, 10)
		const existing = await this.store.tasks()
		const known = new Set(existing.filter((t) => t.status !== 'done').map((t) => (t.key ? `${t.key} — ${t.title}` : t.title)))
		for (const t of clean) {
			if (!known.has(t)) await createTask(this.store, { title: t.slice(0, 200) }, this.now())
		}
		const saved = await this.store.savePlan(next, { todos: clean, firstTask: clean[0] })
		this.env.ui.changed()
		return saved
	}

	plan(date?: string): Promise<DayPlan> {
		return this.store.plan(date ?? istDate(this.now()))
	}

	/** Today's goal, or tomorrow's first task — the only parts anyone types. */
	async savePlan(date: string, patch: Partial<DayPlan>): Promise<DayPlan> {
		const next = await this.store.savePlan(date, patch)
		this.env.ui.changed()
		return next
	}

	/**
	 * The standup, written from what you actually did. The day defaults to the
	 * last one you worked — Friday, on a Monday.
	 */
	async standup(date?: string): Promise<{ date: string; text: string; data: Standup }> {
		const s = await this.store.settings()
		const today = istDate(this.now())
		const day = date ?? standupDate(today, s.workDays, (d) => istWeekday(atIst(d, '12:00')))
		const [entries, jobs, tasks, tickets] = await Promise.all([this.store.entries(day), this.store.jobs(), this.store.tasks(), this.store.workspaces()])
		const data = standup({ entries, jobs, tasks, tickets }, day)
		return { date: day, text: standupText(data), data }
	}

	/**
	 * What to say in the meeting that is about to start.
	 *
	 * A stand-up in the morning asks about the day before; a wrap-up at six asks
	 * about today. The extension already knows both, an hour at a time, so the
	 * card arrives with the answer rather than with a prompt to go and find it.
	 */
	async meetingBrief(meetingId: string): Promise<{
		when: 'morning' | 'evening'
		kind: MeetingKind
		date: string
		text: string
		points: { heading: string; lines: string[] }[]
		lines: { label: string; minutes: number; said: string[] }[]
		next: string[]
		minutes: number
		movedTo?: string
	} | null> {
		const m = (await this.store.meetings()).find((x) => x.id === meetingId)
		if (!m) return null
		const today = istDate(this.now())
		// Noon is the line: before it the meeting is about yesterday, after it the
		// meeting is about the day you have just had.
		const at = timeOn(m, today) ?? m.time
		const when = Number(at.slice(0, 2)) < 12 ? 'morning' : 'evening'
		const about = when === 'evening' ? today : undefined
		const brief = await this.standup(about)
		const kind = m.kind ?? 'other'

		// A scrum asks three questions in a fixed order, so the card answers them
		// in that order and says nothing else. Anything else gets the same facts
		// without the ceremony.
		const heading = when === 'evening' ? 'Today' : brief.date === addDays(today, -1) ? 'Yesterday' : 'Since last time'
		const worked = brief.data.yesterday.map((l) => `${l.label} · ${fmtMinutes(l.minutes)}${l.said.length ? ` — ${l.said.join('; ')}` : ''}`)
		const tasks = await this.store.tasks()
		const open = tasks.filter((t) => t.status !== 'done' && t.kind !== 'note')
		const next = when === 'morning' ? brief.data.today : open.filter((t) => !t.blocked).map((t) => (t.key ? `${t.key} — ${t.title}` : t.title)).slice(0, 4)
		const blocked = brief.data.blocked

		const points =
			when === 'evening'
				? [
						{ heading: 'What I did today', lines: worked.length ? worked : ['Nothing logged yet.'] },
						{ heading: 'Still open', lines: next.length ? next : ['Nothing left open.'] },
						...(blocked.length ? [{ heading: 'Blocked', lines: blocked }] : []),
					]
				: [
						{ heading: heading, lines: worked.length ? worked : ['Nothing logged.'] },
						{ heading: 'Today', lines: next.length ? next : ['Nothing planned yet.'] },
						...(blocked.length ? [{ heading: 'Blocked', lines: blocked }] : []),
					]

		return {
			when,
			kind,
			date: brief.date,
			text: standupText(brief.data, 'slack', heading),
			points,
			lines: brief.data.yesterday,
			next,
			minutes: brief.data.minutes,
			movedTo: m.movedOn?.date === today ? m.movedOn.time : undefined,
		}
	}

	// ── learnings and mistakes ─────────────────────────────────────────────
	learnings(): Promise<Learning[]> {
		return this.store.learnings()
	}

	/**
	 * One note about what you learned or got wrong. The date defaults to today
	 * and the tags come out of the text, so writing it is one field and nothing
	 * else to fill in.
	 */
	async saveLearning(input: { id?: string; text: string; kind?: LearnKind; date?: string; ticketId?: string }): Promise<Learning> {
		const text = input.text.trim()
		if (!text) throw new Error('Nothing to save.')
		const list = await this.store.learnings()
		const now = this.now()
		const existing = input.id ? list.find((l) => l.id === input.id) : undefined
		if (input.id && !existing) throw new Error('That note is gone.')
		const saved: Learning = existing
			? { ...existing, text, tags: tagsOf(text), kind: input.kind ?? existing.kind, date: input.date ?? existing.date, editedAt: now }
			: { id: uid(), date: input.date ?? istDate(now), at: now, kind: input.kind ?? 'learning', text, tags: tagsOf(text), ticketId: input.ticketId }
		const next = existing ? list.map((l) => (l.id === saved.id ? saved : l)) : [saved, ...list]
		await this.store.saveLearnings(next.sort((a, b) => b.date.localeCompare(a.date) || b.at - a.at))
		this.env.ui.changed()
		return saved
	}

	/**
	 * Attach a note to a ticket, or take it off again — at any time, not only
	 * when it was written. Half of what you learn only turns out to belong to a
	 * ticket later.
	 */
	async linkLearning(id: string, ticketId: string | null): Promise<void> {
		const list = await this.store.learnings()
		if (!list.some((l) => l.id === id)) throw new Error('That note is gone.')
		if (ticketId && !(await this.store.workspaces()).some((w) => w.id === ticketId)) throw new Error('That ticket is gone.')
		await this.store.saveLearnings(list.map((l) => (l.id === id ? { ...l, ticketId: ticketId ?? undefined } : l)))
		this.env.ui.changed()
	}

	async deleteLearning(id: string): Promise<void> {
		const gone = (await this.store.learnings()).find((l) => l.id === id)
		if (gone) await this.remember({ kind: 'learning', id, label: 'deleting a learning', at: this.now(), before: gone })
		await this.store.saveLearnings((await this.store.learnings()).filter((l) => l.id !== id))
		this.env.ui.changed()
	}

	/** Tags that have come back more than once this month, worst first. */
	async learnRepeats(): Promise<Repeat[]> {
		return repeats(await this.store.learnings(), this.now())
	}

	/** Every tag you have used, for the picker — most used first. */
	async learnTags(): Promise<TagCount[]> {
		return allTags(await this.store.learnings())
	}

	/** What one ticket has taught you, for its page. */
	async learnFor(ticketId: string): Promise<Learning[]> {
		return forTicket(await this.store.learnings(), ticketId)
	}

	/** What you wrote the previous times a mistake came up. */
	async learnBehind(tag: string): Promise<Learning[]> {
		return taggedMistakes(await this.store.learnings(), tag)
	}

	// ── a ticket's notes ───────────────────────────────────────────────────
	/**
	 * Notes live under the ticket and under a date. The date defaults to today
	 * but can be set, because writing up Tuesday on Wednesday is normal.
	 */
	async saveNote(id: string, note: { noteId?: string; text: string; date?: string }): Promise<TicketNote> {
		const text = note.text.trim()
		if (!text) throw new Error('Nothing to save.')
		const list = await this.store.workspaces()
		const space = list.find((w) => w.id === id)
		if (!space) throw new Error('That workspace is gone.')
		const notes = space.notes ?? []
		const now = this.now()
		const existing = note.noteId ? notes.find((n) => n.id === note.noteId) : undefined
		if (note.noteId && !existing) throw new Error('That note is gone.')
		const saved: TicketNote = existing
			? { ...existing, text, date: note.date ?? existing.date, editedAt: now }
			: { id: uid(), date: note.date ?? istDate(now), at: now, text }
		if (!existing && notes.length >= NOTES_MAX) throw new Error(`That ticket already holds ${NOTES_MAX} notes.`)
		const next = existing ? notes.map((n) => (n.id === saved.id ? saved : n)) : [saved, ...notes]
		await this.touch(id, (w) => ({ ...w, notes: next.sort((a, b) => b.date.localeCompare(a.date) || b.at - a.at).slice(0, NOTES_MAX) }))
		return saved
	}

	async deleteNote(id: string, noteId: string): Promise<void> {
		await this.touch(id, (w) => ({ ...w, notes: (w.notes ?? []).filter((n) => n.id !== noteId) }))
	}

	async deleteWorkspace(id: string): Promise<void> {
		const gone = (await this.store.workspaces()).find((w) => w.id === id)
		if (gone) await this.remember({ kind: 'ticket', id, label: `deleting ${shortTicket(gone.name)}`, at: this.now(), before: gone })
		await this.store.saveWorkspaces((await this.store.workspaces()).filter((w) => w.id !== id))
		this.env.ui.changed()
	}

	/** What you saved for a day: made that day, or due to come back that day. */
	async savedFor(date: string): Promise<Task[]> {
		const list = await this.store.tasks()
		return list
			.filter((t) => istDate(t.createdAt) === date || (t.remindAt != null && istDate(t.remindAt) === date))
			.sort((a, b) => (a.remindAt ?? a.createdAt) - (b.remindAt ?? b.createdAt))
	}

	async createTask(t: NewTask) {
		const task = await createTask(this.store, t, this.now())
		this.env.ui.changed()
		return task
	}

	async updateTask(id: string, patch: Partial<Omit<Task, 'uid'>>) {
		await updateTask(this.store, id, patch)
		this.env.ui.changed()
	}

	async deleteTask(id: string) {
		await deleteTask(this.store, id)
		this.env.ui.changed()
	}

	async startTimer(id: string) {
		await startTimer(this.store, id, this.now())
		this.env.ui.changed()
	}

	async stopTimer() {
		const minutes = await stopTimer(this.store, this.now())
		this.env.ui.changed()
		return minutes
	}

	// ── the team: one shared repository, nothing else ──────────────────────

	/** The team as it stands: where it is, who you are on it, what you share. */
	async teamState(): Promise<{ repo: string; branch: string; path: string; member: string; hasToken: boolean; shareHours: boolean; shareWhat: boolean; shareLearnings: boolean; pageNotes: boolean; at?: number; error?: string }> {
		const [s, token, rt] = await Promise.all([this.store.settings(), this.store.syncToken(), this.store.runtime()])
		return {
			repo: s.teamRepo,
			branch: s.teamBranch,
			path: s.teamPath,
			member: s.teamMember,
			hasToken: !!token,
			shareHours: s.shareHours,
			shareWhat: s.shareWhat,
			shareLearnings: s.shareLearnings,
			pageNotes: s.pageNotes,
			at: rt.team?.at,
			error: rt.team?.error,
		}
	}

	/**
	 * Names the shared repository and checks the token can write to it — and
	 * says out loud whether it is private, because that is the whole privacy
	 * answer for a team: a private repository is a private team.
	 */
	async checkTeam(): Promise<{ repo: string; private: boolean; canWrite: boolean; login: string }> {
		const gh = await this.teamGithub()
		const [r, me] = await Promise.all([gh.check(), gh.me().catch(() => ({ login: '' }))])
		if (!(await this.store.settings()).teamMember && me.login) await this.store.saveSettings({ teamMember: me.login })
		return { repo: r.full_name, private: r.private, canWrite: r.canWrite, login: me.login }
	}

	private async teamGithub(): Promise<GitHub> {
		const [s, token] = await Promise.all([this.store.settings(), this.store.syncToken()])
		const where = parseRepo(s.teamRepo)
		if (!where) throw new Error('Set the shared repository first, as owner/name.')
		if (!token) throw new Error('Add a GitHub token with Contents and Issues: Read and write on that repository.')
		return new GitHub(token, { ...where, branch: s.teamBranch.trim() || undefined })
	}

	/**
	 * Publishes your own file. Only your own: every member writes one path, so
	 * two people pushing at the same time cannot overwrite each other's work.
	 */
	async pushTeam(days = 14): Promise<{ days: number; shared: string[] }> {
		const s = await this.store.settings()
		const shared = [s.shareHours && 'hours', s.shareWhat && 'what you worked on', s.shareLearnings && 'learnings'].filter(Boolean) as string[]
		if (!shared.length) throw new Error('Nothing is shared yet. Turn on at least one of hours, what you worked on, or learnings.')
		const gh = await this.teamGithub()
		const member = s.teamMember || (await gh.me()).login || 'me'
		const today = istDate(this.now())
		const [learnings, jobs] = await Promise.all([this.store.learnings(), this.store.jobs()])
		const list: ShareInput['days'] = []
		for (let i = 0; i < days; i++) {
			const date = addDays(today, -i)
			const [day, entries] = await Promise.all([this.store.day(date), this.store.entries(date)])
			const work = entries.filter((e) => e.kind === 'work')
			if (!work.length && day.checkedInAt == null) continue
			const by = new Map<string, number>()
			for (const e of work) {
				const label = this.label(e, jobs)
				by.set(label, (by.get(label) ?? 0) + e.minutes)
			}
			list.push({
				date,
				minutes: work.reduce((n, e) => n + e.minutes, 0),
				in: day.checkedInAt != null ? istTime(day.checkedInAt) : undefined,
				out: day.checkedOutAt != null ? istTime(day.checkedOutAt) : undefined,
				lines: [...by.entries()].map(([label, minutes]) => ({ label, minutes })).sort((a, b) => b.minutes - a.minutes),
				learnings: learnings.filter((l) => l.date === date).map((l) => ({ text: l.text, kind: l.kind })),
			})
		}
		const file = shareFile({ member, now: this.now(), days: list }, { ...NO_TEAM, repo: s.teamRepo, member, shareHours: s.shareHours, shareWhat: s.shareWhat, shareLearnings: s.shareLearnings })
		try {
			await gh.commit([{ path: memberPath(s.teamPath, member), content: JSON.stringify(file, null, 2) }], shareMessage(member, list.length, today))
		} catch (e) {
			const error = e instanceof Error ? e.message : String(e)
			await this.store.updateRuntime((r) => void (r.team = { ...r.team, error }))
			throw e
		}
		await this.store.updateRuntime((r) => void (r.team = { at: this.now(), error: undefined }))
		this.env.ui.changed()
		return { days: list.length, shared }
	}

	/**
	 * The team's day. Reads one file per member — which is why each member is a
	 * file rather than everyone being one: a read is a read, and nobody's push
	 * can break anybody else's.
	 */
	async teamBoard(date?: string): Promise<{ date: string; rows: BoardRow[]; totals: ReturnType<typeof teamTotals>; members: string[] }> {
		const s = await this.store.settings()
		const gh = await this.teamGithub()
		const day = date ?? istDate(this.now())
		const folder = (s.teamPath || 'team').replace(/^\/+|\/+$/g, '')
		// Read from what the poll already fetched: opening the board should not
		// mean waiting for the network when the answer arrived a minute ago.
		const rt = await this.store.runtime()
		let cached = rt.team?.files ?? {}
		if (!Object.keys(cached).length) {
			await this.pollTeam().catch(() => undefined)
			cached = (await this.store.runtime()).team?.files ?? {}
		}
		void gh
		void folder
		const list = Object.values(cached)
			.map((text) => {
				try {
					return JSON.parse(text) as SharedMember
				} catch {
					return null
				}
			})
			.filter((f): f is SharedMember => !!f && Array.isArray(f.days))
		const rows = board(list, day, s.teamMember)
		return { date: day, rows, totals: teamTotals(rows), members: list.map((f) => f.member) }
	}

	/**
	 * Read what the others have pushed, cheaply.
	 *
	 * One request lists the folder with a sha for every file; only the files
	 * whose sha has moved are fetched. A quiet team costs one request, which is
	 * what makes polling every minute reasonable rather than rude.
	 */
	async pollTeam(): Promise<{ changed: string[]; at: number }> {
		const s = await this.store.settings()
		if (!s.teamRepo.trim()) return { changed: [], at: this.now() }
		const gh = await this.teamGithub()
		const folder = (s.teamPath || 'team').replace(/^\/+|\/+$/g, '')
		const listing = await gh.list(`${folder}/members`).catch(() => [])
		const rt = await this.store.runtime()
		const { fetch, shas } = whoChanged(rt.team?.shas ?? {}, listing)

		const cached = { ...(rt.team?.files ?? {}) }
		for (const path of fetch) {
			const got = await gh.read(path).catch(() => null)
			if (got) cached[path] = got.text
		}
		// A file that has gone is somebody who left; drop it rather than showing
		// a board with a ghost on it.
		for (const path of Object.keys(cached)) if (!(path in shas)) delete cached[path]

		const now = this.now()
		await this.store.updateRuntime((r) => void (r.team = { ...r.team, shas, files: cached, polledAt: now }))
		const changed = fetch.map((p) => p.split('/').pop()!.replace(/\.json$/, ''))
		if (changed.length) this.env.ui.changed()
		return { changed, at: now }
	}

	/** Something happened that the others would want to see. */
	async teamChanged(): Promise<void> {
		const s = await this.store.settings()
		if (!s.teamRepo.trim() || !(s.shareHours || s.shareWhat || s.shareLearnings)) return
		await this.store.updateRuntime((r) => void (r.team = { ...r.team, changedAt: this.now() }))
	}

	async leaveTeam(): Promise<void> {
		await this.store.saveSettings({ teamRepo: '', shareHours: false, shareWhat: false, shareLearnings: false, pageNotes: false })
		await this.store.updateRuntime((r) => void (r.team = undefined))
		this.env.ui.changed()
	}

	// ── notes left on a page ───────────────────────────────────────────────

	/**
	 * How many notes this page has — yours, from this machine, with no network
	 * and no GitHub. One storage read, so every tab you touch can be checked.
	 */
	async noteCount(url: string): Promise<{ open: number; closed: number }> {
		const mine = countLocal(await this.store.pageNotes<LocalNote>(), url)
		const s = await this.store.settings()
		// Anyone else's are counted from the index, which is also local.
		const theirs = s.pageNotes && s.teamRepo ? countFor(await this.noteIndex(), url) : { open: 0, closed: 0 }
		return { open: mine.open + theirs.open, closed: mine.done + theirs.closed }
	}

	/**
	 * Everything written on this page: yours first, then the team's.
	 *
	 * Yours needs nothing set up. The team's half appears only when there is a
	 * team, and costs a network call only on a page that actually has some.
	 */
	async notesOnPage(url: string): Promise<{ open: number; closed: number; notes: PageNote[]; tickets: Record<string, string> }> {
		const list = await this.store.pageNotes<LocalNote>()
		// The names of the tickets these notes are filed under, so the list can
		// say so without a lookup per row.
		const spaces = await this.store.workspaces()
		const tickets = Object.fromEntries(spaces.map((w) => [w.id, w.name]))
		const mine: PageNote[] = notesFor(list, url).map((n) => ({
			number: n.shared?.number,
			key: n.key,
			url: n.url,
			title: n.title,
			text: n.text,
			author: 'You',
			at: n.at,
			shot: n.shot,
			clip: n.clip,
			state: n.doneAt != null ? 'closed' : 'open',
			source: 'me',
			localId: n.id,
			ticketId: n.ticketId,
		}))

		const s = await this.store.settings()
		if (!s.pageNotes || !s.teamRepo) {
			const c = countLocal(list, url)
			return { open: c.open, closed: c.done, notes: mine, tickets }
		}

		const index = await this.noteIndex()
		const count = countFor(index, url)
		const page = index.pages[urlKey(url)]
		const theirs: PageNote[] = []
		if (page) {
			const gh = await this.teamGithub()
			const shared = new Set(mine.map((n) => n.number).filter(Boolean))
			for (const n of [...page.open, ...page.closed].slice(-20)) {
				// A note of yours that you shared comes back as an issue too; it is
				// one note, and it is yours.
				if (shared.has(n)) continue
				const issue = await gh.issue(n).catch(() => null)
				if (!issue) continue
				const replies = await gh.issueComments(n).catch(() => [])
				theirs.push({
					number: issue.number,
					key: urlKey(url),
					url: pageOf(issue.body) ?? canonicalUrl(url),
					title: issue.title,
					text: textOf(issue.body),
					author: issue.user,
					at: Date.parse(issue.at),
					state: issue.state,
					replies,
					source: 'team',
				})
			}
		}
		const local = countLocal(list, url)
		return {
			open: local.open + count.open,
			closed: local.done + count.closed,
			notes: [...mine, ...theirs].sort((a, b) => b.at - a.at),
			tickets,
		}
	}

	/**
	 * Write one. Nothing leaves this machine — sharing it is a separate act,
	 * made once you have decided the rest of the team should see it.
	 */
	async noteOnPage(input: { url: string; title?: string; text: string; where?: string; shot?: string; ticketId?: string }): Promise<LocalNote> {
		if (!input.text.trim()) throw new Error('Write what is worth remembering about this page first.')
		const list = await this.store.pageNotes<LocalNote>()
		// A note that names a ticket files itself under it. "Tested PAY-3110 on
		// production" says which ticket it belongs to outright — asking again in
		// a dropdown is the app failing to read what you just wrote.
		const found = input.ticketId ? undefined : ticketForPage(input.url, input.title ?? '', await this.store.workspaces(), input.text)
		const ticketId = input.ticketId || (found?.why === 'you named it in the note' ? found.ticket.id : undefined)
		const note = { ...newNote(input, this.now(), uid()), ticketId }
		await this.store.savePageNotes(trimNotes([...list, note]))
		this.env.ui.changed()
		return note
	}

	/**
	 * The ticket a page probably belongs to, and why — so filing a note is one
	 * click rather than a hunt through a dropdown.
	 */
	async ticketFor(url: string, title = '', text = ''): Promise<{ id: string; name: string; why: string } | null> {
		const got = ticketForPage(url, title, await this.store.workspaces(), text)
		return got ? { id: got.ticket.id, name: got.ticket.name, why: got.why } : null
	}

	// ── the model you brought ──────────────────────────────────────────────

	/**
	 * Ask the model the user chose, with the text they asked about.
	 *
	 * Every AI feature in WorkPulse goes through here, which is the only reason
	 * the promise on the settings screen can be kept: one place sends, one place
	 * decides what is sent, and neither of them is ours to point elsewhere.
	 */
	async ask(messages: Message[], maxTokens = 1024): Promise<string> {
		const s = await this.store.settings()
		const cfg: LlmConfig = { provider: s.llmProvider, baseUrl: s.llmBaseUrl, model: s.llmModel }
		const key = await this.store.llmKey()
		const wrong = configProblem(cfg, key)
		if (wrong) throw new Error(wrong)
		const r = await this.env.ui.askLlm?.(endpoint(cfg), headersFor(cfg, key), bodyFor(cfg, messages, maxTokens))
		if (!r) throw new Error('Asking a model is not available here.')
		// A zero status is this end, not theirs: a refused localhost, a blocked
		// host, a dropped connection. Saying "0" to somebody helps nobody.
		if (!r.ok) throw new Error(r.status ? errorFor(r.status, r.text, cfg) : `Could not reach it. ${r.text}`)
		const text = textFrom(providerById(cfg.provider)?.shape ?? 'openai', JSON.parse(r.text || '{}'))
		if (!text) throw new Error('It answered, but with nothing in it. Try a different model.')
		return text
	}

	/** What the settings screen shows: where it goes, and whether it works. */
	async llmState(): Promise<{ provider: string; model: string; baseUrl: string; hasKey: boolean; problem: string | null; where: string }> {
		const s = await this.store.settings()
		const cfg: LlmConfig = { provider: s.llmProvider, baseUrl: s.llmBaseUrl, model: s.llmModel }
		const key = await this.store.llmKey()
		return { provider: s.llmProvider, model: s.llmModel, baseUrl: s.llmBaseUrl, hasKey: !!key, problem: configProblem(cfg, key), where: whereItGoes(cfg) }
	}

	async saveLlmKey(key: string): Promise<void> {
		await this.store.saveLlmKey(key)
		this.env.ui.changed()
	}

	/**
	 * One real round trip, so "is it set up?" has an answer before somebody
	 * relies on it in the middle of writing their self-assessment.
	 */
	async testLlm(): Promise<{ ok: true; said: string }> {
		const said = await this.ask([{ role: 'user', content: 'Reply with exactly: ready' }], 16)
		return { ok: true, said: said.slice(0, 80) }
	}

	// ── a short recording of the tab ───────────────────────────────────────

	/**
	 * Start one. It runs until you stop it, or until `seconds` have passed —
	 * that ceiling is for a recording nobody came back to stop, because the tab
	 * it is watching may never come back either.
	 *
	 * The id is minted here so the recorder can write the video straight into
	 * the blob store: a long recording is far too big to be handed back through
	 * a message.
	 */
	async startClip(seconds = MAX_SECONDS, mic = true): Promise<{ ok: boolean; why?: string }> {
		const [tab] = await Promise.all([this.currentPage()])
		const secs = Math.min(MAX_SECONDS, Math.max(3, Math.round(seconds)))
		const r = (await this.env.ui.startClip?.(secs, uid(), mic)) ?? { ok: false, why: 'Recording is not available here.' }
		if (r.ok) {
			await this.store.updateRuntime((r2) => void (r2.clip = { startedAt: this.now(), seconds: secs, url: tab?.url, title: tab?.title }))
			this.env.ui.changed()
		}
		return r
	}

	async stopClip(): Promise<void> {
		const live = await this.env.ui.stopClip?.()
		if (live) return
		// Nothing was recording: whatever the runtime still says, it is wrong.
		await this.store.updateRuntime((r) => void (r.clip = undefined))
		this.env.ui.changed()
	}

	/**
	 * Put a recording where the rest of the team can watch it.
	 *
	 * A release asset, not a commit: git keeps every version of every file for
	 * ever, GitHub refuses a blob over a hundred megabytes, and a screen
	 * recording is the one thing in this app that reaches either limit. The
	 * asset sits beside the repository — two gigabytes each, no history — and
	 * what comes back is a plain URL to paste into the ticket.
	 */
	async shareClip(noteId: string): Promise<{ url: string }> {
		const list = await this.store.pageNotes<LocalNote>()
		const note = list.find((n) => n.id === noteId)
		if (!note?.clip) throw new Error('That note has no recording.')
		// Already up: the same recording twice is two copies of the same bytes.
		if (note.clip.url) return { url: note.clip.url }
		const blob = await this.env.ui.rawBlob?.(note.clip.id)
		if (!blob) throw new Error('That recording is no longer kept on this machine.')
		const gh = await this.github()
		const url = await gh.uploadAsset(CLIP_RELEASE_TAG, `${clipName(note.clip)}.webm`, blob)
		await this.store.savePageNotes(list.map((n) => (n.id === noteId ? { ...n, clip: { ...n.clip!, url } } : n)))
		this.env.ui.changed()
		return { url }
	}

	/** The recording itself, as a data URL, for showing it or sending it on. */
	async clipData(id: string): Promise<string | null> {
		return (await this.env.ui.readBlob?.(id)) ?? null
	}

	/** What is being recorded, if anything — for the countdown. */
	async clipNow(): Promise<{ startedAt: number; seconds: number; title?: string } | null> {
		const rt = await this.store.runtime()
		if (!rt.clip) return null
		// It stops itself; if the stop never arrived, the record goes stale rather
		// than leaving a countdown running for ever.
		if (this.now() - rt.clip.startedAt > (rt.clip.seconds + 20) * 1000) {
			await this.store.updateRuntime((r) => void (r.clip = undefined))
			return null
		}
		return { startedAt: rt.clip.startedAt, seconds: rt.clip.seconds, title: rt.clip.title }
	}

	/**
	 * The finished recording, handed over by the offscreen document.
	 *
	 * It becomes a note on the page it was recorded on — the recording *is* the
	 * note, and asking somebody to write one first would mean recording the
	 * wrong thirty seconds.
	 */
	async clipRecorded(c: { id: string; ms: number; bytes: number; type: string }): Promise<void> {
		const rt = await this.store.runtime()
		const about = rt.clip
		await this.store.updateRuntime((r) => void (r.clip = undefined))
		if (!about?.url || !clipUsable(c)) {
			// Nothing worth keeping, but the recorder already wrote it: the sweep
			// below is what takes it away again.
			await this.env.ui.sweepBlobs?.(clipsToKeep(await this.store.pageNotes<LocalNote>()))
			this.env.ui.changed()
			return
		}
		const id = c.id
		const list = await this.store.pageNotes<LocalNote>()
		const note: LocalNote = {
			...newNote({ url: about.url, title: about.title, text: `Recording · ${Math.round(c.ms / 1000)}s` }, this.now(), uid()),
			clip: { id, ms: c.ms, bytes: c.bytes, at: this.now(), type: c.type },
		}
		await this.store.savePageNotes(trimNotes([...list, note]))
		// Older clips go; the newest few and anything shared are kept.
		await this.env.ui.sweepBlobs?.(clipsToKeep(await this.store.pageNotes<LocalNote>()))
		this.env.ui.changed()
	}

	/** The name a note goes by. Defaults to the page's title, which is rarely yours. */
	async renameNote(id: string, title: string): Promise<void> {
		const name = title.trim().slice(0, 120)
		if (!name) throw new Error('Give it a name, or leave the old one.')
		const list = await this.store.pageNotes<LocalNote>()
		await this.store.savePageNotes(list.map((n) => (n.id === id ? { ...n, title: name } : n)))
		this.env.ui.changed()
	}

	/** File a page note under a ticket, or take it out again. */
	async noteToTicket(id: string, ticketId: string): Promise<void> {
		const list = await this.store.pageNotes<LocalNote>()
		await this.store.savePageNotes(list.map((n) => (n.id === id ? { ...n, ticketId: ticketId || undefined } : n)))
		this.env.ui.changed()
	}

	/** Everything written on the pages of one ticket, newest first. */
	async ticketNotes(ticketId: string): Promise<LocalNote[]> {
		return (await this.store.pageNotes<LocalNote>()).filter((n) => n.ticketId === ticketId).sort((a, b) => b.at - a.at)
	}

	/** Dealt with, or back on the list. Kept either way. */
	async noteDone(id: string, done = true): Promise<void> {
		const list = await this.store.pageNotes<LocalNote>()
		await this.store.savePageNotes(list.map((n) => (n.id === id ? { ...n, doneAt: done ? this.now() : undefined } : n)))
		this.env.ui.changed()
	}

	async deletePageNote(id: string): Promise<void> {
		const list = await this.store.pageNotes<LocalNote>()
		const gone = list.find((n) => n.id === id)
		if (gone) await this.remember({ kind: 'pageNote', id, label: 'deleting a page note', at: this.now(), before: gone })
		await this.store.savePageNotes(list.filter((n) => n.id !== id))
		this.env.ui.changed()
	}

	/** Every page you have written on, most recent first. */
	async notedPages(): Promise<ReturnType<typeof pagesWithNotes>> {
		return pagesWithNotes(await this.store.pageNotes<LocalNote>())
	}

	/**
	 * Hand one to the team.
	 *
	 * It becomes an issue in the shared repository — somewhere they already look
	 * — with the screenshot committed beside it. The note stays yours and
	 * remembers the issue, so it is never shared twice.
	 */
	async shareNote(id: string): Promise<{ number: number; url: string }> {
		const list = await this.store.pageNotes<LocalNote>()
		const note = list.find((n) => n.id === id)
		if (!note) throw new Error('That note is gone.')
		if (note.shared) return { number: note.shared.number, url: note.shared.url }
		const s = await this.store.settings()
		if (!s.teamRepo) throw new Error('No team yet. Set one up under Team, then share it.')
		const gh = await this.teamGithub()
		const author = s.teamMember || (await gh.me()).login || 'me'
		const now = this.now()

		let shot: string | undefined
		if (note.shot) {
			const base64 = note.shot.replace(/^data:image\/\w+;base64,/, '')
			// The same name the backup uses, so the two folders read alike and the
			// file says what it is a picture of.
			const ticket = note.ticketId ? ticketKey((await this.store.workspaces()).find((w) => w.id === note.ticketId)?.name ?? '') ?? undefined : undefined
			shot = `${(s.teamPath || 'team').replace(/^\/+|\/+$/g, '')}/shots/${shotName({ ...note, ticket })}`
			await gh.commit([{ path: shot, content: base64, raw: true }], `notes: screenshot for ${note.title}`)
		}
		const title = `${note.title} — ${note.text.split('\n')[0].slice(0, 60)}`
		const issue = await gh.openIssue(
			title,
			issueBody({ url: note.url, text: note.text, shot, author, at: note.at, where: note.where, repo: s.teamRepo, branch: s.teamBranch || undefined }),
			['workpulse-page'],
		)
		await this.saveNoteIndex(indexWith(await this.noteIndex(), note.url, issue.number, 'open', now))
		await this.store.savePageNotes(list.map((n) => (n.id === id ? { ...n, shared: { number: issue.number, url: issue.url, at: now } } : n)))
		this.env.ui.changed()
		return issue
	}

	/**
	 * Holds a screenshot and the page it came from until the composer opens.
	 * A PNG is a megabyte; it travels through storage rather than through a URL.
	 */
	async draftPageNote(draft: { url: string; title?: string; where?: string; shot?: string }): Promise<void> {
		await this.store.updateRuntime((r) => void (r.noteDraft = { ...draft, at: this.now() }))
		this.env.ui.changed()
	}

	/** The draft the composer opens with, and then forgets. */
	async pageNoteDraft(): Promise<{ url: string; title?: string; where?: string; shot?: string; at: number } | null> {
		return (await this.store.runtime()).noteDraft ?? null
	}

	async clearPageNoteDraft(): Promise<void> {
		await this.store.updateRuntime((r) => void (r.noteDraft = undefined))
	}

	async replyToNote(number: number, text: string): Promise<void> {
		if (!text.trim()) throw new Error('Nothing to say yet.')
		const gh = await this.teamGithub()
		await gh.replyToIssue(number, text.trim())
		this.env.ui.changed()
	}

	async closeNote(number: number, url: string, state: 'open' | 'closed' = 'closed'): Promise<void> {
		const gh = await this.teamGithub()
		await gh.closeIssue(number, state)
		await this.saveNoteIndex(indexWith(await this.noteIndex(), url, number, state, this.now()))
		this.env.ui.changed()
	}

	/**
	 * Rebuilds the index from the repository's own issues. Needed when someone
	 * else left the note: their extension wrote their index, and yours has never
	 * seen it. Cheap enough to run on opening the panel.
	 */
	async refreshNotes(): Promise<number> {
		const gh = await this.teamGithub()
		const issues = await gh.issuesWith('workpulse-page')
		let index = EMPTY_INDEX
		for (const i of issues) {
			const page = pageOf(i.body)
			if (page) index = indexWith(index, page, i.number, i.state, this.now())
		}
		await this.saveNoteIndex(index)
		this.env.ui.changed()
		return issues.length
	}

	private noteIndex(): Promise<NoteIndex> {
		return this.store.noteIndex<NoteIndex>(EMPTY_INDEX)
	}

	private async saveNoteIndex(index: NoteIndex): Promise<void> {
		await this.store.saveNoteIndex(index)
	}

	/**
	 * What an entry is *about*, for the team board: the ticket key if the line
	 * mentions one, else the job it went against. Never the words themselves —
	 * those are shared only when "what you worked on" is on, and then as the
	 * grouped label, not the sentence.
	 */
	private label(e: Entry, jobs: Job[]): string {
		return ticketKey(e.text) ?? jobs.find((j) => j.id === e.jobId)?.name ?? 'Other'
	}

	/**
	 * The daily picture: the day so far, the run behind it, and anything that is
	 * about to stop being fixable.
	 *
	 * One call, because this is read on every surface — the dashboard, the
	 * widget, the card — and three calls to say one thing is how a popup comes
	 * to take half a second to open.
	 */
	async pulse(): Promise<{
		today: string
		logged: number
		target: number
		elapsed: number
		gap: number
		checkedIn: boolean
		off: boolean
		streak: Streak
		strip: { date: string; done: boolean; off: boolean }[]
		owed: (Owed & { locks: string })[]
	}> {
		const now = this.now()
		const today = istDate(now)
		const s = await this.store.settings()
		const states: DayState[] = []
		// Three weeks: long enough for a fortnight strip and the lock window.
		for (let i = 20; i >= 0; i--) {
			const date = addDays(today, -i)
			const [day, entries] = await Promise.all([this.store.day(date), this.store.entries(date)])
			const off = day.isOff || (day.offKind != null && day.offKind !== 'half') || !isWorkDay(date, s.workDays)
			states.push({
				date,
				loggedMinutes: entries.filter((e) => e.kind === 'work').reduce((n, e) => n + e.minutes, 0),
				expectedMinutes: off ? 0 : hoursFor(day.offKind === 'half' ? 'half' : 'work', s.minHours) * 60,
				checkedIn: day.checkedInAt != null,
				off,
			})
		}
		const mine = states.find((d) => d.date === today)!
		const day = await this.store.day(today)
		const elapsed = day.checkedInAt != null ? Math.round(((day.checkedOutAt ?? now) - day.checkedInAt) / MIN) : 0
		return {
			today,
			logged: mine.loggedMinutes,
			target: mine.expectedMinutes,
			elapsed,
			// Measured against the clock, not the target: at eleven in the morning
			// you are not six hours behind, you are however long you have been here.
			gap: mine.off ? 0 : Math.max(0, Math.min(elapsed, mine.expectedMinutes) - mine.loggedMinutes),
			checkedIn: mine.checkedIn,
			off: mine.off,
			streak: streakOf(states, today),
			strip: lastDays(states, today, 14).map((d) => ({ date: d.date, done: isComplete(d), off: d.off || d.expectedMinutes === 0 })),
			owed: owedDays(states, today).map((o) => ({ ...o, locks: lockLine(o.date, today, (d) => istWeekday(atIst(d, '12:00'))) })),
		}
	}

	// ── putting it back ────────────────────────────────────────────────────

	/** Keep one record as it was, so the next thing done to it can be undone. */
	private async remember(u: Undoable): Promise<void> {
		if (!u.label) return // a placeholder taken before the work; the real one follows
		await this.store.updateRuntime((r) => void (r.undo = { kind: u.kind, label: u.label, at: u.at, before: u.before, id: u.id }))
	}

	/** What could be put back, if anything, and what it would say on the button. */
	async undoable(): Promise<{ label: string; at: number } | null> {
		const rt = await this.store.runtime()
		const u = undoOffered(rt.undo as Undoable | undefined, this.now())
		return u ? { label: undoLabel(u), at: u.at } : null
	}

	/**
	 * Put the last thing back.
	 *
	 * A snapshot, not a replayed inverse: the inverse of "add these links" is
	 * "remove these links" — unless one of them was already there, in which case
	 * removing it loses something you had. A snapshot has no edges.
	 */
	async undo(): Promise<{ label: string } | null> {
		const rt = await this.store.runtime()
		const u = undoOffered(rt.undo as Undoable | undefined, this.now())
		if (!u) return null
		await this.store.updateRuntime((r) => void (r.undo = undefined))

		if (u.kind === 'ticket') {
			const list = await this.store.workspaces()
			const before = u.before as Workspace | null
			if (before) await this.store.saveWorkspaces(list.some((w) => w.id === before.id) ? list.map((w) => (w.id === before.id ? before : w)) : [...list, before])
			else if (u.id) await this.store.saveWorkspaces(list.filter((w) => w.id !== u.id))
		} else if (u.kind === 'tickets') {
			await this.store.saveWorkspaces(u.before as Workspace[])
		} else if (u.kind === 'learning') {
			const list = await this.store.learnings()
			const before = u.before as Learning | null
			if (before) await this.store.saveLearnings(list.some((l) => l.id === before.id) ? list.map((l) => (l.id === before.id ? before : l)) : [...list, before])
		} else if (u.kind === 'pageNote') {
			const list = await this.store.pageNotes<LocalNote>()
			const before = u.before as LocalNote | null
			if (before) await this.store.savePageNotes(trimNotes(list.some((n) => n.id === before.id) ? list.map((n) => (n.id === before.id ? before : n)) : [...list, before]))
		}
		this.env.ui.changed()
		return { label: u.label }
	}

	// ── work that is not moving ────────────────────────────────────────────

	/**
	 * What is blocked, what you have abandoned, and which links have gone quiet.
	 *
	 * One call, because all three are read on the same screen and all three come
	 * from the same three reads.
	 */
	async notMoving(days = 30): Promise<{
		waiting: ReturnType<typeof waitingOn>
		waitingLine: string | null
		stale: ReturnType<typeof startedAndStopped>
		quiet: ReturnType<typeof quietLinks>
		lostMinutes: number
	}> {
		const today = istDate(this.now())
		const from = addDays(today, -days)
		const [tasks, tickets, s] = await Promise.all([this.store.tasks(), this.store.workspaces(), this.store.settings()])
		const entries: { date: string; text: string; minutes: number }[] = []
		const workedDays: string[] = []
		for (let d = from; d <= today; d = addDays(d, 1)) {
			const [list, day] = await Promise.all([this.store.entries(d), this.store.day(d)])
			for (const e of list) if (e.kind === 'work') entries.push({ date: d, text: e.text, minutes: e.minutes })
			if (!day.isOff && day.checkedInAt != null && isWorkDay(d, s.workDays)) workedDays.push(d)
		}
		const waiting = waitingOn({ today, tasks, entries, workedDays, dateOf: istDate })
		return {
			waiting,
			waitingLine: waitingLine(waiting),
			stale: startedAndStopped({ today, tickets, entries, dateOf: istDate }),
			quiet: quietLinks({ today, tickets, entries, dateOf: istDate }),
			// What finished work spent waiting, in the hours you were at your desk.
			// It is the only number in the app that is really about somebody else.
			lostMinutes: waiting.reduce((n, w) => n + w.hereDays * s.minHours * 60, 0),
		}
	}

	// ── where the week went ────────────────────────────────────────────────

	async week(to?: string): Promise<{ split: ReturnType<typeof weekSplit>; line: string | null }> {
		const end = to ?? istDate(this.now())
		const from = spanFrom(end, 'week')
		const [jobs, meetings, rt] = await Promise.all([this.store.jobs(), this.store.meetings(), this.store.runtime()])
		const entries: Entry[] = []
		let meetingMinutes = 0
		for (let d = from; d <= end; d = addDays(d, 1)) {
			const list = await this.store.entries(d)
			entries.push(...list)
			// An entry that sits inside a booked meeting is meeting time, however
			// it was written down.
			const slots = meetingSlots(meetings, d)
			for (const e of list) {
				if (e.kind !== 'work') continue
				const inside = slots.some((m) => e.slotStart < m.to && e.slotEnd > m.from)
				if (inside) meetingMinutes += e.minutes
			}
		}
		const work = entries.filter((e) => e.kind === 'work')
		const deep = deepStats(rt.deep ?? [], from, end)
		const split = weekSplit({
			from,
			to: end,
			entries: work.map((e) => ({ date: e.date, text: e.text, minutes: e.minutes, slotStart: e.slotStart })),
			meetingMinutes,
			deepMinutes: deep.minutes,
			switches: switches(work, (id) => jobs.find((j) => j.id === id)?.name ?? id),
		})
		return { split, line: weekLine(split) }
	}

	/** Everything the Friday five minutes needs, assembled. */
	async weekReview(to?: string): Promise<WeekReview> {
		const end = to ?? istDate(this.now())
		const from = spanFrom(end, 'week')
		const [{ split }, period, notMoving, plans] = await Promise.all([this.week(end), this.period('week', from, end), this.notMoving(30), this.store.allPlans()])
		// The most recent one written on an earlier day — which on Monday is last
		// Friday's, and on Friday afternoon is the week before's.
		const today = istDate(this.now())
		const lastWeek = (plans as DayPlan[]).filter((p) => p.date < today && p.weekIntention).sort((a, b) => b.date.localeCompare(a.date))[0]
		return {
			from,
			to: end,
			split,
			worked: period.report.lines.map((l) => ({ label: l.name ?? l.label, minutes: l.minutes })),
			finished: period.report.finished.map((f) => (f.key ? `${f.key} — ${f.title}` : f.title)),
			learned: period.report.learnings.map((l) => l.text),
			waiting: notMoving.waiting.map((w) => `${w.key ?? w.title} — ${w.hereDays || w.days} day${(w.hereDays || w.days) === 1 ? '' : 's'}`),
			lastIntention: lastWeek?.weekIntention,
		}
	}

	/** The one thing that would make next week better. Shown again on Monday. */
	async saveWeekIntention(text: string): Promise<void> {
		const today = istDate(this.now())
		await this.store.savePlan(today, { ...(await this.store.plan(today)), weekIntention: text.trim().slice(0, 240) || undefined })
		await this.store.updateRuntime((r) => void (r.flags.weekReviewed = today))
		this.env.ui.changed()
	}

	// ── the period you cannot remember ─────────────────────────────────────

	/**
	 * A week, a month, or the last six months — grouped by what the work was
	 * about, in the words you used at the time.
	 *
	 * This is the one question nobody can answer and the only one WorkPulse is
	 * uniquely placed to: a tracker knows a ticket moved, your manager knows
	 * what they remember, and you wrote the real answer down an hour at a time.
	 */
	async period(span: Span = 'month', from?: string, to?: string): Promise<{ report: PeriodReport; text: string }> {
		const today = istDate(this.now())
		const end = to ?? today
		const start = from ?? (span === 'custom' ? addDays(end, -29) : spanFrom(end, span))
		const [jobs, tasks, tickets, learnings, s] = await Promise.all([
			this.store.jobs(),
			this.store.tasks(),
			this.store.workspaces(),
			this.store.learnings(),
			this.store.settings(),
		])
		const entries: Entry[] = []
		for (let d = start; d <= end; d = addDays(d, 1)) entries.push(...(await this.store.entries(d)))
		const report = periodReport({ entries, jobs, tasks, tickets, learnings }, start, end, span)
		return { report, text: periodText(report, 'markdown', s.teamMember || undefined) }
	}

	// ── how long things really take you ────────────────────────────────────

	/**
	 * Estimate against actual, over everything finished.
	 *
	 * The estimate is one optional field on a ticket; the actual is every minute
	 * logged with that ticket's key in it, which nothing else in the world has.
	 */
	async calibration(): Promise<{ c: Calibration; line: string | null; rows: Estimated[] }> {
		const [tickets, jobs] = await Promise.all([this.store.workspaces(), this.store.jobs()])
		const estimated = tickets.filter((w) => (w.estimateMinutes ?? 0) > 0)
		if (!estimated.length) return { c: calibrate([]), line: calibrationLine(calibrate([])), rows: [] }

		// Everything logged in the window the tickets span, read once.
		const today = istDate(this.now())
		const oldest = estimated.reduce((d, w) => Math.min(d, w.at), Date.now())
		const entries: Entry[] = []
		for (let d = istDate(oldest); d <= today; d = addDays(d, 1)) entries.push(...(await this.store.entries(d)))

		const rows: Estimated[] = estimated.map((w) => {
			const key = ticketKey(w.name)
			const mine = entries.filter((e) => e.kind === 'work' && key != null && ticketKey(e.text) === key)
			return {
				label: w.name,
				estimateMinutes: w.estimateMinutes ?? 0,
				actualMinutes: mine.reduce((n, e) => n + e.minutes, 0),
				at: mine.at(-1)?.slotEnd ?? w.at,
			}
		})
		// Only finished work can be compared: a ticket still running has not
		// taken its final time yet, and counting it says everyone is fast.
		const done = rows.filter((r) => estimated.find((w) => w.name === r.label)?.archivedAt != null || r.actualMinutes > 0)
		const c = calibrate(done)
		void jobs
		return { c, line: calibrationLine(c), rows: rows.sort((a, b) => b.at - a.at) }
	}

	/** How long you think it will take. Asked once, never again. */
	async setEstimate(id: string, minutes: number): Promise<void> {
		const list = await this.store.workspaces()
		await this.store.saveWorkspaces(list.map((w) => (w.id === id ? { ...w, estimateMinutes: Math.max(0, Math.round(minutes)) || undefined } : w)))
		this.env.ui.changed()
	}

	// ── the hours you actually worked ──────────────────────────────────────

	/**
	 * Overtime, counted. Nobody else counts this for you: the timesheet is what
	 * the company bills, attendance is punches, and neither ever says "that was
	 * a forty-seven hour week".
	 */
	async hours(span: 'week' | 'month' = 'week', to?: string): Promise<{ o: Overtime; line: string | null; days: WorkedDay[] }> {
		const end = to ?? istDate(this.now())
		const start = spanFrom(end, span === 'week' ? 'week' : 'month')
		const s = await this.store.settings()
		const days: WorkedDay[] = []
		for (let d = start; d <= end; d = addDays(d, 1)) {
			const [day, entries] = await Promise.all([this.store.day(d), this.store.entries(d)])
			const logged = entries.filter((e) => e.kind === 'work').reduce((n, e) => n + e.minutes, 0)
			const clock = day.checkedInAt != null && day.checkedOutAt != null ? Math.round((day.checkedOutAt - day.checkedInAt) / MIN) : (day.zohoMinutes ?? 0)
			const off = day.isOff || (day.offKind != null && day.offKind !== 'half')
			days.push({
				date: d,
				clockMinutes: clock,
				loggedMinutes: logged,
				expectedMinutes: off || !isWorkDay(d, s.workDays) ? 0 : hoursFor(day.offKind === 'half' ? 'half' : 'work', s.minHours) * 60,
				off: off || !isWorkDay(d, s.workDays),
			})
		}
		const o = overtime(days, start, end)
		return { o, line: overtimeLine(o), days }
	}

	// ── cover for me ───────────────────────────────────────────────────────

	/**
	 * What someone needs to pick up your tickets on the morning you are not
	 * there. Assembled from what is already written: the links with your own
	 * labels, the notes by day, what you said you were doing, and the gotchas.
	 */
	async handover(days = 14): Promise<{ h: Handover; text: string }> {
		const today = istDate(this.now())
		const from = addDays(today, -(days - 1))
		const [tickets, tasks, learnings, meetings, s] = await Promise.all([
			this.store.workspaces(),
			this.store.tasks(),
			this.store.learnings(),
			this.store.meetings(),
			this.store.settings(),
		])
		const entries: Entry[] = []
		for (let d = from; d <= today; d = addDays(d, 1)) entries.push(...(await this.store.entries(d)))
		const open = tasks.filter((t) => t.kind !== 'note' && t.status !== 'done')

		const live = tickets.filter((w) => w.archivedAt == null)
		const rows: HandoverTicket[] = live.map((w) => {
			const key = ticketKey(w.name)
			const mine = entries.filter((e) => e.kind === 'work' && key != null && ticketKey(e.text) === key)
			const theirs = (t: { key?: string; title: string }) => (key && (t.key === key || ticketKey(t.title) === key)) || false
			return {
				id: w.id,
				name: w.name,
				minutes: mine.reduce((n, e) => n + e.minutes, 0),
				lastAt: mine.at(-1)?.slotEnd ?? w.updatedAt ?? w.at,
				said: [...mine].reverse().map((e) => e.text.trim()).filter((t, i, all) => t && all.indexOf(t) === i),
				links: w.tabs.map((t) => ({ title: t.title, url: t.url, note: t.note })),
				notes: (w.notes ?? []).map((n) => ({ date: n.date, text: n.text })),
				open: open.filter(theirs).map((t) => t.title),
				// A mistake written against this ticket is exactly the sentence that
				// begins "the thing that will catch you out".
				watchOut: learnings.filter((l) => l.ticketId === w.id || (key && l.text.includes(key))).map((l) => l.text),
			}
		})

		// Only what is actually live: a ticket nobody has touched in a fortnight
		// and has nothing open against it is not something to hand over.
		const worth = rows.filter((t) => t.minutes > 0 || t.open.length || t.notes.length)
		const h = handover({
			from: today,
			to: addDays(today, days - 1),
			who: s.teamMember || undefined,
			tickets: worth,
			loose: open.filter((t) => !worth.some((w) => w.open.includes(t.title))).map((t) => t.title),
			meetings: meetings.filter((m) => m.enabled).map((m) => ({ name: m.name, time: m.time, days: m.days })),
		})
		return { h, text: handoverText(h) }
	}

	// ── one search across everything ───────────────────────────────────────

	/** Where did I write that down? Entries, notes, learnings, tickets, links, tasks. */
	async findAll(query: string, days = 180): Promise<{ hits: Hit[]; kinds: { kind: HitKind; count: number }[] }> {
		if (query.trim().length < 2) return { hits: [], kinds: [] }
		const today = istDate(this.now())
		const from = addDays(today, -days)
		const [tickets, tasks, learnings, rt] = await Promise.all([this.store.workspaces(), this.store.tasks(), this.store.learnings(), this.store.runtime()])
		const all = [...new Map([...(rt.bridge?.queue ?? []), ...fold(rt.bridge?.files ?? {})].map((e) => [e.id, e])).values()]
		const asHay = (list: typeof all) => list.map((e) => ({ id: e.id, title: e.title, subtitle: e.subtitle, kind: BRAIN_KIND[e.kind] ?? e.kind, ticket: e.ticket, at: e.at, more: [e.body, e.asked, e.done, e.rootCause, e.project, ...(e.tags ?? []), ...(e.next ?? [])].filter(Boolean).join(' ') }))
		// `ticket:`, `type:`, `has:next-action` … are about the Brain: with any of
		// them, the search is the Brain's alone, and filters with no words list
		// everything that passes, newest first.
		const q = parseBrainQuery(query, this.now())
		if (q.filtered) {
			const pool = asHay(all.filter((e) => matchBrain(e, q.filters)))
			const none = { entries: [], notes: [], learnings: [], tickets: [], links: [], tasks: [] }
			const hits = q.text.trim().length >= 2
				? findAll(q.text, { ...none, brain: pool })
				: pool.sort((a, b) => b.at - a.at).slice(0, 60).map((b): Hit => ({ kind: 'brain', text: b.subtitle ? `${b.title} — ${b.subtitle}` : b.title, where: [b.kind, b.ticket].filter(Boolean).join(' · '), at: b.at, score: 1, hash: b.ticket ? `#/brain/${b.ticket}` : '#/brain' }))
			return { hits, kinds: countKinds(hits) }
		}
		const entries: { date: string; text: string; slotStart: number }[] = []
		for (let d = from; d <= today; d = addDays(d, 1)) {
			for (const e of await this.store.entries(d)) entries.push({ date: d, text: e.text, slotStart: e.slotStart })
		}
		const hits = findAll(query, {
			entries,
			notes: tickets.flatMap((w) => (w.notes ?? []).map((n) => ({ ticketId: w.id, ticketName: w.name, date: n.date, text: n.text, at: n.at }))),
			learnings: learnings.map((l) => ({ id: l.id, date: l.date, text: l.text, kind: l.kind, at: l.at })),
			tickets: tickets.map((w) => ({ id: w.id, name: w.name, at: w.updatedAt ?? w.at })),
			links: tickets.flatMap((w) => w.tabs.map((t) => ({ ticketId: w.id, ticketName: w.name, title: t.title, url: t.url, note: t.note, addedAt: t.addedAt }))),
			tasks: tasks.map((t) => ({ uid: t.uid, title: t.title, key: t.key, status: t.status, createdAt: t.createdAt })),
			brain: asHay(all),
		})
		return { hits, kinds: countKinds(hits) }
	}
}

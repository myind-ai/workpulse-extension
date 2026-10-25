// The engine runs every alarm tick: it records away time, clears forced UI
// that is no longer owed, builds a snapshot, asks `decide()` what to do and
// does it. Every dependency is injected (Env) so it is tested with fakes.

import { API_ENABLED } from '@/core/features'
import { repeats } from '@/core/learn'
import { backupDue } from '@/core/sync'
import { classify, classifyLocal, hoursFromHHMM, isWorkDay, parseZohoDateTime, scanRange } from '@/core/rules'
import { ACTIVE_SECS, countInterrupt, decide, IDLE_SKIP_SECS, mayInterrupt, promptOwed, type Action, type Snapshot } from '@/core/schedule'
import { addDays, atIst, DAY, istDate, istTime, istWeekday, MIN, prettyDate } from '@/core/time'
import { emptyFlags, type Day, type IssueKind, type Pending, type Runtime } from '@/core/types'
import { timeOn } from '@/core/zoho-page'
import { ZohoError } from '@/core/zoho-parse'
import type { Store } from '@/lib/store'
import { dueNudges, mergeNudges, noteForNext, type HealthNote, type NudgeKind } from '@/core/health'
import { dueBlock } from '@/core/deepwork'
import { pollDue, shareDue } from '@/core/team'
import { reviewDue } from '@/core/week'
import { dayKind, hoursFor, isOffKind } from '@/core/leave'
import { badgeFor, LOCK_AFTER_DAYS } from '@/core/habit'
import { badMoment, deferUntil } from '@/core/predict'
import { leftAt, needsClosing } from '@/core/closeout'
import { dueMeetings, dueToLog, logsItself, meetingSlot, meetingSlots, meetingWhen, timeOn as meetingTimeOn, type Meeting } from '@/core/meetings'
import { dueReminders, nextRepeat } from '@/lib/tasks'
import type { ZohoApi } from '@/lib/zoho'

export interface Ui {
	/** Make the forced UI for `p` visible (overlay on the active tab, or the prompt window). */
	show(p: Pending): Promise<void>
	hide(): Promise<void>
	notify(id: string, title: string, body: string, sticky: boolean): void
	openUrl(url: string): Promise<void>
	openDashboard(view: string): Promise<void>
	/** Address of one of our own pages, for opening it alongside other tabs. */
	pageUrl?(view: string): string
	/** Writes the daily backup to the configured repository. */
	pushBackup?(): Promise<unknown>
	/** Is a Zoho People tab open in this browser at all? */
	hasZohoTab?(): Promise<boolean>
	/** Pages visited in a window of time, when you have allowed it. */
	visits?(from: number, to: number): Promise<{ url: string; title: string; at: number }[]>
	badge(text: string, color: string): void
	/** Tell open extension pages that state changed. */
	changed(): void
	/** A short chime, for reminders you must not miss. */
	chime?(): void
	/** A sound that keeps going until the card is answered. */
	alarm?(on: boolean): void
	/** Put the quick-actions box on the page in front of you. */
	openPalette?(): Promise<void>
	/** Publish your own file to the team's repository. */
	shareTeam?(): Promise<unknown>
	/** Read what the others pushed, fetching only what moved. */
	pollTeam?(): Promise<unknown>
	/** Read what the CLI and other devices wrote under bridge/. */
	pollBridge?(): Promise<unknown>
	/** A picture of the tab in front — or nothing, if `of` is not the tab in front. */
	capturePage?(of?: string): Promise<string | null>
	/** The most recently used ordinary page — not WorkPulse's own. */
	currentPage?(): Promise<{ title: string; url: string } | null>
	/** Pulse a frame round the page, so a silent capture is not a silent one. */
	flashShot?(): Promise<void>
	/** Start and stop a recording of the tab in front of you. */
	startClip?(seconds: number, id: string, mic: boolean): Promise<{ ok: boolean; why?: string }>
	/** Answers false when there was no recorder left to stop. */
	stopClip?(): Promise<boolean>
	/** The blob store. The recorder writes to it directly; this only reads. */
	readBlob?(id: string): Promise<string | null>
	/** The same, still bytes — an upload must not go through base64. */
	rawBlob?(id: string): Promise<Blob | null>
	sweepBlobs?(keep: string[]): Promise<void>
	/** Take a notification off the screen — the card has taken its place. */
	clearNote?(id: string): void
	/** Whether now is a bad time to cover somebody's screen. */
	moment?(): Promise<{ fullscreen?: boolean; activeUrl?: string }>
	/** The ids of tabs it is safe to take off the screen: never pinned, never ours. */
	parkableTabs?(): Promise<number[]>
	/** Which optional permissions are held right now — asked, never assumed. */
	grantedPermissions?(): Promise<string[]>
	/** How many screenshots and recordings are on disk. */
	blobCount?(): Promise<number>
	/** Delete everything, for good. No soft delete, no retention period. */
	wipeAll?(): Promise<void>
	/** Ask the model the user chose. Only the worker has the host permissions. */
	askLlm?(url: string, headers: Record<string, string>, body: string): Promise<{ ok: boolean; status: number; text: string }>
	/** Everything open in this window, for keeping it under one name. */
	windowTabs?(): Promise<{ title: string; url: string }[]>
	/** Close these tabs, after their contents were saved. */
	closeTabs?(ids: number[]): Promise<void>
	/** Reopen a saved piece of work, as one named tab group when it has a name. */
	openTabs?(urls: string[], groupName?: string): Promise<void>
	/** Put the guided-setup helper on the active Zoho tab, if it is one. */
	injectSetupHelper?(): Promise<void>
	/** Run the reader on an open Zoho People tab. False when none is open. */
	readZohoPage?(): Promise<boolean>
	/** Punch on your open Zoho People tab, from your click only. False when no tab. */
	punchZohoPage?(): Promise<boolean>
	/** Save the day's time logs on your open Zoho People tab, from your click only. */
	writeZohoPage?(): Promise<boolean>
	/** Record which endpoints Zoho's own web app calls, for the no-API path. */
	record?(on: boolean): void
	recording?(): boolean
}

export interface Env {
	store: Store
	zoho: ZohoApi
	now(): number
	idleSecs(): Promise<number>
	ui: Ui
}

const ISSUE_LABEL = { absent: 'absent', missing_checkout: 'missing checkout', short_hours: 'short hours' } as const
/** How long a ringing card keeps ringing before it settles for being there. */
const RING_FOR = 20 * MIN

/** Anything that only makes sense when the official API is in play. */
const API_NOISE = /session expired|sign in again|not connected|access token|oauth|client id|api'?s|scope/i

/** Which notifications a card makes redundant the moment it appears. */
const NOTES_FOR: Partial<Record<Pending['kind'], string[]>> = {
	checkin: ['checkin'],
	closeout: ['wrapup', 'catchup'],
	wrapup: ['wrapup', 'hoursdone'],
	prompt: ['prompt'],
	remind: ['taskdue'],
}

export class Engine {
	constructor(readonly env: Env) {}

	get store() {
		return this.env.store
	}

	today() {
		return istDate(this.env.now())
	}

	async tick(): Promise<Action[]> {
		const now = this.env.now()
		const today = istDate(now)
		const idle = await this.env.idleSecs()
		// An API error you cannot act on — the API is off, or was never connected —
		// is noise. Drop it rather than leaving it on screen for ever.
		const noApi = !API_ENABLED || (await this.store.auth()) == null
		await this.store.updateRuntime((r) => {
			if (r.flags.date !== today) {
				r.flags = emptyFlags(today)
				r.snoozes = 0
				r.lastSync = undefined
				r.awaiting = undefined
				r.away = r.away.filter(([, b]) => b > now - DAY)
				if (r.pending && istDate(r.pending.since) !== today) r.pending = null
			}
			// A wall-clock gap between ticks means the computer slept or Chrome was closed.
			if (r.lastTick != null && now - r.lastTick > 2 * MIN) r.away.push([r.lastTick, now])
			if (idle >= IDLE_SKIP_SECS) {
				if (r.idleStart == null) r.idleStart = now - idle * 1000
			} else if (idle < ACTIVE_SECS && r.idleStart != null) {
				r.away.push([r.idleStart, now])
				r.idleStart = undefined
				// Time away from the keyboard is the break. Every health clock
				// restarts here, so coming back to the desk is not met with "stand up
				// for a minute" — which is arithmetically right and obviously wrong.
				r.health = { ...r.health, backAt: now }
			}
			r.lastTick = now
			// With the API off, nothing may show an API error — including one saved
			// before it was switched off.
			if (noApi && r.lastError && API_NOISE.test(r.lastError)) r.lastError = undefined
		})
		// No usable API (no connection, or a role Zoho refuses): your own Zoho tab
		// is the source instead, on the same cadence the API sync would use — every
		// 5 minutes, or every tick while a punch is expected.
		const rt = await this.store.runtime()
		const day = await this.store.day(today)
		const apiUsable = !rt.roleBlocked && (await this.env.zoho.hasAuth())
		if (!apiUsable && !day.isOff && day.checkedOutAt == null) {
			const due = rt.awaiting != null ? 25_000 : 5 * MIN
			if (rt.lastSync == null || now - rt.lastSync >= due) {
				// Clock the attempt, not the answer: a read that never reports back
				// must not turn into an injection every minute.
				await this.store.updateRuntime((r) => void (r.lastSync = now))
				await this.env.ui.readZohoPage?.().catch(() => false)
			}
		}
		await this.noteUse(now)
		await this.closeYesterday(now)
		await this.announceMeetings(now)
		await this.askMeetingLog(now)
		await this.offerBlock(now)
		await this.askWeekReview(now)
		await this.healthNudge(now)
		await this.askLearning(now)
		await this.loopLearning(now)
		await this.backUp(now)
		await this.pollTeam(now)
		await this.pollBridge(now)
		await this.endFinishedFocus(now)
		await this.remindTasks(now)
		await this.keepRinging(now)
		await this.reconcile()
		const snap = await this.snapshot()
		const actions = decide(snap)
		for (const a of actions) {
			try {
				await this.run(a)
			} catch (e) {
				await this.store.updateRuntime((r) => void (r.lastError = errText(e)))
			}
		}
		await this.refreshBadge()
		return actions
	}

	async snapshot(): Promise<Snapshot> {
		const now = this.env.now()
		const today = istDate(now)
		const [settings, day, rt, lastEnd, hasZoho, pendingDays, entries, meetings] = await Promise.all([
			this.store.settings(),
			this.store.day(today),
			this.store.runtime(),
			this.store.lastSlotEnd(today),
			this.env.zoho.hasAuth(),
			this.store.pendingDays(addDays(today, -7), today),
			this.store.entries(today),
			this.store.meetings(),
		])
		const lastBreak = entries.filter((e) => e.kind === 'break').at(-1)?.slotEnd
		return {
			now,
			today,
			// A half day asks for half the hours. Telling someone at one o'clock
			// that they are four hours short of eight, on a day Zoho itself has
			// marked as half, is the app holding the answer and not reading it.
			settings: day.offKind === 'half' ? { ...settings, minHours: hoursFor('half', settings.minHours) } : settings,
			day,
			slotStart: day.checkedInAt != null ? Math.max(day.checkedInAt, lastEnd ?? 0) : null,
			loggedMinutes: entries.filter((e) => e.kind === 'work').reduce((n, e) => n + e.minutes, 0),
			idleSecs: await this.env.idleSecs(),
			flags: rt.flags.date === today ? rt.flags : emptyFlags(today),
			pending: rt.pending,
			snoozeUntil: rt.snoozeUntil,
			focusUntil: rt.focus?.endsAt,
			lastBreakAt: lastBreak ?? day.checkedInAt,
			meetings: meetingSlots(meetings, today),
			hasZoho,
			roleBlocked: rt.roleBlocked,
			awaitingZoho: rt.awaiting != null,
			lastSync: rt.lastSync,
			pendingDays: pendingDays.length,
		}
	}

	async run(a: Action): Promise<void> {
		const flags = (fn: (r: Runtime) => void) => this.store.updateRuntime(fn)
		switch (a.type) {
			case 'sync':
				await this.syncAttendance(this.today()).catch(() => undefined)
				return
			case 'checkin': {
				await flags((r) => void (r.flags.checkinSoftShown = true))
				await this.setPending({ kind: 'checkin', blocking: a.blocking, since: this.env.now() })
				if (a.blocking) {
					const s = await this.store.settings()
					await this.note('checkin', 'Check in to Zoho People', 'Your shift has started and you have not checked in yet.', true)
					// An alarm, not a note on the fridge: the first thing of the day is
					// the easiest to miss, especially straight after the laptop starts.
					if (s.alarmCheckIn && s.sound) this.env.ui.chime?.()
				}
				return
			}
			case 'notify': {
				await flags((r) => {
					if (a.kind === 'checkin') r.flags.checkinNotified = true
					else if (a.kind === 'wrapup') r.flags.wrapupNotified = true
					else if (a.kind === 'break') r.flags.breakNotified = true
					else r.flags.hoursDoneNotified = true
				})
				await this.note(a.kind, a.title, a.body, a.kind === 'wrapup')
				const s = await this.store.settings()
				if (a.kind === 'wrapup' && s.alarmCheckOut && s.sound) this.env.ui.chime?.()
				return
			}
			case 'prompt': {
				const s = await this.store.settings()
				// The card is forced and covers the page, which is right at 11am
				// and wrong while somebody is sharing their screen. Deferring
				// costs one slot; landing on a presentation costs the install.
				const bad = badMoment({ ...((await this.env.ui.moment?.()) ?? {}), focusing: !!(await this.store.runtime()).focus })
				if (bad) {
					await this.store.updateRuntime((r) => void (r.snoozeUntil = deferUntil(this.env.now())))
					return
				}
				await this.setPending({ kind: 'prompt', blocking: true, since: this.env.now() })
				// Worded from your own interval: a half-hourly reminder that says
				// "the last hour" is the extension disagreeing with itself.
				await this.note('prompt', 'What did you work on?', `Log the last ${s.promptInterval === 60 ? 'hour' : `${s.promptInterval} minutes`} to keep your timesheet complete.`, false)
				return
			}
			case 'wrapup': {
				await flags((r) => void (r.flags.wrapupBlocked = true))
				await this.setPending({ kind: 'wrapup', blocking: true, since: this.env.now() })
				const s = await this.store.settings()
				if (s.alarmCheckOut && s.sound) this.env.ui.chime?.()
				return
			}
			case 'scan':
				await flags((r) => void (r.flags.scanDone = true))
				await this.scanBest()
				return
			case 'lastcall': {
				await flags((r) => void (r.flags.lastCallTold = true))
				const s = await this.store.settings()
				// It rings, unlike every other evening nudge, because the whole
				// problem is that you have stopped looking at the screen. One click
				// tonight, or a regularisation form and a guess tomorrow.
				await this.setPending({ kind: 'wrapup', blocking: true, since: this.env.now() })
				await this.note('wrapup', 'Still checked in', 'Your shift ended hours ago. Close the day before Zoho records a missing check-out.', true)
				if (s.sound) this.env.ui.alarm?.(true)
				return
			}
			case 'catchup': {
				await flags((r) => void (r.flags.catchupNotified = true))
				const today = this.today()
				const days = await this.store.pendingDays(addDays(today, -7), today)
				if (days.length) {
					this.env.ui.notify('catchup', `Time logs pending for ${days.length} day${days.length > 1 ? 's' : ''}`, `${days.map(prettyDate).join(', ')}. Zoho may lock days older than 7.`, true)
				}
				return
			}
		}
	}

	/**
	 * Tasks you asked to be reminded about at a set time. The notification names
	 * the task, and the forced card follows you to whatever tab you are on, which
	 * is the point of setting a time in the first place.
	 */
	async remindTasks(now: number): Promise<void> {
		const due = dueReminders(await this.store.tasks(), now)
		if (!due.length) return
		// Never drop one because something else is on screen: leave it due and show
		// it on a later tick. Marking it told before it was shown is how a reminder
		// goes missing.
		const rt = await this.store.runtime()
		if (rt.pending) return
		const task = due[0]

		await this.store.saveTasks(
			(await this.store.tasks()).map((t) =>
				t.uid === task.uid
					? {
							...t,
							remindedAt: now,
							// A repeating one books its next slot as it fires.
							remindAt: t.repeatMinutes ? nextRepeat(t.remindAt ?? now, t.repeatMinutes, now) : t.remindAt,
						}
					: t,
			),
		)
		await this.store.updateRuntime((r) => void (r.reminderUrl = task.url))
		this.env.ui.notify('taskdue', task.title, task.url ? 'Click to open what you saved.' : 'You asked to be reminded now.', true)
		await this.setPending({ kind: 'remind', blocking: true, since: now, taskUid: task.uid })
		if ((await this.store.settings()).sound) this.env.ui.chime?.()
		this.env.ui.changed()
	}

	/**
	 * An alarm that chimes once is a notification. This one keeps chiming, and
	 * keeps the card in front of you, until you answer it.
	 */
	async keepRinging(now: number): Promise<void> {
		const rt = await this.store.runtime()
		const p = rt.pending
		// A meeting rings like a reminder does: it is the one thing on the list
		// that starts without you, so a single chime you happened to miss is the
		// same as no chime at all.
		if (p?.kind !== 'remind' && p?.kind !== 'meeting') return
		if (p.since === now) return // it has just rung
		// Not for ever: twenty minutes of ringing is an alarm clock nobody can
		// find. After that the card stays, silently.
		if (now - p.since > RING_FOR) return
		const s = await this.store.settings()
		// The alarm is already ringing for a meeting; a reminder gets its chime.
		if (s.sound && p.kind !== 'meeting') this.env.ui.chime?.()
		await this.env.ui.show(p)
		// Say it again every few minutes, in case the card is on another screen.
		if (now - p.since >= 3 * MIN && (now - p.since) % (3 * MIN) < MIN) {
			if (p.kind === 'meeting') await this.note(`meeting-${p.meetingId}`, p.title ?? 'Meeting', 'Still waiting on you.', true)
			else {
				const task = (await this.store.tasks()).find((t) => t.uid === p.taskUid)
				if (task) await this.note('taskdue', task.title, 'Still waiting on you.', true)
			}
		}
	}

	/**
	 * The end of a focus session is the one moment the whole block can be
	 * described accurately, so it chimes and asks — rather than letting the block
	 * dissolve into the next hour.
	 */
	/**
	 * A finished block, kept. Deep work you cannot count is deep work you stop
	 * believing you did — and the week's total is the only honest answer to
	 * "where did my week go".
	 */
	async recordFocus(session: { startedAt: number; endsAt: number; intent?: string; broke?: { what: string; at: number }[] }, now: number, finished: boolean): Promise<void> {
		const minutes = Math.max(1, Math.round((Math.min(now, session.endsAt) - session.startedAt) / MIN))
		// Anything under five minutes was a false start, not a block.
		if (minutes < 5) return
		await this.store.updateRuntime((r) => {
			// A quarter's worth is plenty to answer any question worth asking.
			// What broke the block travels with it: recorded at the time or not
			// at all, and useless once it is only in the live session.
			r.deep = [...(r.deep ?? []), { date: istDate(session.startedAt), minutes, finished, intent: session.intent, broke: session.broke }].slice(-400)
		})
	}

	async endFinishedFocus(now: number): Promise<void> {
		const rt = await this.store.runtime()
		if (!rt.focus || now < rt.focus.endsAt) return
		await this.recordFocus(rt.focus, now, true)
		const minutes = Math.round((rt.focus.endsAt - rt.focus.startedAt) / MIN)
		// Kept for the question that follows: it is the answer, most of the time.
		await this.store.updateRuntime((r) => {
			r.lastFocusIntent = r.focus?.intent
			r.focus = undefined
		})
		if ((await this.store.settings()).sound) this.env.ui.chime?.()
		this.env.ui.notify('focus', `${minutes} minutes done`, 'What did you get done? Log it while it is fresh.', true)
		// `manual`, because this card is owed by the block having ended, not by the
		// hourly clock — without it, reconcile drops it a moment later for a slot
		// that is not due yet, and the one question the block exists for is never
		// asked.
		if (!rt.pending) await this.setPending({ kind: 'prompt', blocking: true, manual: true, since: now })
		this.env.ui.changed()
	}

	/**
	 * A meeting you have every week does not need a task — it needs a nudge a few
	 * minutes before, once, on the days it actually happens.
	 */
	/**
	 * One question at the end of the day, and only one: what did you learn, what
	 * did you get wrong. Asked after the day's work is wrapped up, because that
	 * is the moment it is still fresh and nothing else is owed. A note written
	 * from anywhere answers it (see Commands.saveLearning).
	 */
	async askLearning(now: number): Promise<void> {
		const today = istDate(now)
		const [s, day, rt] = await Promise.all([this.store.settings(), this.store.day(today), this.store.runtime()])
		if (!s.learnPrompt || rt.flags.learnAsked) return
		if (day.isOff || !isWorkDay(today, s.workDays)) return
		// Already written something for today: the question is answered. Derived
		// rather than flagged, because the day's flags reset and a note does not.
		if ((await this.store.learnings()).some((l) => l.date === today)) return
		// Either the day is closed or the shift has ended: not before.
		const over = day.checkedOutAt != null || now >= atIst(today, s.shiftEnd)
		if (!over) return
		await this.store.updateRuntime((r) => void (r.flags.learnAsked = true))
		this.env.ui.notify('learn', 'Anything worth remembering from today?', 'One line about what you learned, or what you would not repeat.', false)
		this.env.ui.changed()
	}

	/**
	 * The loop: a journal nobody reads again is a diary. Once a week, if the same
	 * mistake has been written down more than once, say so by name — the point of
	 * writing it down is being told before it happens a third time.
	 */
	async loopLearning(now: number): Promise<void> {
		const s = await this.store.settings()
		if (!s.learnLoop) return
		const rt = await this.store.runtime()
		if (rt.loopedAt != null && now - rt.loopedAt < 7 * DAY) return
		const worst = repeats(await this.store.learnings(), now)[0]
		if (!worst) return
		await this.store.updateRuntime((r) => void (r.loopedAt = now))
		this.env.ui.notify('loop', `#${worst.tag} has come up ${worst.count} times`, 'Worth a minute before it happens again — your notes are in Learnings.', false)
		this.env.ui.changed()
	}

	/**
	 * The daily backup. Once a day, after the day is closed or by evening — and
	 * only when it is set up. A failure is recorded and shown in Settings rather
	 * than thrown at you: a backup is not worth interrupting work for, but a
	 * backup you think is running and is not would be worth knowing about.
	 */
	async backUp(now: number): Promise<void> {
		const s = await this.store.settings()
		// A team that has to be pushed by hand is a team board that is three days
		// stale by Wednesday. It rides the same once-a-day moment as the backup,
		// which is the moment the day is actually finished.
		await this.shareDaily(now).catch(() => undefined)
		if (!s.syncRepo.trim()) return
		const [rt, day] = await Promise.all([this.store.runtime(), this.store.day(istDate(now))])
		const due = backupDue({
			on: s.syncDaily,
			now,
			lastPushAt: rt.sync?.at,
			lastTryAt: rt.sync?.triedAt,
			dayClosed: day.checkedOutAt != null || day.timelogStatus === 'pushed',
			after: atIst(istDate(now), s.syncAfter),
		})
		if (!due) return
		// Stamped before the attempt, so a failure backs off instead of retrying
		// every minute for the rest of the evening.
		await this.store.updateRuntime((r) => void (r.sync = { ...r.sync, triedAt: now }))
		await this.env.ui.pushBackup?.().catch(() => undefined)
	}

	/**
	 * Share with the team, once a day, without anyone remembering to.
	 *
	 * Only what was already switched on, and only once the day is closed — the
	 * same rule the backup follows, for the same reason: a half-finished day on
	 * somebody else's board is worse than no day at all.
	 */
	async shareDaily(now: number): Promise<void> {
		const s = await this.store.settings()
		if (!s.teamRepo.trim()) return
		if (!s.shareHours && !s.shareWhat && !s.shareLearnings) return
		const [rt, day] = await Promise.all([this.store.runtime(), this.store.day(istDate(now))])
		const closed = day.checkedOutAt != null || day.timelogStatus === 'pushed'

		// Something changed recently: let the burst gather, then send one commit.
		// Closing the day sends at once, because that is the moment the day is
		// worth anybody reading.
		const soon = shareDue({ on: true, now, changedAt: rt.team?.changedAt, lastPushAt: rt.team?.at, lastTryAt: rt.team?.triedAt, dayClosed: closed })
		// And once a day regardless, so a day nobody touched still goes up.
		const daily = backupDue({ on: true, now, lastPushAt: rt.team?.at, lastTryAt: rt.team?.triedAt, dayClosed: closed, after: atIst(istDate(now), s.syncAfter) })
		if (!soon && !daily) return
		await this.store.updateRuntime((r) => void (r.team = { ...r.team, triedAt: now }))
		await this.env.ui.shareTeam?.().catch(() => undefined)
	}

	/**
	 * Read what the others pushed.
	 *
	 * Often while somebody is looking at the board, rarely when not — and cheap
	 * either way, because one request lists the folder and only the files whose
	 * sha moved are fetched.
	 */
	async pollTeam(now: number): Promise<void> {
		const s = await this.store.settings()
		if (!s.teamRepo.trim()) return
		const rt = await this.store.runtime()
		if (!pollDue({ now, lastPollAt: rt.team?.polledAt, watching: !!this.watching })) return
		await this.env.ui.pollTeam?.().catch(() => undefined)
	}

	/** Set while the team board is on screen, which is when a poll is worth more. */
	watching = false

	/**
	 * Read what the CLI wrote under bridge/, every fifteen minutes in the
	 * background (the Brain page asks every minute itself while it is open) —
	 * and an unchanged repository answers with a 304 that costs nothing.
	 */
	async pollBridge(now: number): Promise<void> {
		const s = await this.store.settings()
		if (!s.syncRepo.trim()) return
		const rt = await this.store.runtime()
		if (!pollDue({ now, lastPollAt: rt.bridge?.polledAt, watching: false })) return
		await this.env.ui.pollBridge?.().catch(() => undefined)
	}

	/**
	 * After a meeting that goes on the timesheet: did it happen? Asked once, and
	 * only when the time is not already covered by something you logged yourself.
	 */
	async askMeetingLog(now: number): Promise<void> {
		const today = istDate(now)
		const [list, entries, day] = await Promise.all([this.store.meetings(), this.store.entries(today), this.store.day(today)])
		if (day.isOff) return
		const covered = (from: number, to: number) => entries.some((e) => e.kind === 'work' && e.slotStart < to && e.slotEnd > from)

		// Writing a row needs no room on the screen, so it is not behind the
		// gate that decides whether a card may be shown — which was the bug:
		// a stand-up went unlogged on any day that happened to have a card up,
		// a snooze running, or a focus block going. It is also not held to the
		// four-hour window that asking is: opening the laptop in the afternoon
		// should still record the morning's meeting.
		const silent = dueToLog(list, now, covered, Number.POSITIVE_INFINITY).filter(logsItself)
		for (const m of silent) await this.logMeetingQuietly(m, now)
		if (silent.length) this.env.ui.changed()

		// Only the question needs room, and only it is time-limited.
		if (!(await this.roomForGentle(now))) return
		const due = dueToLog(list, now, covered).find((m) => !logsItself(m))
		if (!due) return
		const { from, to } = meetingSlot(due, today)
		await this.showGentle({
			kind: 'meeting',
			blocking: false,
			since: now,
			meetingId: due.id,
			title: due.name,
			body: `${istTime(from)}–${istTime(to)} · ${due.logMinutes} minutes`,
			logMinutes: due.logMinutes,
			until: to + 4 * 60 * 60_000,
		})
		this.env.ui.changed()
	}

	/**
	 * A recurring meeting, written onto the timesheet without a question.
	 *
	 * Marked `auto` so it is never mistaken for a line somebody wrote, and
	 * carrying the meeting's id so removing the row can un-log the meeting and
	 * let it be re-added if it did happen after all.
	 */
	private async logMeetingQuietly(m: Meeting, now: number): Promise<void> {
		const today = istDate(now)
		const { from } = meetingSlot(m, today)
		const minutes = Math.max(1, Math.round(m.logMinutes ?? 0))
		await this.store.addEntry({
			date: today,
			slotStart: from,
			slotEnd: from + minutes * MIN,
			text: (m.logText || m.name).trim(),
			jobId: m.jobId,
			minutes,
			kind: 'work',
			auto: true,
			meetingId: m.id,
		})
		const list = await this.store.meetings()
		await this.store.saveMeetings(list.map((x) => (x.id === m.id ? { ...x, loggedOn: today } : x)))
	}

	/**
	 * Eyes, water and posture. One card at a time, never during a focus session
	 * or a meeting, and never when you are away from the keyboard — the rules
	 * live in core/health.ts so "when is this annoying?" is testable.
	 */
	/**
	 * Days actually used, and things actually done for you. Counted here so the
	 * one time it asks for support can be justified by what it did rather than by
	 * how long it has been installed.
	 */
	async noteUse(now: number): Promise<void> {
		const today = istDate(now)
		await this.store.updateRuntime((r) => {
			const use = r.use ?? {}
			const days = use.days ?? []
			if (days[days.length - 1] !== today) r.use = { ...use, days: [...days, today].slice(-400) }
		})
	}

	async healthNudge(now: number): Promise<void> {
		const s = await this.store.settings()
		if (!s.eyeEvery && !s.moveEvery && !s.waterTarget && !s.posture && !s.breatheEvery) return
		const [rt, day, entries] = await Promise.all([this.store.runtime(), this.store.day(istDate(now)), this.store.entries(istDate(now))])
		// Breaks wait their turn behind anything else on the screen, and behind
		// each other: four in an hour is a colleague, eight is a nuisance.
		if (!(await this.roomForGentle(now))) return
		const today = istDate(now)
		const h = rt.health ?? {}
		const lastBreak = entries.filter((e) => e.kind === 'break').at(-1)?.slotEnd
		const owed = dueNudges(
			{ eyeEvery: s.eyeEvery, moveEvery: s.moveEvery, waterTarget: s.waterTarget, waterEvery: s.waterEvery, posture: s.posture, breatheEvery: s.breatheEvery },
			{
				now,
				atDeskSince: Math.max(lastBreak ?? 0, day.checkedInAt ?? now),
				backAt: rt.health?.backAt,
				lastEyes: h.lastEyes,
				lastMove: h.lastMove,
				lastWater: h.lastWater,
				lastPosture: h.lastPosture,
				lastBreathe: h.lastBreathe,
				water: h.waterDate === today ? (h.water ?? 0) : 0,
				busyUntil: rt.focus?.endsAt,
				checkedIn: day.checkedInAt != null,
				checkedOut: day.checkedOutAt != null,
				idleSecs: await this.env.idleSecs(),
			},
		)
		const due = owed[0]
		if (!due) return

		const water = h.waterDate === today ? (h.water ?? 0) : 0
		// One card for everything owed at this moment: an eye break and standing
		// up are the same trip away from the desk.
		const card = mergeNudges(owed, water, s.waterTarget, h.said)
		if (!card) return
		// Anything you asked to be reminded of at the next break, said once.
		const note = noteForNext((h.notes ?? []) as HealthNote[], now)
		await this.store.updateRuntime((r) => {
			const said: Partial<Record<NudgeKind, number>> = { ...r.health?.said }
			let stamps = {}
			for (const k of card.kinds) {
				said[k] = (said[k] ?? 0) + 1
				stamps = { ...stamps, ...{ eyes: { lastEyes: now }, move: { lastMove: now }, water: { lastWater: now }, posture: { lastPosture: now }, breathe: { lastBreathe: now } }[k] }
			}
			r.health = { ...r.health, ...stamps, said }
		})
		if (note) {
			await this.store.updateRuntime((r) => {
				r.health = { ...r.health, notes: (r.health?.notes ?? []).map((n) => (n.id === note.id ? { ...n, shownAt: now } : n)) }
			})
		}
		await this.showGentle({
			kind: 'health',
			blocking: false,
			since: now,
			nudge: due,
			alsoNudges: card.also,
			title: card.title,
			body: card.body,
			seconds: card.seconds,
			note: note?.text,
			until: now + 10 * MIN,
		})
	}

	/**
	 * The one line of a notification worth reading: what you did, in the words
	 * you used. Set by Commands, which is where the standup is assembled — the
	 * engine cannot reach it, and should not have to.
	 */
	gist?: (meetingId: string) => Promise<string>

	private meetingGist(id: string): Promise<string> {
		return this.gist ? this.gist(id) : Promise.resolve('')
	}

	/**
	 * A day that was never closed, caught the next time WorkPulse runs at all.
	 *
	 * This is the one the evening alarm cannot reach: the lid went down at seven
	 * and nothing was running to ring. So it is asked first thing instead, with
	 * the time you actually stopped already worked out — because by the time
	 * anyone opens a regularisation form, "what time did you leave on Tuesday"
	 * is a guess.
	 */
	async closeYesterday(now: number): Promise<void> {
		const today = istDate(now)
		const rt = await this.store.runtime()
		if (rt.pending) return
		const open = await this.openDays(today)
		const date = open[0]
		if (!date) return
		const [day, entries, s] = await Promise.all([this.store.day(date), this.store.entries(date), this.store.settings()])
		const left = leftAt({
			checkedInAt: day.checkedInAt!,
			away: rt.away.filter(([a]) => istDate(a) === date),
			lastEntryEnd: entries.at(-1)?.slotEnd,
			lastTick: rt.lastTick != null && istDate(rt.lastTick) === date ? rt.lastTick : undefined,
			shiftEnd: atIst(date, s.shiftEnd),
			now,
		})
		await this.setPending({
			kind: 'closeout',
			blocking: true,
			since: now,
			date,
			leftAt: left.at,
			leftWhy: left.why,
			leftGuessed: left.guessed,
		})
		if (s.sound && s.alarmCheckOut) this.env.ui.alarm?.(true)
		this.env.ui.changed()
	}

	/** Working days before today that were checked in and never checked out. */
	async openDays(today: string, back = 7): Promise<string[]> {
		const s = await this.store.settings()
		const out: string[] = []
		for (let i = 1; i <= back; i++) {
			const date = addDays(today, -i)
			if (!isWorkDay(date, s.workDays)) continue
			const day = await this.store.day(date)
			if (needsClosing(day)) out.push(date)
		}
		return out
	}

	/**
	 * A block you booked, offered when it comes round.
	 *
	 * Offered, never started: a block that begins without you is a timer running
	 * in a tab you are not looking at. One notification, once, at the minute it
	 * was supposed to start — which is the whole trick.
	 */
	/**
	 * The five minutes on Friday.
	 *
	 * In the last working hour of the last working day — not Monday, when a
	 * review of a week you cannot remember is a form; not the weekend, when
	 * nobody is there. It is the only moment the week is both fresh and still
	 * possible to act on.
	 */
	async askWeekReview(now: number): Promise<void> {
		const s = await this.store.settings()
		const today = istDate(now)
		const rt = await this.store.runtime()
		// A quiet toast, not a card: it does not need the screen to itself, and
		// waiting for an empty one would mean it almost never arrives on the only
		// afternoon it is any use.
		if (rt.focus) return
		const day = await this.store.day(today)
		// The last working day of your week, whichever day that is.
		const isLast = isWorkDay(today, s.workDays) && !isWorkDay(addDays(today, 1), s.workDays)
		if (
			!reviewDue({
				now,
				shiftEnd: atIst(today, s.shiftEnd),
				isLastWorkday: isLast && !day.isOff,
				doneThisWeek: rt.flags.weekReviewed === today,
				checkedIn: day.checkedInAt != null,
			})
		) {
			return
		}
		await this.store.updateRuntime((r) => void (r.flags.weekReviewed = today))
		// Gentle on purpose: a week in review is worth five minutes and is not
		// worth interrupting the last thing you are trying to finish.
		await this.note('weekreview', 'Five minutes on the week', 'What it went on, what is waiting, and one line for next week.', false)
		this.env.ui.changed()
	}

	async offerBlock(now: number): Promise<void> {
		const s = await this.store.settings()
		if (!s.blocks.length) return
		const rt = await this.store.runtime()
		if (rt.focus || rt.pending) return
		const today = istDate(now)
		const day = await this.store.day(today)
		if (day.isOff || day.checkedInAt == null || day.checkedOutAt != null) return

		const due = dueBlock(s.blocks, now, (time) => atIst(today, time), today, istWeekday(now))
		if (!due) return
		await this.store.saveSettings({ blocks: s.blocks.map((b) => (b.id === due.id ? { ...b, offeredOn: today } : b)) })
		await this.note('block', `${due.minutes} minutes, booked`, due.intent ? `${due.intent} — click to start it.` : 'Click to start the block.', true)
		this.env.ui.changed()
	}

	async announceMeetings(now: number): Promise<void> {
		const list = await this.store.meetings()
		const due = dueMeetings(list, now)
		if (!due.length) return
		const today = istDate(now)
		await this.store.saveMeetings(list.map((m) => (due.some((d) => d.id === m.id) ? { ...m, notifiedOn: today } : m)))
		const s = await this.store.settings()
		for (const m of due) {
			// The toast carries the gist too: a notification that only says a
			// meeting is starting is a calendar, and you already have one.
			const gist = await this.meetingGist(m.id).catch(() => '')
			await this.note(`meeting-${m.id}`, m.name, `${meetingWhen(m, now)} · ${meetingTimeOn(m, today) ?? m.time}${gist ? `\n${gist}` : ''}`, true)
		}
		// A meeting starts without you, so it rings rather than pings: the sound
		// keeps going until the card is answered (see clearPending).
		if (s.sound) this.env.ui.alarm?.(true)
		// A notification is a toast behind whatever you are looking at, and the
		// operating system may hold it back entirely. A meeting gets the card as
		// well — unless something is already owed, which is not worth pushing off.
		const rt = await this.store.runtime()
		if (!rt.pending) {
			const first = due[0]
			// The time it is actually at today, which is not its usual one when it
			// has been moved — and the card expires against the same clock, or a
			// moved meeting's card is stale before it is shown.
			const startsAt = meetingTimeOn(first, today) ?? first.time
			await this.setPending({
				kind: 'meeting',
				blocking: false,
				since: now,
				meetingId: first.id,
				title: first.name,
				body: `${meetingWhen(first, now)} · ${startsAt}${due.length > 1 ? ` · and ${due.length - 1} more` : ''}`,
				until: atIst(today, startsAt) + 20 * MIN,
			})
		}
		this.env.ui.changed()
	}

	/** A break resets the stretch, so the afternoon is watched like the morning. */
	async noteBreak(): Promise<void> {
		await this.store.updateRuntime((r) => void (r.flags.breakNotified = false))
		await this.arrived()
	}

	/**
	 * You have just arrived at the desk — Chrome started, you checked in, or you
	 * came back from a break. Nothing about your eyes, your back or your water is
	 * owed in the first minutes of that: the break it would be asking for is the
	 * one you have just had.
	 */
	async arrived(): Promise<void> {
		await this.store.updateRuntime((r) => void (r.health = { ...r.health, backAt: this.env.now() }))
	}

	/**
	 * A notification, unless the card that owns it is already on the screen.
	 *
	 * `setPending` clears the toast that led up to a card, but a caller that
	 * notified *after* showing the card put it straight back — which is the
	 * "two different log reminders" people see: a sticky toast saying one thing
	 * and a card saying the same thing, each needing its own dismissal. The
	 * guard lives here so no call site has to remember the order.
	 */
	private async note(id: string, title: string, message: string, sticky: boolean): Promise<void> {
		const pending = (await this.store.runtime()).pending
		if (pending && (NOTES_FOR[pending.kind] ?? []).includes(id)) return
		this.env.ui.notify(id, title, message, sticky)
	}

	/**
	 * Is there room for a card nobody asked for? Breaks, meeting nudges and
	 * learning prompts all pass through here, so they take their turn instead of
	 * arriving in a stack.
	 */
	private async roomForGentle(now: number): Promise<boolean> {
		const rt = await this.store.runtime()
		return !rt.pending && mayInterrupt({ now, ...rt.gentle })
	}

	/** Shows a gentle card and counts it against the hour's ceiling. */
	private async showGentle(p: Pending): Promise<void> {
		const rt = await this.store.runtime()
		const next = countInterrupt({ now: p.since, ...rt.gentle })
		await this.store.updateRuntime((r) => void (r.gentle = next))
		await this.setPending(p)
	}

	/**
	 * Every card starts the quiet window, not just the gentle ones.
	 *
	 * Logging the hour is an interruption you answered a minute ago; a glass of
	 * water on top of it is the app talking over itself. Only gentle cards spend
	 * the hour's budget, though — otherwise a day of hourly prompts would mean
	 * no break ever came.
	 */
	private stampInterrupt(at: number) {
		return this.store.updateRuntime((r) => void (r.gentle = { ...r.gentle, at }))
	}

	async setPending(p: Pending): Promise<void> {
		await this.store.updateRuntime((r) => void (r.pending = p))
		await this.stampInterrupt(p.since)
		// The notification that led up to this card is not wanted beside it: a
		// sticky toast, an in-page card and a window all saying the same thing is
		// what people describe as "it popped up three times".
		for (const id of NOTES_FOR[p.kind] ?? []) this.env.ui.clearNote?.(id)
		await this.env.ui.show(p)
		this.env.ui.changed()
		await this.refreshBadge()
	}

	async clearPending(): Promise<void> {
		const was = (await this.store.runtime()).pending
		// Answering anything stops whatever is ringing.
		this.env.ui.alarm?.(false)
		await this.store.updateRuntime((r) => void (r.pending = null))
		// And the toast that was about it. A sticky notification outlives the card
		// it came with, so the answer you just gave is followed by the same
		// reminder sitting there — which reads as the reminder coming back.
		if (was) for (const id of NOTES_FOR[was.kind] ?? []) this.env.ui.clearNote?.(id)
		await this.env.ui.hide()
		this.env.ui.changed()
		await this.refreshBadge()
	}

	/** Drops forced UI that is no longer owed, and re-presents what still is. */
	async reconcile(): Promise<void> {
		const rt = await this.store.runtime()
		const p = rt.pending
		if (!p) return
		if (await this.owed(p)) await this.env.ui.show(p)
		else await this.clearPending()
	}

	/**
	 * Is this reminder still owed? Read from what has actually been logged, not
	 * from when the card was queued — the hour may have been logged from the
	 * dashboard, or the day checked out, while the card sat behind a snooze.
	 */
	async owed(p: Pending): Promise<boolean> {
		const today = this.today()
		const day = await this.store.day(today)
		if (p.kind === 'remind') return true
		// A meeting card stands until it is answered or the meeting is well under
		// way; it is never owed the next morning.
		if (p.kind === 'meeting' || p.kind === 'health') return p.until == null || this.env.now() < p.until
		if (p.kind === 'checkin') return day.checkedInAt == null && !day.isOff
		// An open day is owed until it is closed — and it is a different day from
		// this one, so today's state says nothing about it.
		if (p.kind === 'closeout') return p.date != null && needsClosing(await this.store.day(p.date))
		if (p.kind === 'wrapup') return day.timelogStatus === 'pending' && !day.isOff
		const settings = await this.store.settings()
		const entries = await this.store.entries(today)
		return promptOwed({
			isOff: day.isOff,
			checkedInAt: day.checkedInAt,
			checkedOutAt: day.checkedOutAt,
			slotEnd: await this.store.lastSlotEnd(today),
			now: this.env.now(),
			shiftEnd: atIst(today, settings.shiftEnd),
			intervalMinutes: settings.promptInterval,
			manual: p.manual,
			loggedMinutes: entries.filter((e) => e.kind === 'work').reduce((n, e) => n + e.minutes, 0),
			minHours: settings.minHours,
		})
	}

	/**
	 * Reads Zoho for the day and fills check-in/out times it shows. Only
	 * broadcasts when something actually changed: open pages reload on every
	 * broadcast and `review()` syncs, so an unconditional one loops.
	 */
	async syncAttendance(date: string) {
		const now = this.env.now()
		try {
			const a = await this.env.zoho.attendance(date)
			const day = await this.store.day(date)
			const fillIn = a.checkedIn && day.checkedInAt == null
			const fillOut = a.checkedOut && day.checkedOutAt == null
			let changed = fillIn || fillOut
			if (fillIn) await this.store.updateDay(date, { checkedInAt: parseZohoDateTime(a.firstIn ?? '') ?? now })
			if (fillOut) await this.store.updateDay(date, { checkedOutAt: parseZohoDateTime(a.lastOut ?? '') ?? now })
			await this.store.updateRuntime((r) => {
				r.lastSync = now
				if (r.lastError != null) changed = true
				r.lastError = undefined
				if ((r.awaiting === 'in' && a.checkedIn) || (r.awaiting === 'out' && a.checkedOut)) {
					r.awaiting = undefined
					changed = true
				}
			})
			await this.reconcile()
			if (changed) this.env.ui.changed()
			return a
		} catch (e) {
			const blocked = e instanceof ZohoError && e.isRoleBlocked
			await this.store.updateRuntime((r) => {
				r.lastSync = now
				// Nothing for you to fix and nothing to show: the page path takes over.
				r.lastError = blocked ? undefined : errText(e)
				if (blocked) r.roleBlocked = true
			})
			throw e
		}
	}

	/** Zoho's report when it can be read, WorkPulse's own record otherwise. */
	async scanBest(): Promise<number> {
		const rt = await this.store.runtime()
		const apiUsable = !rt.roleBlocked && (await this.env.zoho.hasAuth())
		if (!apiUsable) return this.scanLocal()
		return this.scan().catch(() => this.scanLocal())
	}

	/**
	 * Regularisation from WorkPulse's own record, for when Zoho's report is out
	 * of reach. Only covers days WorkPulse saw, so it is a floor, not a ceiling.
	 */
	async scanLocal(): Promise<number> {
		const now = this.env.now()
		const today = istDate(now)
		const s = await this.store.settings()
		const [from, to] = scanRange(today)
		const found: { date: string; kind: IssueKind; detail: string }[] = []
		for (let d = from; d <= to; d = addDays(d, 1)) {
			const [day, entries] = await Promise.all([this.store.day(d), this.store.entries(d)])
			const logged = entries.filter((e) => e.kind === 'work').reduce((a, e) => a + e.minutes, 0)
			if (day.checkedInAt == null && logged === 0) continue // a day WorkPulse never saw
			const c = classifyLocal(day, logged, s.minHours, s.workDays, istTime)
			if (c) found.push({ date: d, ...c })
		}
		await this.store.applyScan(found, from, to, now)
		return this.afterScan(today)
	}

	/** Regularisation scan: month report → three rules → issues, reminder. */
	async scan(): Promise<number> {
		const now = this.env.now()
		const today = istDate(now)
		const s = await this.store.settings()
		const [from, to] = scanRange(today)
		const days = await this.env.zoho.userReport(s.email, from, to)
		const found = days.flatMap((d) => {
			// A day Zoho itself calls a holiday, a week off or approved leave is not
			// a day to regularise. It used to raise "marked absent with no leave or
			// holiday" against a leave Zoho had approved three weeks earlier.
			if (isOffKind(dayKind(d.status))) return []
			const c = classify(d, hoursFor(dayKind(d.status), s.minHours), s.workDays)
			return c ? [{ date: d.date, ...c }] : []
		})
		await this.keepReport(days, today)
		await this.store.applyScan(found, from, to, now)
		return this.afterScan(today)
	}

	/**
	 * Zoho's report already carries the punches and the hours for every day it
	 * covers — throwing those away and keeping only the problems left the last
	 * few months blank. Blanks are filled, never overwritten: what you recorded
	 * here wins, because you were there.
	 */
	async keepReport(days: { date: string; status?: string; firstIn: string; lastOut: string; totalHours: string }[], today: string): Promise<number> {
		let filled = 0
		for (const d of days) {
			if (!d.date) continue
			// A holiday or approved leave is known from the same report, and today
			// is exactly when knowing it matters: the day goes quiet rather than
			// asking you to check in on Diwali. So this one field is taken for
			// today too, where the punches are left to the live sync.
			const kind = dayKind(d.status ?? '')
			if (kind !== 'work') {
				const day = await this.store.day(d.date)
				if (day.offKind !== kind) await this.store.updateDay(d.date, { offKind: kind, isOff: day.offTold ? day.isOff : isOffKind(kind), offTold: day.offTold })
			}
			// Today is kept live by the sync; a report is yesterday's news for it.
			if (d.date >= today) continue
			const day = await this.store.day(d.date)
			const patch: Partial<Day> = {}
			const inAt = parseZohoDateTime(d.firstIn) ?? timeOn(d.date, d.firstIn)
			const outAt = parseZohoDateTime(d.lastOut) ?? timeOn(d.date, d.lastOut)
			if (day.checkedInAt == null && inAt != null) patch.checkedInAt = inAt
			if (day.checkedOutAt == null && outAt != null) patch.checkedOutAt = outAt
			const minutes = Math.round(hoursFromHHMM(d.totalHours) * 60)
			if (minutes > 0 && day.zohoMinutes !== minutes) patch.zohoMinutes = minutes
			if (Object.keys(patch).length) {
				await this.store.updateDay(d.date, patch)
				filled++
			}
		}
		return filled
	}

	/** Tells you what the scan found, loudly near month end when payroll closes. */
	private async afterScan(today: string): Promise<number> {
		const open = await this.store.openIssues()
		if (open.length) {
			const list = open.map((i) => `${prettyDate(i.date).slice(4)} (${ISSUE_LABEL[i.kind]})`).join(', ')
			const nearMonthEnd = isNearMonthEnd(today)
			this.env.ui.notify('issues', `${open.length} day${open.length > 1 ? 's' : ''} need regularisation`, list, nearMonthEnd)
			if (nearMonthEnd) await this.env.ui.openDashboard('issues')
		}
		this.env.ui.changed()
		await this.refreshBadge()
		return open.length
	}

	/**
	 * The toolbar icon is the only part of WorkPulse most people see for most of
	 * the day, and it used to be blank for most of it. Now it carries the one
	 * number that matters: how much of today is still unaccounted for. It grows
	 * while it is ignored and turns into a tick when it is not — which is the
	 * whole habit, in sixteen pixels.
	 */
	async refreshBadge(): Promise<void> {
		const now = this.env.now()
		const today = istDate(now)
		const [rt, day, s, issues, entries, pending] = await Promise.all([
			this.store.runtime(),
			this.store.day(today),
			this.store.settings(),
			this.store.openIssues(),
			this.store.entries(today),
			this.store.pendingDays(addDays(today, -LOCK_AFTER_DAYS), addDays(today, -1)),
		])
		const logged = entries.filter((e) => e.kind === 'work').reduce((n, e) => n + e.minutes, 0)
		const expected = day.checkedInAt == null ? 0 : hoursFor(day.offKind === 'half' ? 'half' : 'work', s.minHours) * 60
		const b = badgeFor({
			focusLeft: rt.focus ? Math.max(0, Math.round((rt.focus.endsAt - now) / MIN)) : undefined,
			pending: rt.pending?.kind,
			workday: s.workDays.includes(istWeekday(now)) && !day.isOff,
			checkedIn: day.checkedInAt != null,
			gapMinutes: Math.max(0, expected - logged),
			issues: issues.length,
			owed: pending.length,
		})
		this.env.ui.badge(b.text, b.colour)
	}
}

export function errText(e: unknown): string {
	return e instanceof Error ? e.message : String(e)
}

function isNearMonthEnd(date: string): boolean {
	const [y, m, d] = date.split('-').map(Number)
	const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
	return d >= daysInMonth - 2
}

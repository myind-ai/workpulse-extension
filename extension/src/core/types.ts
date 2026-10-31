// Shared data model. Mirrors the desktop app's SQLite tables (src-tauri/src/db.rs)
// so the phase 3 bridge can sync records by `uid`. Instants are epoch ms.

import type { BridgeEntry } from './bridge'
import type { Release } from './update'
import type { NudgeKind } from './health'
import type { Tier } from './licence'

export type ZohoMode = 'reminder' | 'timelogs' | 'full'
export type DataCenter = 'in' | 'com' | 'eu' | 'com.au'
/** How WorkPulse decides when to ask about an unlogged stretch. */
export type PromptCadence = 'hourly' | 'interval' | 'smart'

export interface Settings {
	shiftStart: string // "09:00" IST
	shiftEnd: string // "18:30" IST
	graceMinutes: number
	minHours: number
	promptInterval: number // minutes
	promptCadence: PromptCadence
	workDays: number[] // 1 = Monday … 7 = Sunday
	email: string
	defaultJobId: string
	zohoMode: ZohoMode
	dataCenter: DataCenter
	attendanceUrl: string // the Zoho page that reminders open
	billingStatus: 'billable' | 'non-billable'
	/** Send a row's real start and end (fromTime/toTime) when its hours are one unbroken stretch; hours otherwise. */
	timelogTimes: boolean
	/** Minutes after shift end before the wrap-up reminder is forced. */
	wrapupDelay: number
	oauthClientId: string // Zoho "Client-based application" for Sign in with Zoho
	scopes: string
	/** Play a chime with forced reminders. A silent reminder is easy to miss. */
	sound: boolean
	/** Ask once at the end of the day what you learned or got wrong. */
	learnPrompt: boolean
	/** Say so when a mistake keeps coming back. Once a week, at most. */
	learnLoop: boolean
	/** On a ticket, pull request or staging page, say what the Brain has for it. Once per tab per page. */
	brainOnPages: boolean
	/** Ask GitHub once a day whether a newer WorkPulse is out (zip installs only; the Web Store updates itself). */
	updateCheck: boolean
	/** Ring, not just show, when the check-in is overdue — once a day. */
	alarmCheckIn: boolean
	/** Ring at the end of the shift, so the day gets closed. */
	alarmCheckOut: boolean
	/** Hours at the desk before suggesting a break. 0 turns it off. */
	breakAfterHours: number
	/** Minutes between eye breaks — the 20-20-20 rule. 0 turns it off. */
	eyeEvery: number
	/** Minutes at the desk before being asked to stand up. 0 turns it off. */
	moveEvery: number
	/** Glasses of water a day, and how often to ask. 0 turns it off. */
	waterTarget: number
	waterEvery: number
	/** The occasional "sit back, shoulders down". */
	posture: boolean
	/** Minutes between a minute of slow breathing. 0 is off. */
	breatheEvery: number
	/** Ticket prefixes your teams use: PAY, LEAP, SALESPRO. Empty accepts any. */
	ticketPrefixes: string[]
	/** `owner/repo` to back up to. Empty turns the whole thing off. */
	syncRepo: string
	/** Branch to write to. Empty uses the repository's default. */
	syncBranch: string
	/** Folder inside the repository. */
	syncPath: string
	/** Back up once a day on its own, as well as on demand. */
	syncDaily: boolean
	/** When to back up if the day was never closed. */
	syncAfter: string
	/** Sites a focus block should quietly object to. Empty uses the usual suspects. */
	strayHosts: string[]
	/** Blocks booked in advance: deep work on the calendar rather than on willpower. */
	blocks: { id: string; time: string; minutes: number; days: number[]; intent?: string; enabled: boolean; offeredOn?: string }[]
	/** Your own zone, for converting a time someone else wrote. */
	myZone: string
	/** The other zones to show a converted time in — where your team sits. */
	otherZones: string[]
	/**
	 * The shared repository for a team, and what you let the others see. Empty
	 * repo means solo, which is the default and stays the default: nothing is
	 * shared by turning a team on, only by turning each of these on.
	 */
	teamRepo: string
	teamBranch: string
	teamPath: string
	teamMember: string
	shareHours: boolean
	shareWhat: boolean
	shareLearnings: boolean
	/** Notes left on a page, kept as issues in the shared repository. */
	pageNotes: boolean
	/**
	 * Put the screenshots in the backup too.
	 *
	 * On, because a note whose picture did not survive the restore is half a
	 * note. Forty of them at a few hundred kilobytes each is a handful of
	 * megabytes, written once and never rewritten — the name carries the id, so
	 * a picture is never a changed file.
	 */
	backupShots: boolean
	/**
	 * Put the recordings in the backup too.
	 *
	 * Off, unlike the screenshots: a clip is twenty times the size of a picture,
	 * and a repository nobody can clone is a backup nobody has.
	 */
	backupClips: boolean
	/**
	 * Pro, if you chose to pay for it.
	 *
	 * Never gates the daily loop, and never blocks a feature that runs on this
	 * machine — see core/licence.ts for the one line this draws.
	 */
	/**
	 * Where the model runs, when you have asked for an AI feature. The key
	 * itself is not here — see `Store.llmKey`: settings are exported, shown and
	 * backed up, and a key must be in none of those.
	 */
	llmProvider: string
	llmModel: string
	/** Overrides the provider's own address; the whole address for `custom`. */
	llmBaseUrl: string
	licence: Tier
	/** Sent with a served request. Validated on our side, never here. */
	licenceKey: string
}

export const READ_SCOPES =
	'ZOHOPEOPLE.attendance.READ,ZOHOPEOPLE.timetracker.READ,ZOHOPEOPLE.forms.READ,ZOHOPEOPLE.leave.READ'

/** Scopes requested when signing in, following the rollout stage of each mode. */
export function scopesFor(mode: ZohoMode): string {
	if (mode === 'timelogs') return `${READ_SCOPES},ZOHOPEOPLE.timetracker.CREATE`
	if (mode === 'full') return 'ZOHOPEOPLE.attendance.ALL,ZOHOPEOPLE.timetracker.ALL,ZOHOPEOPLE.forms.READ,ZOHOPEOPLE.leave.READ'
	return READ_SCOPES
}

export const DEFAULT_SETTINGS: Settings = {
	shiftStart: '09:00',
	shiftEnd: '18:30',
	graceMinutes: 15,
	minHours: 8,
	promptInterval: 60,
	// Existing installs have always used this value as their cadence; keep that
	// behaviour after adding the three explicit choices.
	promptCadence: 'interval',
	workDays: [1, 2, 3, 4, 5],
	email: '',
	defaultJobId: '',
	zohoMode: 'reminder',
	dataCenter: 'in',
	attendanceUrl: 'https://people.zoho.in/',
	billingStatus: 'non-billable',
	timelogTimes: true,
	wrapupDelay: 30,
	oauthClientId: '',
	scopes: READ_SCOPES,
	sound: true,
	learnPrompt: true,
	learnLoop: true,
	brainOnPages: true,
	updateCheck: true,
	alarmCheckIn: true,
	alarmCheckOut: true,
	breakAfterHours: 3,
	eyeEvery: 0,
	moveEvery: 0,
	waterTarget: 0,
	waterEvery: 45,
	posture: false,
	breatheEvery: 0,
	ticketPrefixes: [],
	syncRepo: '',
	// The CLI's default too, so a new install and `wp-brain setup` agree with nothing typed. Saved settings
	// always carry the key (it is as old as syncRepo), so this reaches fresh installs only.
	syncBranch: 'brain',
	syncPath: 'workpulse',
	syncDaily: true,
	syncAfter: '19:00',
	strayHosts: [],
	blocks: [],
	myZone: '',
	otherZones: [],
	teamRepo: '',
	teamBranch: '',
	teamPath: 'team',
	teamMember: '',
	shareHours: false,
	shareWhat: false,
	shareLearnings: false,
	pageNotes: false,
	backupShots: true,
	backupClips: false,
	llmProvider: '',
	llmModel: '',
	llmBaseUrl: '',
	licence: 'free',
	licenceKey: '',
}

export type TimelogStatus = 'pending' | 'pushed' | 'failed' | 'skipped'

export interface Day {
	/** What Zoho calls this day: a holiday, a week off, approved leave, a half day. */
	offKind?: 'weekend' | 'holiday' | 'leave' | 'half'
	/** You said it was a working day after all, so Zoho's label does not win again. */
	offTold?: boolean
	date: string // YYYY-MM-DD (IST)
	/**
	 * Minutes Zoho itself says you worked that day, from its own report. Fills
	 * the months before WorkPulse was installed, and the days it never saw.
	 */
	zohoMinutes?: number
	checkedInAt?: number
	checkedOutAt?: number
	timelogStatus: TimelogStatus
	isOff: boolean
}

export type EntryKind = 'work' | 'break' | 'skipped'

export interface Entry {
	uid: string
	date: string
	slotStart: number
	slotEnd: number
	text: string
	jobId?: string
	taskUid?: string
	minutes: number
	kind: EntryKind
	synced: boolean
	/**
	 * Added by WorkPulse rather than written by you — today, only a recurring
	 * meeting. Marked wherever it appears, because a line you did not write
	 * must never be indistinguishable from one you did.
	 */
	auto?: boolean
	/** The meeting it came from, so removing the row un-logs that meeting too. */
	meetingId?: string
	/** Idempotency key for a work interval imported from Claude Code. */
	bridgeWorklogId?: string
}

export type IssueKind = 'absent' | 'missing_checkout' | 'short_hours'

export interface Issue {
	date: string
	kind: IssueKind
	detail: string
	firstSeen: number
	resolvedAt?: number
}

export interface Job {
	id: string
	name: string
	project: string
}

export type TaskStatus = 'todo' | 'doing' | 'done'
/** Drives the colour, the sort order, and nothing else. */
export type Priority = 'high' | 'normal' | 'low'

export interface Task {
	uid: string
	title: string
	key?: string // external key such as a Jira issue "PAY-231"
	jobId?: string
	status: TaskStatus
	createdAt: number
	spentMinutes: number
	/** Last time you were asked "did you do this?" — it waits an interval before asking again. */
	askedAt?: number
	priority?: Priority
	/** Waiting on someone else. Says so in the standup instead of under Today. */
	blocked?: boolean
	/** Minutes you thought it would take, for planned against actual. */
	estimateMinutes?: number
	/** Small enough for the cleanup block — ten minutes, not a ticket. */
	quick?: boolean
	/** Remind me about this at a set time. */
	remindAt?: number
	remindedAt?: number
	/** Something worth keeping from another tab: the page it came from. */
	url?: string
	/** A note is a thing to keep, not a thing to do: it is never nagged about. */
	kind?: 'task' | 'note'
	/** Minutes between repeats — water, posture, a tablet. 0 or absent means once. */
	repeatMinutes?: number
	/** When you finished it, so a day can show what it actually got done. */
	doneAt?: number
}

export interface Timer {
	taskUid: string
	startedAt: number
}

export type PendingKind = 'checkin' | 'prompt' | 'wrapup' | 'remind' | 'meeting' | 'health' | 'closeout' | 'weekreview'

/** The forced UI currently owed to the user, if any. */
export interface Pending {
	kind: PendingKind
	blocking: boolean
	since: number
	/** Opened by "Log now" rather than the schedule; can be cancelled. */
	manual?: boolean
	/** For a 'remind': which saved item it is about. */
	taskUid?: string
	/** For a 'meeting': which one, what to say, and when it stops mattering. */
	meetingId?: string
	/** Set when the card is asking whether it happened, rather than nudging. */
	logMinutes?: number
	/** For a 'health' card: which nudge, and how long the countdown runs. */
	nudge?: NudgeKind
	/** The others that came due at the same moment — one card, not three. */
	alsoNudges?: { kind: NudgeKind; text: string }[]
	seconds?: number
	/** A note you asked to be reminded of at the next break. */
	note?: string
	/** For a 'closeout' card: the day that was never closed, and when you stopped. */
	date?: string
	leftAt?: number
	leftWhy?: string
	leftGuessed?: boolean
	title?: string
	body?: string
	until?: number
}

export interface DayFlags {
	date: string
	checkinSoftShown: boolean
	checkinNotified: boolean
	wrapupNotified: boolean
	wrapupBlocked: boolean
	scanDone: boolean
	catchupNotified: boolean
	/** "Your 8 hours are done" — told once a day. */
	hoursDoneNotified: boolean
	/** A break was suggested after a long unbroken stretch. */
	breakNotified: boolean
	/** The end-of-day "what did you learn?" nudge has been made today. */
	learnAsked: boolean
	/** The last call before an open day becomes a regularisation. */
	lastCallTold?: boolean
	/** The check-out alarm is ringing: from the end of the working day until check-out. */
	checkoutRinging?: boolean
	/** The check-out card was raised for it — once, so it never follows you around. */
	checkoutCardShown?: boolean
	/** "Working late" was pressed: the check-out alarm is quiet for the rest of today. */
	workingLate?: boolean
	/** The date the week was reviewed, so the Friday card comes once. */
	weekReviewed?: string
}

export const emptyFlags = (date: string): DayFlags => ({
	date,
	checkinSoftShown: false,
	checkinNotified: false,
	wrapupNotified: false,
	wrapupBlocked: false,
	scanDone: false,
	catchupNotified: false,
	hoursDoneNotified: false,
	breakNotified: false,
	learnAsked: false,
})

/** Engine state that must survive the MV3 service worker being stopped. */
export interface Runtime {
	/** When the repeating-mistake nudge last went out. */
	loopedAt?: number
	/** Days used, things it did for you, and whether it has asked for support. */
	use?: { days?: string[]; wins?: number; askedAt?: number; asked?: number; never?: boolean }
	/** Eyes, water and posture: when each last spoke, and today's glasses. */
	health?: {
		/** When you last came back to the desk: every health clock starts here. */
		backAt?: number
		lastEyes?: number
		lastMove?: number
		lastWater?: number
		lastPosture?: number
		lastBreathe?: number
		water?: number
		waterDate?: string
		/** How many times each nudge has spoken, so its wording moves on. */
		said?: Partial<Record<NudgeKind, number>>
		/** What you wrote at a break: a reminder for the next one, or a record. */
		notes?: { id: string; at: number; text: string; kind?: string; showNext?: boolean; shownAt?: number }[]
	}
	/** The last backup: when it ran, what it wrote, and what went wrong. */
	sync?: { at?: number; triedAt?: number; files?: Record<string, string>; error?: string; pushed?: number; target?: string }
	flags: DayFlags
	away: [number, number][]
	idleStart?: number
	lastTick?: number
	lastSync?: number
	lastError?: string
	/** Zoho refused the API for this role: use the page path and stop retrying loudly. */
	roleBlocked?: boolean
	awaiting?: 'in' | 'out'
	pending: Pending | null
	promptWindowId?: number
	snoozeUntil?: number
	snoozes: number
	/** A focus session in progress: quiet until it ends, then one question. */
	focus?: { taskUid?: string; startedAt: number; endsAt: number; intent?: string; extended?: number; strayed?: { host: string; at: number }[]; broke?: { what: string; at: number }[] }
	/** What the block that just ended was for, so the question it asks starts there. */
	lastFocusIntent?: string
	/** Blocks that have finished, for what the week came to. */
	deep?: { date: string; minutes: number; finished: boolean; intent?: string; broke?: { what: string; at: number }[] }[]
	/** The link behind the last timed reminder, opened if you click it. */
	reminderUrl?: string
	/** The ceiling on gentle cards: when the last one went out, and how many this hour. */
	gentle?: { at?: number; hour?: string; count?: number }
	/**
	 * The team: when we last pushed, when something last changed that is worth
	 * pushing, and what the last poll found — the shas, so an unchanged file is
	 * never fetched twice, and the contents, so the board opens without waiting.
	 */
	team?: { at?: number; triedAt?: number; changedAt?: number; polledAt?: number; shas?: Record<string, string>; files?: Record<string, string>; error?: string }
	/**
	 * The bridge folder of the backup repository: the tree's ETag (so an
	 * unchanged repository costs a free 304), the sha of every entry file, their
	 * contents, and this browser's name as a writer there.
	 */
	bridge?: {
		device?: string
		etag?: string
		polledAt?: number
		shas?: Record<string, string>
		files?: Record<string, string>
		error?: string
		/** Entries saved while there was no repository or no network, sent on the next sync. */
		queue?: BridgeEntry[]
		/** Work-log records already imported from Claude Code. */
		importedWorklogs?: string[]
	}
	/** The newest release GitHub reported, when it was asked, which one was dismissed, and the version that ran last. */
	update?: { latest?: Release; checkedAt?: number; dismissed?: string; seen?: string; error?: string }
	/** A recording in progress: what it is of, and when it stops itself. */
	clip?: { startedAt: number; seconds: number; url?: string; title?: string }
	/** The last thing that could be put back, and the record as it was. */
	undo?: { kind: string; label: string; at: number; before: unknown; id?: string }
	/** A page note waiting for its words: the page, and the screenshot taken of it. */
	noteDraft?: { url: string; title?: string; where?: string; shot?: string; at: number }
}

export type Auth =
	| { kind: 'oauth'; accessToken: string; expiresAt: number; renewable: boolean }
	| { kind: 'self'; clientId: string; clientSecret: string; refreshToken: string; accessToken?: string; expiresAt?: number }

// Eyes, posture and water. Gentle, opt-in, and quiet when being interrupted
// would be worse than the thing it is reminding you about — during a focus
// session, a meeting, or when you are not at the desk at all.
//
// The 20-20-20 rule: every 20 minutes of screen work, look at something about
// 20 feet away for 20 seconds. Longer breaks after about two hours.

export type NudgeKind = 'eyes' | 'move' | 'water' | 'posture'

export interface HealthSettings {
	/** Minutes between eye breaks. 0 is off. The rule says 20. */
	eyeEvery: number
	/** Minutes at the desk before standing up. 0 is off. */
	moveEvery: number
	/** Glasses a day. 0 is off. */
	waterTarget: number
	/** Minutes between water nudges while you are at the desk. */
	waterEvery: number
	posture: boolean
}

export interface HealthState {
	now: number
	/** Minutes of unbroken screen time — reset by any break. */
	atDeskSince: number
	/**
	 * When you last came back from being away — idle, asleep, or Chrome closed.
	 *
	 * Time away from the keyboard *is* the break, so every clock starts again
	 * from here. Without it, opening the laptop in the morning is met with
	 * "stand up for a minute", because the last eye break was yesterday
	 * afternoon and the arithmetic is technically right and obviously wrong.
	 */
	backAt?: number
	/** When each nudge last went out. */
	lastEyes?: number
	lastMove?: number
	lastWater?: number
	lastPosture?: number
	/** Glasses logged today. */
	water: number
	/** Quiet during a focus session or a meeting: those are the point. */
	busyUntil?: number
	checkedIn: boolean
	checkedOut: boolean
	idleSecs: number
}

/** Not at the desk, not on the clock, or deliberately heads-down. */
function quiet(s: HealthState): boolean {
	if (!s.checkedIn || s.checkedOut) return true
	if (s.busyUntil != null && s.now < s.busyUntil) return true
	// Away from the keyboard: a reminder to look away is for someone looking.
	return s.idleSecs > 180
}

const MIN = 60_000

/**
 * The nudges owed right now, in the order they matter. They are shown as one
 * card rather than three — see `mergeNudges`. Three cards in a row is the thing
 * that gets an extension removed.
 */
export function dueNudges(set: HealthSettings, s: HealthState): NudgeKind[] {
	if (quiet(s)) return []
	const out: NudgeKind[] = []
	// Coming back from away restarts every clock: you have just had the break
	// this would be asking you to take.
	const desk = Math.max(s.atDeskSince, s.backAt ?? 0)
	const since = (at?: number) => s.now - Math.max(at ?? 0, s.backAt ?? 0)
	const atDesk = s.now - desk

	if (set.eyeEvery > 0 && atDesk >= set.eyeEvery * MIN && since(s.lastEyes) >= set.eyeEvery * MIN) out.push('eyes')
	// Standing up matters more than looking away, so when both are owed at the
	// same moment the longer break wins.
	if (set.moveEvery > 0 && atDesk >= set.moveEvery * MIN && since(s.lastMove) >= set.moveEvery * MIN) out.unshift('move')
	if (set.waterTarget > 0 && s.water < set.waterTarget && atDesk >= Math.max(20, set.waterEvery) * MIN && since(s.lastWater) >= Math.max(20, set.waterEvery) * MIN) out.push('water')
	if (set.posture && atDesk >= 90 * MIN && since(s.lastPosture) >= 90 * MIN) out.push('posture')
	return out
}

export interface Nudge {
	kind: NudgeKind
	title: string
	body: string
	/** Seconds the break is worth, for the countdown. 0 means there is no timer. */
	seconds: number
}

/**
 * What each nudge says, with a few ways of saying it.
 *
 * The same four words every hour becomes wallpaper, and wallpaper gets skipped:
 * a break card you no longer read is a break you no longer take. So the line
 * rotates. What it does not do is cheer at you or claim things about your
 * health — the only thing it knows is that you have been sitting still, and the
 * only honest tone for that is a nudge from someone passing your desk.
 */
const LINES: Record<NudgeKind, { title: string; body: string }[]> = {
	eyes: [
		{ title: 'Look away for 20 seconds', body: 'Something about 20 feet off. The far wall, a window, the corridor.' },
		{ title: 'Find the furthest thing you can see', body: 'Twenty seconds on it. Your eyes have been at one distance for a while.' },
		{ title: 'Twenty seconds, somewhere far', body: 'The whole of the 20-20-20 rule: every 20 minutes, 20 feet away, 20 seconds.' },
		{ title: 'Unfocus', body: 'Let your eyes rest at a long distance. Blink a few times while you are there.' },
		{ title: 'Look out of the window', body: 'If there is one. If not, the longest line of sight in the room will do.' },
	],
	move: [
		{ title: 'Stand up for a minute', body: 'Two minutes away is enough to reset the next hour.' },
		{ title: 'On your feet', body: 'Walk to the other end of the room and back. That is the whole exercise.' },
		{ title: 'Get the blood moving', body: 'Stand, stretch, shoulders back. Sitting still is the only part of this job that is bad for you.' },
		{ title: 'Time to move', body: 'Put the kettle on, water a plant, stand at a window. Anything that is not this chair.' },
		{ title: 'Up you get', body: 'A couple of minutes now beats a stiff back at six.' },
	],
	water: [
		{ title: 'Water', body: 'A glass, while you are thinking.' },
		{ title: 'Top up', body: 'The kettle counts. The third coffee, less so.' },
		{ title: 'Have a drink', body: 'Easiest thing on the list, and the one most often skipped.' },
		{ title: 'Glass of water', body: 'Fill it now, drink it over the next hour.' },
		{ title: 'Water break', body: 'Pair it with standing up and you have done both.' },
	],
	posture: [
		{ title: 'Sit back', body: 'Shoulders down, jaw unclenched, feet on the floor.' },
		{ title: 'Check your shoulders', body: 'They have crept up towards your ears again. Everyone’s do.' },
		{ title: 'Straighten up', body: 'Screen at eye level, back against the chair, elbows at your sides.' },
		{ title: 'Unclench', body: 'Jaw, shoulders, and whichever hand is on the mouse.' },
		{ title: 'Reset the chair', body: 'Back where the chair can hold you, rather than where the screen pulled you.' },
	],
}

const SECONDS: Record<NudgeKind, number> = { eyes: 20, move: 120, water: 0, posture: 0 }

/** What the extra nudges on a merged card are called, in a few words. */
const ALSO: Record<NudgeKind, string> = {
	eyes: 'Look up from the screen',
	move: 'Stand up for a minute',
	water: 'Have some water',
	posture: 'Sit back, shoulders down',
}

/**
 * `seed` picks which way of saying it you get — the engine passes the number of
 * times this nudge has spoken, so you work through them rather than seeing the
 * same one twice in a row.
 */
export function nudgeFor(kind: NudgeKind, water = 0, target = 0, seed = 0): Nudge {
	const lines = LINES[kind]
	const line = lines[((Math.floor(seed) % lines.length) + lines.length) % lines.length]
	const body = kind === 'water' && target ? `${line.body} ${water} of ${target} today.` : line.body
	return { kind, title: line.title, body, seconds: SECONDS[kind] }
}

export interface MergedNudge extends Nudge {
	/** The others that came due at the same moment, in a line each. */
	also: { kind: NudgeKind; text: string }[]
	/** Everything this card stands for, including the one it leads with. */
	kinds: NudgeKind[]
}

/**
 * One card for everything owed at this moment.
 *
 * Eye breaks every 20 minutes and standing up every 60 line up four times a
 * day, and when they do you used to get one card, answer it, and have the next
 * appear behind it. They are the same trip away from the desk, so they are one
 * card: the longest break leads, the rest are a line each, and answering it
 * answers all of them.
 */
export function mergeNudges(kinds: NudgeKind[], water = 0, target = 0, said: Partial<Record<NudgeKind, number>> = {}): MergedNudge | null {
	if (!kinds.length) return null
	const [lead, ...rest] = kinds
	const card = nudgeFor(lead, water, target, (said[lead] ?? 0) + 1)
	return { ...card, kinds, also: rest.map((k) => ({ kind: k, text: ALSO[k] })) }
}

/** Glasses today, never below zero and never silly. */
export const countWater = (had: number, change: number) => Math.max(0, Math.min(30, had + change))


// ── notes you make at a break ───────────────────────────────────────────────

export interface HealthNote {
	id: string
	at: number
	text: string
	/** Which nudge you were looking at when you wrote it. */
	kind?: NudgeKind
	/** Say it back on the next break, rather than filing it away. */
	showNext?: boolean
	/** Said back already, so it is not said at every break for ever. */
	shownAt?: number
}

/**
 * The note to put at the top of the next break card: the most recent one you
 * asked to be reminded of, and only until it has been shown once. A note that
 * comes back at every break for ever is a note you stop reading.
 */
export function noteForNext(notes: HealthNote[], now: number): HealthNote | null {
	return (
		notes
			.filter((n) => n.showNext && n.shownAt == null && now - n.at > 30_000)
			.sort((a, b) => b.at - a.at)[0] ?? null
	)
}

/** Everything you have written at a break, newest first. */
export const healthNotes = (notes: HealthNote[]) => [...notes].sort((a, b) => b.at - a.at)

// When, if ever, to ask for support.
//
// The rules here are the product's manners, so they are written down and tested
// rather than left to a component. Three of them matter:
//
//   1. Ask only after the thing has done something for you. Asking a stranger
//      is begging; asking someone you just saved an hour is a fair question.
//   2. Ask once, quietly, and never again in the same season. A free tool that
//      nags is not free, it is paid in attention.
//   3. Never interrupt. This is a card on a page you chose to open — never a
//      notification, never a forced card, never anything that stops work.
//
// "No" is permanent. There is no second funnel.

export interface AskState {
	now: number
	/** Days WorkPulse has been used — not days installed. */
	activeDays: number
	/** Timesheets actually pushed, backups written: things it did *for* you. */
	wins: number
	/** When it last asked, and how many times ever. */
	lastAskedAt?: number
	asked: number
	/** Said no, or already supports it. Either way: never again. */
	dismissedForever?: boolean
	/** Something is already owed on screen. */
	busy: boolean
}

export const ASK_AFTER_DAYS = 10
export const ASK_AFTER_WINS = 5
export const ASK_GAP_DAYS = 90
export const ASK_AT_MOST = 3

/**
 * Whether to show the one-line ask. Deliberately hard to satisfy: a fortnight of
 * real use, several things it actually did, nothing else on screen, and at most
 * three times in the life of the install.
 */
export function shouldAsk(s: AskState): boolean {
	if (s.dismissedForever || s.busy) return false
	if (s.asked >= ASK_AT_MOST) return false
	if (s.activeDays < ASK_AFTER_DAYS || s.wins < ASK_AFTER_WINS) return false
	if (s.lastAskedAt != null && s.now - s.lastAskedAt < ASK_GAP_DAYS * 86_400_000) return false
	return true
}

/**
 * What it says. The number is the point: the ask is justified by what it did,
 * and if it did nothing there is nothing to justify it.
 */
export function askText(s: { wins: number; activeDays: number; hoursSaved?: number }): string {
	const timesheets = s.wins
	return `WorkPulse has filled ${timesheets} timesheet${timesheets === 1 ? '' : 's'} for you across ${s.activeDays} days. It is free, it has no server, and nothing you write leaves this machine. If it is worth something to you, sponsoring it keeps it maintained.`
}

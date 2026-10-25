// What Pro is, and what it is honestly allowed to withhold.
//
// The code is open and it runs on your machine. Any check written here is a
// boolean somebody can flip, and the source tells them which one — so this does
// not pretend to be a lock. It draws one line instead:
//
//   SERVED features need something on our side: a hosted backup to write to, a
//   person to answer. Those are enforced where they actually live, by a server
//   refusing a key it does not know. Nothing in this file can grant them, and
//   flipping a flag here gets you nothing.
//
//   LOCAL features are arithmetic over data you already own, on your own
//   machine. Withholding those would be theatre — and theatre that makes the
//   app worse for somebody who simply has not paid yet. They run. They ask
//   once, and they take no for an answer.
//
// The daily loop — the card, the entry, the timesheet, the export — is never
// gated at all, in any build, for anybody. That is the product.

export type Tier = 'free' | 'pro'

/** Everything Pro is allowed to have an opinion about. Nothing else. */
export type Gated =
	| 'record'
	| 'overtime'
	| 'calibration'
	| 'handover'
	| 'briefing'
	| 'hostedBackup'
	| 'support'

/**
 * Where a feature actually lives.
 *
 * `served` is the only kind that can be refused, because refusing it is the
 * server declining to do work. `local` can only ever be asked about.
 */
const WHERE: Record<Gated, 'local' | 'served'> = {
	record: 'local',
	overtime: 'local',
	calibration: 'local',
	handover: 'local',
	briefing: 'local',
	hostedBackup: 'served',
	support: 'served',
}

/** What each one is called when it has to be named to somebody. */
const CALLED: Record<Gated, string> = {
	record: 'The six-month record',
	overtime: 'The hours you really worked',
	calibration: 'How long things really take you',
	handover: 'Handover',
	briefing: 'The morning briefing',
	hostedBackup: 'Hosted backup',
	support: 'Support',
}

export interface Licence {
	tier: Tier
	/** Sent with a served request. Validated on our side; never checked here. */
	key?: string
}

export function isPro(l: Licence | undefined): boolean {
	return l?.tier === 'pro'
}

export interface Verdict {
	/** Whether the feature runs. A local feature always runs. */
	allowed: boolean
	/**
	 * One line to show, or nothing. Present only when somebody on the free tier
	 * has just used a local Pro feature — never on a served one, where the
	 * honest answer is that it is not available rather than that it is unpaid.
	 */
	nag?: string
	/** Dismissals are remembered per feature, not once for the whole app. */
	nagKey?: string
}

/**
 * Can this person use this, and should anything be said about it?
 *
 * One call site per feature. Scattering `isPro()` through the views is how a
 * free tier quietly becomes a crippled one.
 */
export function gate(feature: Gated, l: Licence | undefined): Verdict {
	if (isPro(l)) return { allowed: true }
	if (WHERE[feature] === 'served') return { allowed: false }
	return {
		allowed: true,
		// Said once, in the second person, with the thing it is asking for named
		// plainly. No countdown, no crossed-out price, no "upgrade now".
		nag: `${CALLED[feature]} is a Pro feature. It is working anyway — if it turns out to be worth something to you, that is what Pro pays for.`,
		nagKey: `wp-nag-${feature}`,
	}
}

/** What a served feature says when there is no key for it. Never a scold. */
export function unavailable(feature: Gated): string {
	if (WHERE[feature] !== 'served') return ''
	return feature === 'hostedBackup'
		? 'Hosted backup is a Pro feature, because it runs on our machines rather than yours. Backup to a repository you own is free and always will be — set it up in Settings.'
		: 'Support from a person is part of Pro. The issue tracker is open to everybody, and gets answered when it can be.'
}

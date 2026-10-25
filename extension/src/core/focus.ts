// What the widget should put in front of you, and nothing else. One primary
// action at a time, chosen from the day's state — the popup renders this rather
// than deciding for itself, so the choice is testable and cannot drift.

import { fmtMinutes } from './time'
import type { Day, Settings } from './types'

export interface FocusInput {
	now: number
	day: Day
	settings: Settings
	loggedMinutes: number
	awaiting?: 'in' | 'out'
	isWorkDay: boolean
}

export type FocusKind = 'confirm' | 'checkin' | 'log' | 'wrapup' | 'checkout' | 'resting' | 'off'

export interface Focus {
	kind: FocusKind
	/** The button, or the line of text when there is nothing to press. */
	label: string
	/** Minutes on the clock since check-in, capped at the check-out. */
	elapsed: number
	/** Time worked but not written down — the gap that costs you at review time. */
	gap: number
	/** 0–1 towards the day's target, for the bar. */
	progress: number
}

export function focus(i: FocusInput): Focus {
	const { day, settings } = i
	const target = Math.max(1, settings.minHours * 60)
	const until = day.checkedOutAt ?? i.now
	const elapsed = day.checkedInAt != null ? Math.max(0, Math.round((until - day.checkedInAt) / 60_000)) : 0
	const gap = Math.max(0, elapsed - i.loggedMinutes)
	const progress = Math.min(1, elapsed / target)
	const base = { elapsed, gap, progress }

	if (day.isOff || !i.isWorkDay) return { ...base, kind: 'off', label: 'Day off — nothing to log' }
	if (i.awaiting) return { ...base, kind: 'confirm', label: `I've checked ${i.awaiting === 'in' ? 'in' : 'out'}` }
	if (day.checkedInAt == null) return { ...base, kind: 'checkin', label: 'Check in' }

	// An hour of work you have not written down is the thing to fix first.
	if (gap >= 1 && day.checkedOutAt == null) return { ...base, kind: 'log', label: `Log the last ${fmtMinutes(gap)}` }
	// "Wrap up", "close the day" and "check out" were three names for one
	// moment. Check out is the punch; closing the day is the whole thing, and
	// that is what this button starts.
	if (day.timelogStatus === 'pending' && (day.checkedOutAt != null || elapsed >= target)) return { ...base, kind: 'wrapup', label: 'Close the day' }
	if (day.checkedOutAt == null && elapsed >= target) return { ...base, kind: 'checkout', label: 'Check out' }
	return { ...base, kind: 'resting', label: day.checkedOutAt != null ? 'Day closed' : 'All logged — keep going' }
}


// ── open tabs ───────────────────────────────────────────────────────────────

export interface OpenTab {
	id: number
	title: string
	url: string
	pinned: boolean
	audible: boolean
	active: boolean
}

/**
 * The same page open more than once, keyed by address without its fragment —
 * `#section` links are the same page, and closing the spare is the one cleanup
 * nobody regrets.
 */
export function duplicates(tabs: OpenTab[]): OpenTab[] {
	const seen = new Set<string>()
	const out: OpenTab[] = []
	for (const t of tabs) {
		const key = t.url.split('#')[0]
		if (!key) continue
		if (seen.has(key)) {
			// Never offer to close the one you are looking at, or a pinned one.
			if (!t.pinned && !t.active) out.push(t)
		} else seen.add(key)
	}
	return out
}

/** A tab's site, for showing a list of 30 without a wall of URLs. */
export function site(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, '')
	} catch {
		return url
	}
}

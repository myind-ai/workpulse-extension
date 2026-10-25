import { describe, expect, it } from 'vitest'

import { countWater, dueNudges, healthNotes, mergeNudges, noteForNext, nudgeFor, type HealthSettings, type HealthState } from './health'
import { parseIst } from './time'

const NOW = parseIst('2026-10-13T11:00:00')
const set = (patch: Partial<HealthSettings> = {}): HealthSettings => ({ eyeEvery: 20, moveEvery: 0, waterTarget: 8, waterEvery: 45, posture: true, ...patch })
const state = (patch: Partial<HealthState> = {}): HealthState => ({
	now: NOW,
	atDeskSince: NOW - 60 * 60_000,
	water: 0,
	checkedIn: true,
	checkedOut: false,
	idleSecs: 10,
	...patch,
})

describe('when a nudge is owed', () => {
	it('should ask for an eye break after the interval of unbroken screen time', () => {
		expect(dueNudges(set(), state())).toContain('eyes')
		expect(dueNudges(set(), state({ atDeskSince: NOW - 5 * 60_000 }))).not.toContain('eyes')
	})

	it('should not repeat an eye break before the interval is up again', () => {
		expect(dueNudges(set(), state({ lastEyes: NOW - 5 * 60_000 }))).not.toContain('eyes')
		expect(dueNudges(set(), state({ lastEyes: NOW - 21 * 60_000 }))).toContain('eyes')
	})

	it('should stop asking for water once the day’s target is met', () => {
		expect(dueNudges(set(), state({ water: 8 }))).not.toContain('water')
		expect(dueNudges(set(), state({ water: 3 }))).toContain('water')
	})

	it('should stay quiet during a focus session or a meeting', () => {
		expect(dueNudges(set(), state({ busyUntil: NOW + 10 * 60_000 }))).toEqual([])
	})

	it('should stay quiet when you are not at the keyboard', () => {
		// A reminder to look away is for someone who is looking.
		expect(dueNudges(set(), state({ idleSecs: 600 }))).toEqual([])
	})

	it('should stay quiet before checking in and after checking out', () => {
		expect(dueNudges(set(), state({ checkedIn: false }))).toEqual([])
		expect(dueNudges(set(), state({ checkedOut: true }))).toEqual([])
	})

	it('should respect each one being switched off', () => {
		expect(dueNudges(set({ eyeEvery: 0, moveEvery: 0, waterTarget: 0, posture: false }), state())).toEqual([])
	})

	it('should ask you to stand up after a longer stretch', () => {
		const sitting = set({ eyeEvery: 0, moveEvery: 50, waterTarget: 0, posture: false })
		expect(dueNudges(sitting, state({ atDeskSince: NOW - 20 * 60_000 }))).toEqual([])
		expect(dueNudges(sitting, state({ atDeskSince: NOW - 55 * 60_000 }))).toEqual(['move'])
	})

	it('should put standing up above looking away when both are owed', () => {
		expect(dueNudges(set({ moveEvery: 50 }), state({ atDeskSince: NOW - 60 * 60_000 }))[0]).toBe('move')
	})

	it('should put the eyes first when several are owed', () => {
		expect(dueNudges(set(), state())[0]).toBe('eyes')
	})
})

describe('what a nudge says', () => {
	it('should carry a countdown only where one makes sense', () => {
		expect(nudgeFor('eyes').seconds).toBe(20)
		expect(nudgeFor('move').seconds).toBe(120)
		expect(nudgeFor('water').seconds).toBe(0)
		expect(nudgeFor('posture').seconds).toBe(0)
	})

	it('should count the glasses when there is a target', () => {
		expect(nudgeFor('water', 3, 8).body).toContain('3 of 8 today.')
		expect(nudgeFor('water').body).not.toMatch(/\d+ of \d+ today/)
	})
})

describe('counting water', () => {
	it('should go up and down, and never below zero or past sense', () => {
		expect(countWater(3, 1)).toBe(4)
		expect(countWater(0, -1)).toBe(0)
		expect(countWater(30, 1)).toBe(30)
	})
})

describe('a card that is not the same four words every time', () => {
	it('should say it a different way each time it speaks', () => {
		const said = Array.from({ length: 5 }, (_, i) => nudgeFor('eyes', 0, 0, i).title)
		expect(new Set(said).size).toBe(5)
	})

	it('should come back round rather than run out', () => {
		expect(nudgeFor('move', 0, 0, 0)).toEqual(nudgeFor('move', 0, 0, 5))
	})

	it('should keep the countdown with the kind, not with the wording', () => {
		for (let i = 0; i < 6; i++) {
			expect(nudgeFor('eyes', 0, 0, i).seconds).toBe(20)
			expect(nudgeFor('move', 0, 0, i).seconds).toBe(120)
			expect(nudgeFor('water', 0, 0, i).seconds).toBe(0)
		}
	})

	it('should still count the glasses, whichever way it asks', () => {
		for (let i = 0; i < 5; i++) expect(nudgeFor('water', 3, 8, i).body).toContain('3 of 8 today.')
		// "coffee" contains "of", so the count is what to look for, not the word.
		expect(nudgeFor('water', 3, 0, 1).body).not.toMatch(/\d+ of \d+ today/)
	})

	it('should not cheer, diagnose or promise anything', () => {
		for (const kind of ['eyes', 'move', 'water', 'posture'] as const) {
			for (let i = 0; i < 5; i++) {
				const n = nudgeFor(kind, 0, 0, i)
				const text = `${n.title} ${n.body}`
				expect(text, text).not.toMatch(/you must|burn|calorie|cure|boost your|great job|well done|crush|hustle|!{1}/i)
				expect(n.title.length, n.title).toBeLessThan(42)
			}
		}
	})
})

describe('notes made at a break', () => {
	const NOW = parseIst('2026-10-14T11:00:00')
	const note = (patch: Partial<import('./health').HealthNote> = {}) => ({ id: 'n', at: NOW - 60_000, text: 'Take the tablet at 3', ...patch })

	it('should bring back the one you asked to be reminded of', () => {
		expect(noteForNext([note({ showNext: true })], NOW)?.text).toBe('Take the tablet at 3')
	})

	it('should leave the ones you only wanted kept', () => {
		expect(noteForNext([note({ showNext: false })], NOW)).toBeNull()
	})

	it('should say it once, not at every break for ever', () => {
		expect(noteForNext([note({ showNext: true, shownAt: NOW - 30_000 })], NOW)).toBeNull()
	})

	it('should not say it back on the card you wrote it on', () => {
		expect(noteForNext([note({ showNext: true, at: NOW - 5_000 })], NOW)).toBeNull()
	})

	it('should pick the newest when there are several waiting', () => {
		const older = note({ id: 'a', text: 'older', at: NOW - 600_000, showNext: true })
		const newer = note({ id: 'b', text: 'newer', at: NOW - 120_000, showNext: true })
		expect(noteForNext([older, newer], NOW)?.text).toBe('newer')
	})

	it('should list what you have written, newest first', () => {
		expect(healthNotes([note({ id: 'a', at: 1 }), note({ id: 'b', at: 2 })]).map((n) => n.id)).toEqual(['b', 'a'])
	})
})

describe('one card for everything owed at once', () => {
	it('should lead with the longest break and list the rest', () => {
		const card = mergeNudges(['move', 'eyes', 'water'], 2, 8)
		expect(card?.kind).toBe('move')
		expect(card?.seconds).toBe(120)
		expect(card?.also.map((a) => a.kind)).toEqual(['eyes', 'water'])
	})

	it('should stand for every nudge it merged, so answering it answers all', () => {
		expect(mergeNudges(['eyes', 'posture'])?.kinds).toEqual(['eyes', 'posture'])
	})

	it('should be nothing when nothing is owed', () => {
		expect(mergeNudges([])).toBeNull()
	})

	it('should work through the wording of the one it leads with', () => {
		const a = mergeNudges(['eyes'], 0, 0, {})
		const b = mergeNudges(['eyes'], 0, 0, { eyes: 1 })
		expect(a?.title).not.toBe(b?.title)
	})
})

describe('a minute of breathing', () => {
	it('is off unless asked for', () => {
		expect(dueNudges(set(), state())).not.toContain('breathe')
	})

	it('comes due on its own interval, and not again until the next one', () => {
		expect(dueNudges(set({ breatheEvery: 60 }), state())).toContain('breathe')
		expect(dueNudges(set({ breatheEvery: 60 }), state({ lastBreathe: NOW - 10 * 60_000 }))).not.toContain('breathe')
	})

	it('stays quiet during a focus session like every other break', () => {
		expect(dueNudges(set({ breatheEvery: 60 }), state({ busyUntil: NOW + 60_000 }))).toEqual([])
	})

	it('counts down a minute and joins a merged card in a line', () => {
		expect(nudgeFor('breathe').seconds).toBe(60)
		expect(mergeNudges(['eyes', 'breathe'])?.also).toEqual([{ kind: 'breathe', text: 'A minute of slow breathing' }])
	})
})

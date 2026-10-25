import { describe, expect, it } from 'vitest'

import { IDLE_SKIP_SECS, askWindow, decide, inMeeting, promptOwed, type Snapshot } from './schedule'
import { parseIst } from './time'
import { DEFAULT_SETTINGS, emptyFlags } from './types'

// 2026-10-12 is a Monday; 2026-10-11 a Sunday.
function snap(now: string, patch: Partial<Snapshot> = {}): Snapshot {
	const today = now.slice(0, 10)
	return {
		now: parseIst(now),
		today,
		settings: { ...DEFAULT_SETTINGS },
		day: { date: today, timelogStatus: 'pending', isOff: false },
		slotStart: null,
		loggedMinutes: 0,
		idleSecs: 0,
		flags: emptyFlags(today),
		pending: null,
		hasZoho: false,
		awaitingZoho: false,
		pendingDays: 0,
		...patch,
	}
}

function checkedIn(now: string, slot: string, patch: Partial<Snapshot> = {}): Snapshot {
	const s = snap(now, patch)
	s.day.checkedInAt = parseIst('2026-10-12T09:05:00')
	s.slotStart = parseIst(slot)
	s.flags.scanDone = true
	return s
}

describe('decide', () => {
	it('does nothing on weekends or days off', () => {
		expect(decide(snap('2026-10-11T10:00:00'))).toEqual([])
		const s = snap('2026-10-12T10:00:00')
		s.day.isOff = true
		expect(decide(s)).toEqual([])
	})

	it('reads Zoho before anything else', () => {
		const s = snap('2026-10-12T09:20:00', { hasZoho: true })
		expect(decide(s)).toEqual([{ type: 'sync' }])
		s.lastSync = parseIst('2026-10-12T09:19:00')
		expect(decide(s)).not.toContainEqual({ type: 'sync' })
		s.awaitingZoho = true
		expect(decide(s)).toContainEqual({ type: 'sync' })
	})

	it('escalates check-in: soft window, notification, forced window', () => {
		expect(decide(snap('2026-10-12T08:40:00'))).toEqual([{ type: 'checkin', blocking: false }])
		const s = snap('2026-10-12T09:05:00')
		s.flags.checkinSoftShown = true
		expect(decide(s)[0]).toMatchObject({ type: 'notify', kind: 'checkin' })
		const late = snap('2026-10-12T09:16:00', { pending: { kind: 'checkin', blocking: false, since: 0 } })
		expect(decide(late)).toEqual([{ type: 'checkin', blocking: true }])
		late.pending = { kind: 'checkin', blocking: true, since: 0 }
		expect(decide(late)).toEqual([])
		const snoozed = snap('2026-10-12T09:16:00', { snoozeUntil: parseIst('2026-10-12T09:20:00') })
		expect(decide(snoozed)).toEqual([])
	})

	it('shows no soft check-in to an idle user', () => {
		expect(decide(snap('2026-10-12T08:40:00', { idleSecs: 900 }))).toEqual([])
	})

	it('prompts hourly when due and active', () => {
		expect(decide(checkedIn('2026-10-12T10:04:00', '2026-10-12T09:05:00'))).toEqual([])
		expect(decide(checkedIn('2026-10-12T10:05:00', '2026-10-12T09:05:00'))).toEqual([{ type: 'prompt' }])
		expect(decide(checkedIn('2026-10-12T10:05:00', '2026-10-12T09:05:00', { idleSecs: IDLE_SKIP_SECS + 1 }))).toEqual([])
		expect(decide(checkedIn('2026-10-12T10:05:00', '2026-10-12T09:05:00', { pending: { kind: 'prompt', blocking: true, since: 0 } }))).toEqual([])
	})

	it('respects snooze', () => {
		const s = checkedIn('2026-10-12T10:05:00', '2026-10-12T09:05:00', { snoozeUntil: parseIst('2026-10-12T10:10:00') })
		expect(decide(s)).toEqual([])
		s.now = parseIst('2026-10-12T10:11:00')
		expect(decide(s)).toEqual([{ type: 'prompt' }])
	})

	it('gives one prompt after a long sleep', () => {
		expect(decide(checkedIn('2026-10-12T14:30:00', '2026-10-12T11:00:00'))).toEqual([{ type: 'prompt' }])
	})

	it('prompts the final partial slot, then wraps up', () => {
		const a = decide(checkedIn('2026-10-12T18:31:00', '2026-10-12T18:05:00'))
		expect(a[0]).toEqual({ type: 'prompt' })
		expect(a[1]).toMatchObject({ type: 'notify', kind: 'wrapup' })
		const s = checkedIn('2026-10-12T19:01:00', '2026-10-12T18:30:00')
		s.flags.wrapupNotified = true
		expect(decide(s)).toEqual([{ type: 'wrapup' }])
		s.day.timelogStatus = 'pushed'
		expect(decide(s)).toEqual([])
	})

	it('stops prompting after checkout', () => {
		const s = checkedIn('2026-10-12T17:00:00', '2026-10-12T15:00:00')
		s.day.checkedOutAt = parseIst('2026-10-12T16:00:00')
		expect(decide(s)).toEqual([])
	})

	it('scans and sends the catch-up reminder once', () => {
		const s = checkedIn('2026-10-12T09:30:00', '2026-10-12T09:05:00', {
			hasZoho: true,
			lastSync: parseIst('2026-10-12T09:29:00'),
			pendingDays: 2,
		})
		s.flags.scanDone = false
		expect(decide(s)).toEqual([{ type: 'scan' }, { type: 'catchup' }])
	})
})

describe('whether an hourly prompt is still owed', () => {
	const base = {
		isOff: false,
		checkedInAt: parseIst('2026-10-13T09:00:00'),
		slotEnd: null,
		now: parseIst('2026-10-13T10:05:00'),
		shiftEnd: parseIst('2026-10-13T18:30:00'),
		intervalMinutes: 60,
	}

	it('should be owed while there is time nobody has written down', () => {
		expect(promptOwed(base)).toBe(true)
	})

	it('should not be owed once the hour has been logged, however it was logged', () => {
		// The dashboard logged 09:00–10:05 while the card sat behind a snooze.
		expect(promptOwed({ ...base, slotEnd: parseIst('2026-10-13T10:05:00') })).toBe(false)
	})

	it('should not be owed for the few minutes since the last entry', () => {
		// Logged up to 09:40 and it is now 09:45: five minutes is not a slot.
		expect(promptOwed({ ...base, slotEnd: parseIst('2026-10-13T09:40:00'), now: parseIst('2026-10-13T09:45:00') })).toBe(false)
	})

	it('should settle for a short final slot once the shift has ended', () => {
		const after = { ...base, now: parseIst('2026-10-13T18:45:00'), slotEnd: parseIst('2026-10-13T18:15:00') }
		expect(promptOwed(after)).toBe(true) // 15 minutes to the shift end is worth asking about
		expect(promptOwed({ ...after, slotEnd: parseIst('2026-10-13T18:25:00') })).toBe(false) // 5 is not
	})

	it('should not be owed after checking out, or on a day off', () => {
		expect(promptOwed({ ...base, checkedOutAt: parseIst('2026-10-13T10:00:00') })).toBe(false)
		expect(promptOwed({ ...base, isOff: true })).toBe(false)
	})

	it('should not be owed before checking in', () => {
		expect(promptOwed({ ...base, checkedInAt: undefined })).toBe(false)
	})

	it('should stand when you asked for it yourself', () => {
		expect(promptOwed({ ...base, slotEnd: base.now, manual: true })).toBe(true)
	})
})

describe('once the day’s hours are written down', () => {
	const working = (patch: Partial<Snapshot> = {}) =>
		snap('2026-10-12T15:30:00', {
			day: { date: '2026-10-12', timelogStatus: 'pending', isOff: false, checkedInAt: parseIst('2026-10-12T09:00:00') },
			slotStart: parseIst('2026-10-12T14:00:00'),
			...patch,
		})

	it('should still ask while there are hours to account for', () => {
		expect(decide(working({ loggedMinutes: 240 })).some((a) => a.type === 'prompt')).toBe(true)
	})

	it('should stop asking once the target is logged', () => {
		// Eight hours written down: the hourly question has been answered.
		expect(decide(working({ loggedMinutes: 8 * 60 })).some((a) => a.type === 'prompt')).toBe(false)
	})

	it('should follow the target you set, not a fixed eight', () => {
		const short = { ...DEFAULT_SETTINGS, minHours: 5 }
		expect(decide(working({ loggedMinutes: 5 * 60, settings: short })).some((a) => a.type === 'prompt')).toBe(false)
		expect(decide(working({ loggedMinutes: 4 * 60, settings: short })).some((a) => a.type === 'prompt')).toBe(true)
	})

	it('should take a card off the screen that is no longer owed', () => {
		const base = {
			isOff: false,
			checkedInAt: parseIst('2026-10-12T09:00:00'),
			slotEnd: parseIst('2026-10-12T14:00:00'),
			now: parseIst('2026-10-12T15:30:00'),
			shiftEnd: parseIst('2026-10-12T18:30:00'),
			intervalMinutes: 60,
			minHours: 8,
		}
		expect(promptOwed({ ...base, loggedMinutes: 7 * 60 })).toBe(true)
		expect(promptOwed({ ...base, loggedMinutes: 8 * 60 })).toBe(false)
		// Unless you asked for it yourself.
		expect(promptOwed({ ...base, loggedMinutes: 8 * 60, manual: true })).toBe(true)
	})
})

describe('the evening belongs to the wrap-up', () => {
	const evening = (patch: Partial<Snapshot> = {}) =>
		snap('2026-10-12T20:30:00', {
			day: { date: '2026-10-12', timelogStatus: 'pending', isOff: false, checkedInAt: parseIst('2026-10-12T09:00:00') },
			slotStart: parseIst('2026-10-12T18:00:00'),
			loggedMinutes: 300,
			...patch,
		})

	it('should ask once more at the end, then leave the evening to the wrap-up', () => {
		// The final partial slot is still worth one question…
		expect(decide(evening()).some((a) => a.type === 'prompt')).toBe(true)
		// …and once the wrap-up has spoken, the hourly card is done for the day.
		const after = evening({ flags: { ...emptyFlags('2026-10-12'), wrapupNotified: true } })
		expect(decide(after).some((a) => a.type === 'prompt')).toBe(false)
	})

	it('should still wrap up', () => {
		const out = decide(evening())
		expect(out.some((a) => a.type === 'wrapup' || (a.type === 'notify' && a.kind === 'wrapup'))).toBe(true)
	})

	it('should still ask during the shift', () => {
		expect(decide(evening({ now: parseIst('2026-10-12T17:00:00'), slotStart: parseIst('2026-10-12T15:30:00') })).some((a) => a.type === 'prompt')).toBe(true)
	})
})

describe('waiting for a punch you were sent to make', () => {
	const sent = (patch: Partial<Snapshot> = {}) =>
		snap('2026-10-12T09:40:00', { awaitingZoho: true, flags: { ...emptyFlags('2026-10-12'), checkinNotified: true }, ...patch })

	it('should not ask again while Zoho is open and waiting for you', () => {
		// The loop people describe as "it keeps asking me to check in": you pressed
		// check in, Zoho opened, and the card came back over it.
		expect(decide(sent()).some((a) => a.type === 'checkin')).toBe(false)
	})

	it('should ask again once the wait is over and there is still no punch', () => {
		expect(decide(sent({ awaitingZoho: false })).some((a) => a.type === 'checkin')).toBe(true)
	})

	it('should still read Zoho while it waits', () => {
		expect(decide(sent({ hasZoho: true, lastSync: parseIst('2026-10-12T09:39:00') })).some((a) => a.type === 'sync')).toBe(true)
	})
})

describe('meetings are time you already described', () => {
	const at = (hhmm: string) => parseIst(`2026-10-12T${hhmm}:00`)
	const standup = [{ from: at('18:30'), to: at('19:00') }]

	it('should ask about the gap in front of a meeting, not through it', () => {
		expect(askWindow(at('17:58'), at('19:05'), standup)).toEqual({ from: at('17:58'), to: at('18:30') })
	})

	it('should not swallow the half hour in front of the meeting', () => {
		// The shape this replaces moved the mark to the meeting's end, so
		// 17:58–18:30 was never mentioned again.
		expect(askWindow(at('17:58'), at('19:05'), standup)?.from).toBe(at('17:58'))
	})

	it('should pick up after a meeting once the gap before it is logged', () => {
		expect(askWindow(at('18:30'), at('19:40'), standup)).toEqual({ from: at('19:00'), to: at('19:40') })
	})

	it('should have nothing to ask when the meeting is all there is', () => {
		expect(askWindow(at('18:30'), at('18:45'), standup)).toBeNull()
	})

	it('should know when you are in one', () => {
		expect(inMeeting(at('18:45'), standup)).toBe(true)
		expect(inMeeting(at('19:00'), standup)).toBe(false)
		expect(inMeeting(at('18:45'), [])).toBe(false)
	})

	it('should not interrupt a meeting to ask what you are working on', () => {
		// The report: a meeting at 18:30-19:00, and a card at 18:45 asking about
		// "17:58 - 18:44".
		const s = checkedIn('2026-10-12T18:45:00', '2026-10-12T17:58:00', { meetings: standup })
		s.settings.shiftEnd = '20:00'
		s.settings.promptInterval = 30 // the gap in front of it is long enough to ask about
		expect(decide(s).some((a) => a.type === 'prompt')).toBe(false)
	})

	it('should ask the moment the meeting is over', () => {
		const s = checkedIn('2026-10-12T19:01:00', '2026-10-12T17:58:00', { meetings: standup })
		s.settings.shiftEnd = '20:00'
		s.settings.promptInterval = 30
		expect(decide(s).some((a) => a.type === 'prompt')).toBe(true)
	})
})

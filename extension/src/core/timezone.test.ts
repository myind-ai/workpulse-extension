import { describe, expect, it } from 'vitest'

import { dayIn, explain, findDate, findTime, fixedOffset, instantOf, resolveZone, timeIn, zoneGap, zoneOffset } from './timezone'

// 2026-07-01 is summer (US and UK on DST); 2026-01-15 is winter.
const summer = Date.parse('2026-07-01T12:00:00Z')
const winter = Date.parse('2026-01-15T12:00:00Z')

describe('what a zone is offset by', () => {
	it('should read a zone that does not change', () => {
		expect(zoneOffset('Asia/Kolkata', summer)).toBe(330)
		expect(zoneOffset('UTC', summer)).toBe(0)
	})

	it('should follow daylight saving, which is the whole reason for Intl', () => {
		expect(zoneOffset('America/Los_Angeles', summer)).toBe(-420)
		expect(zoneOffset('America/Los_Angeles', winter)).toBe(-480)
		expect(zoneOffset('Europe/London', summer)).toBe(60)
		expect(zoneOffset('Europe/London', winter)).toBe(0)
	})

	it('should read an offset written out', () => {
		expect(fixedOffset('UTC+5:30')).toBe(330)
		expect(fixedOffset('GMT-8')).toBe(-480)
		expect(fixedOffset('+0530')).toBe(330)
		expect(fixedOffset('Asia/Kolkata')).toBeNull()
		expect(fixedOffset('UTC+20')).toBeNull()
	})

	it('should say nothing for a zone it does not know', () => {
		expect(zoneOffset('Mars/Olympus', summer)).toBeNull()
		expect(resolveZone('Narnia')).toBeNull()
	})

	it('should take an abbreviation, an IANA name or an offset', () => {
		expect(resolveZone('pst')).toBe('America/Los_Angeles')
		expect(resolveZone('IST')).toBe('Asia/Kolkata')
		expect(resolveZone('Europe/Berlin')).toBe('Europe/Berlin')
		expect(resolveZone('utc+2')).toBe('UTC+2')
	})
})

describe('reading a time out of what someone wrote', () => {
	it('should read the shapes people write', () => {
		expect(findTime('3pm PST')).toMatchObject({ hour: 15, minute: 0, zone: 'America/Los_Angeles' })
		expect(findTime('15:00 UTC')).toMatchObject({ hour: 15, minute: 0, zone: 'UTC' })
		expect(findTime('9:30 AM EST')).toMatchObject({ hour: 9, minute: 30, zone: 'America/New_York' })
		expect(findTime('standup at 09:45')).toMatchObject({ hour: 9, minute: 45, zone: undefined })
		expect(findTime('call at 4 p.m.')).toMatchObject({ hour: 16, minute: 0 })
		expect(findTime('11:00 (CET)')).toMatchObject({ hour: 11, zone: 'Europe/Berlin' })
		expect(findTime('08:00 UTC+5:30')).toMatchObject({ hour: 8, zone: 'UTC+5:30' })
	})

	it('should turn 12-hour into 24-hour the way a clock does', () => {
		expect(findTime('12am UTC')).toMatchObject({ hour: 0 })
		expect(findTime('12pm UTC')).toMatchObject({ hour: 12 })
		expect(findTime('11pm UTC')).toMatchObject({ hour: 23 })
	})

	it('should pick up tomorrow and yesterday', () => {
		expect(findTime('tomorrow 10am CET')?.dayOffset).toBe(1)
		expect(findTime('yesterday at 18:00')?.dayOffset).toBe(-1)
		expect(findTime('18:00')?.dayOffset).toBe(0)
	})

	it('should ignore a number that is not a time', () => {
		expect(findTime('5 people')).toBeNull()
		expect(findTime('PAY-2433')).toBeNull()
		expect(findTime('')).toBeNull()
		expect(findTime('25:00')).toBeNull()
		expect(findTime('13pm UTC')).toBeNull()
	})
})

describe('converting it to my clock', () => {
	const at = (s: string) => Date.parse(s)

	it('should put 3pm in Los Angeles at 3:30am in India the next day', () => {
		const found = findTime('3pm PST')!
		// Mid-morning in Los Angeles: "3pm PST" means later today, there.
		const ms = instantOf(found, found.zone!, at('2026-07-01T18:00:00Z'))!
		expect(timeIn(ms, 'America/Los_Angeles')).toBe('3:00 PM')
		expect(timeIn(ms, 'Asia/Kolkata')).toBe('3:30 AM')
		expect(dayIn(ms, 'Asia/Kolkata')).toBe('Thu 2 Jul')
	})

	it('should land on the same instant whichever side you read it from', () => {
		const found = findTime('09:00 UTC')!
		const ms = instantOf(found, 'UTC', at('2026-07-01T20:00:00Z'))!
		expect(new Date(ms).toISOString()).toBe('2026-07-01T09:00:00.000Z')
	})

	it('should use the zone rules for the date, not for today', () => {
		const found = findTime('9am EST')!
		const jan = instantOf(found, 'America/New_York', at('2026-01-15T12:00:00Z'))!
		const jul = instantOf(found, 'America/New_York', at('2026-07-01T12:00:00Z'))!
		expect(new Date(jan).toISOString()).toBe('2026-01-15T14:00:00.000Z') // UTC-5
		expect(new Date(jul).toISOString()).toBe('2026-07-01T13:00:00.000Z') // UTC-4
	})

	it('should take tomorrow into account', () => {
		const found = findTime('tomorrow 10:00 UTC')!
		const ms = instantOf(found, 'UTC', at('2026-07-01T12:00:00Z'))!
		expect(new Date(ms).toISOString()).toBe('2026-07-02T10:00:00.000Z')
	})

	it('should always say which day, and add the year when it is not this one', () => {
		expect(dayIn(at('2026-07-01T09:00:00Z'), 'UTC', at('2026-07-01T20:00:00Z'))).toBe('Wed 1 Jul')
		expect(dayIn(at('2027-01-04T09:00:00Z'), 'UTC', at('2026-07-01T20:00:00Z'))).toBe('Mon 4 Jan 2027')
	})
})

describe('how far apart two zones are', () => {
	it('should say by how much and which way', () => {
		expect(zoneGap('America/Los_Angeles', 'Asia/Kolkata', summer)).toBe('12h 30m ahead')
		expect(zoneGap('Asia/Kolkata', 'Europe/London', summer)).toBe('4h 30m behind')
		expect(zoneGap('UTC', 'Etc/GMT', summer)).toBe('same time')
		expect(zoneGap('UTC', 'Narnia', summer)).toBe('')
	})
})

describe('whose day a bare time belongs to', () => {
	it("should mean today in the writer's zone, not today in mine", () => {
		const found = findTime('3pm PST')!
		// 06:00 UTC is still the previous evening in Los Angeles, so "3pm" there
		// is the afternoon of that day — not of the date it already is in India.
		const ms = instantOf(found, 'America/Los_Angeles', Date.parse('2026-07-01T06:00:00Z'))!
		expect(new Date(ms).toISOString()).toBe('2026-06-30T22:00:00.000Z')
	})
})

describe('a selected time, explained', () => {
	const now = Date.parse('2026-07-01T18:00:00Z') // 11:30pm in India, 11am in LA
	const mine = 'Asia/Kolkata'

	it('should give my time first, then the zones I watch', () => {
		const c = explain('3pm PST', mine, ['Europe/London'], now)!
		expect(c.read).toBe('3pm PST')
		expect(c.from).toBe('America/Los_Angeles')
		expect(c.assumedZone).toBe(false)
		expect(c.rows.map((r) => [r.label, r.time])).toEqual([
			['Kolkata', '3:30 AM'],
			['London', '11:00 PM'],
			['Los Angeles', '3:00 PM'],
		])
		expect(c.rows[0].mine).toBe(true)
	})

	it('should carry the date for every zone, and flag the ones on another day', () => {
		const c = explain('3pm PST', mine, [], now)!
		expect(c.rows[0]).toMatchObject({ day: 'Thu 2 Jul', otherDay: false }) // mine is the reference
		expect(c.rows.find((r) => r.zone === 'America/Los_Angeles')).toMatchObject({ day: 'Wed 1 Jul', otherDay: true })
	})

	it('should read a bare time as my own, and say that it assumed', () => {
		const c = explain('standup at 09:45', mine, ['America/New_York'], now)!
		expect(c.assumedZone).toBe(true)
		expect(c.from).toBe(mine)
		expect(c.rows.map((r) => r.time)).toEqual(['9:45 AM', '12:15 AM'])
	})

	it('should not list a zone twice, or one the browser does not know', () => {
		const c = explain('10:00 UTC', mine, ['Asia/Kolkata', 'Narnia'], now)!
		expect(c.rows.map((r) => r.zone)).toEqual(['Asia/Kolkata', 'UTC'])
	})

	it('should say nothing when there is no time in the selection', () => {
		expect(explain('PAY-2433 financing', mine, [], now)).toBeNull()
	})
})

describe('the formats a page actually shows', () => {
	const mine = 'Asia/Kolkata'
	const now = Date.parse('2026-10-13T06:00:00Z')
	const read = (s: string) => {
		const c = explain(s, mine, [], now)
		return c && `${c.rows[0].time}${c.rows[0].day ? ` · ${c.rows[0].day}` : ''}`
	}

	it('should read a date with the time and the offset written out', () => {
		// The case that started this: "12" was taken as the hour and it stopped.
		expect(findTime('Oct 12, 17:44 GMT+5:30')).toMatchObject({ hour: 17, minute: 44, zone: 'GMT+5:30', date: { month: 10, day: 12 } })
		expect(read('Oct 12, 17:44 GMT+5:30')).toBe('5:44 PM · Mon 12 Oct')
	})

	it('should read the date however it is written', () => {
		for (const s of ['Oct 12, 2026 17:44 IST', '12 Oct 2026 17:44 IST', '2026-10-12 17:44 IST', '12th October 2026, 17:44 IST']) {
			expect(read(s), s).toBe('5:44 PM · Mon 12 Oct')
		}
	})

	it('should read a slash date only when one number cannot be a month', () => {
		expect(findDate('13/10/2026')).toMatchObject({ month: 10, day: 13 })
		expect(findDate('10/13/2026')).toMatchObject({ month: 10, day: 13 })
		expect(findDate('12/10/2026')).toBeNull() // genuinely ambiguous: left alone
	})

	it('should keep working with a weekday, a comma or an "at" in the way', () => {
		for (const s of ['Mon, Oct 12 at 5:44 pm IST', 'Monday 12 Oct · 17:44 IST', 'Oct 12 2026, 05:44 PM IST']) {
			expect(read(s), s).toBe('5:44 PM · Mon 12 Oct')
		}
	})

	it('should ignore seconds rather than choke on them', () => {
		expect(findTime('17:44:30 IST')).toMatchObject({ hour: 17, minute: 44 })
	})

	it('should read a dotted time only when a zone or am/pm says it is one', () => {
		expect(findTime('5.44 pm IST')).toMatchObject({ hour: 17, minute: 44 })
		expect(findTime('version 1.25')).toBeNull()
		expect(findTime('builds in 2.30')).toBeNull()
	})

	it('should take an offset with a space, a unicode minus, or neither', () => {
		expect(findTime('17:44 GMT +5:30')?.zone).toBe('GMT+5:30')
		expect(findTime('17:44 UTC−5')?.zone).toBe('UTC-5')
		expect(findTime('17:44 +0530')?.zone).toBe('+0530')
	})

	it('should skip over numbers that are not the time and find the one that is', () => {
		expect(findTime('PAY-2433 · 3 comments · 17:44 IST')).toMatchObject({ hour: 17, minute: 44 })
		expect(findTime('8 of 12 done')).toBeNull()
	})

	it('should still read a plain clock time with no date and no zone', () => {
		// No date written means today, and today is still named.
		expect(read('17:44')).toBe('5:44 PM · Tue 13 Oct')
		expect(read('5:44 PM')).toBe('5:44 PM · Tue 13 Oct')
	})
})

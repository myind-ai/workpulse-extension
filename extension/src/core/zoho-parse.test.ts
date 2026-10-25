import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { classify } from './rules'
import { allowed, findError, parseAttendance, parseJobs, parseTimelog, parseToken, parseUserReport, ZohoError } from './zoho-parse'

// Shared with the desktop app's Rust tests.
const fixture = (name: string) =>
	JSON.parse(readFileSync(resolve(process.cwd(), '../src-tauri/fixtures', `${name}.json`), 'utf8'))

describe('write guard', () => {
	it('only posts in the right mode', () => {
		expect(allowed('reminder', 'attendance')).toBe(false)
		expect(allowed('reminder', 'timelog')).toBe(false)
		expect(allowed('timelogs', 'attendance')).toBe(false)
		expect(allowed('timelogs', 'timelog')).toBe(true)
		expect(allowed('full', 'attendance')).toBe(true)
		expect(allowed('full', 'timelog')).toBe(true)
		expect(allowed('', 'timelog')).toBe(false)
	})
})

describe('parsers', () => {
	it('parses an open attendance day', () => {
		const a = parseAttendance(fixture('attendance_entries'))
		expect(a.checkedIn).toBe(true)
		expect(a.checkedOut).toBe(false)
		expect(a.firstIn).toBe('12-10-2026 09:12:05')
		expect(a.lastOut).toBeNull()
		expect(a.totalHours).toBeCloseTo(3.1667, 3)
	})

	it('parses an empty attendance day', () => {
		const a = parseAttendance(fixture('attendance_none'))
		expect(a.checkedIn || a.checkedOut).toBe(false)
	})

	it('parses jobs', () => {
		const jobs = parseJobs(fixture('jobs'))
		expect(jobs).toHaveLength(2)
		expect(jobs[0]).toEqual({ id: '469505000000267001', name: 'Payment service', project: 'Checkout' })
	})

	it('parses the user report and feeds the rules', () => {
		const days = parseUserReport(fixture('user_report'))
		expect(days).toHaveLength(4)
		const kinds = days.map((d) => classify(d, 8, [1, 2, 3, 4, 5])?.kind).filter(Boolean)
		expect(kinds).toEqual(['absent', 'missing_checkout'])
		expect(parseUserReport({ result: [{ employeeDetails: {}, attendanceDetails: fixture('user_report') }] })).toHaveLength(4)
	})

	it('parses timelog success and the holiday error', () => {
		expect(parseTimelog(fixture('timelog_ok'))).toBe('469505000000265019')
		try {
			parseTimelog(fixture('timelog_holiday'))
			throw new Error('expected a ZohoError')
		} catch (e) {
			expect(e).toBeInstanceOf(ZohoError)
			expect((e as ZohoError).code).toBe(8008)
			expect((e as ZohoError).isOffDay).toBe(true)
		}
		expect(new ZohoError('Cannot log time beyond attendance hours').isBeyondAttendance).toBe(true)
	})

	it('parses tokens and token errors', () => {
		expect(parseToken(fixture('token'))).toEqual({ accessToken: '1000.fake.token', expiresIn: 3600 })
		expect(() => parseToken(fixture('token_error'))).toThrow('invalid_code')
	})
})

describe('error detection', () => {
	it('should treat an empty errors list as success', () => {
		expect(parseTimelog({ response: { result: [{ timeLogId: '7' }], errors: [], status: 0 } })).toBe('7')
	})

	it('should still read an error object and an error list', () => {
		expect(findError({ response: { errors: { code: 8008, message: 'Cannot log time during Weekend/Holidays/Leave' } } })?.isOffDay).toBe(true)
		expect(findError({ response: { errors: [{ code: 7038, message: 'Permission denied' }], status: 1 } })?.code).toBe(7038)
	})
})

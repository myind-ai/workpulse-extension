import { describe, expect, it } from 'vitest'

import { ZOHO_AREAS, clientFormValues, consoleUrl, dcFromHost, findClientId, isClientId, isPeopleUrl } from './setup'

const REDIRECT = 'https://eipfgalnomnkdbehopenpiopogejenef.chromiumapp.org/'

describe('guided Zoho setup', () => {
	it('builds the console link and form values for the data centre', () => {
		expect(consoleUrl('in')).toBe('https://api-console.zoho.in/')
		const v = clientFormValues(REDIRECT, 'in')
		expect(v.map((x) => x.value)).toEqual([
			'WorkPulse',
			'https://people.zoho.in',
			REDIRECT,
			'https://eipfgalnomnkdbehopenpiopogejenef.chromiumapp.org',
		])
		expect(v[2].match.test('Authorized Redirect URIs')).toBe(true)
		expect(v[3].match.test('JavaScript Domain')).toBe(true)
	})

	it('finds and validates client ids', () => {
		expect(findClientId('Client ID\n1000.AB12CD34EF56GH78IJ90KL12MN34OP Client Secret')).toBe('1000.AB12CD34EF56GH78IJ90KL12MN34OP')
		expect(findClientId('nothing here 1000.short')).toBeNull()
		expect(isClientId(' 1000.AB12CD34EF56GH78IJ90KL12MN34OP ')).toBe(true)
		expect(isClientId('1000.ab12')).toBe(false)
	})

	it('accepts only Zoho People pages as the attendance page', () => {
		expect(isPeopleUrl('https://people.zoho.in/acme/zp#attendance/entry')).toBe(true)
		expect(isPeopleUrl('http://people.zoho.in/')).toBe(false)
		expect(isPeopleUrl('https://people.zoho.in.evil.com/')).toBe(false)
		expect(dcFromHost('api-console.zoho.com.au')).toBe('com.au')
		expect(dcFromHost('example.com')).toBeNull()
	})
})

import { overlayExempt } from './setup'

describe('overlay never blocks the Zoho page you need', () => {
	it('skips sign-in and console pages for every reminder', () => {
		expect(overlayExempt('https://accounts.zoho.in/signin', 'prompt')).toBe(true)
		expect(overlayExempt('https://api-console.zoho.in/', 'checkin')).toBe(true)
	})
	it('lets you check in and fill the timesheet on Zoho People', () => {
		expect(overlayExempt('https://people.zoho.in/acme/zp#attendance', 'checkin')).toBe(true)
		expect(overlayExempt('https://people.zoho.in/acme/zp#timesheet', 'wrapup')).toBe(true)
		expect(overlayExempt('https://people.zoho.in/acme/zp', 'prompt')).toBe(false)
		expect(overlayExempt('https://example.com/', 'checkin')).toBe(false)
	})
})

describe('the Zoho pages the setup has to cover', () => {
	it('should name each area the way Zoho’s own menu does', () => {
		expect(ZOHO_AREAS.map((a) => a.where)).toEqual([
			'Attendance → Attendance Summary',
			'Time Tracker → Timesheet',
			'Time Tracker → Timesheet → add one row',
			'Attendance → Regularization',
		])
	})

	it('should mark exactly one of them as the thing that writes', () => {
		// Everything else is read-only, which is the promise the whole page path
		// is built on.
		expect(ZOHO_AREAS.filter((a) => !a.readOnly).map((a) => a.id)).toEqual(['save'])
	})

	it('should say what stops working without each one', () => {
		for (const a of ZOHO_AREAS) {
			expect(a.without, a.id).toBeTruthy()
			expect(a.how, a.id).toBeTruthy()
		}
	})
})

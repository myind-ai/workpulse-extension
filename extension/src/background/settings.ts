// Validates a full Settings object before it is saved. Throws a readable error.

import { isHHMM } from '@/core/time'
import { scopesFor, type Settings } from '@/core/types'

const MODES = ['reminder', 'timelogs', 'full']
const DCS = ['in', 'com', 'eu', 'com.au']
const CADENCES = ['hourly', 'interval', 'smart']

export function validateSettings(s: Settings): Settings {
	const fail = (m: string): never => {
		throw new Error(m)
	}
	if (!isHHMM(s.shiftStart) || !isHHMM(s.shiftEnd)) fail('Shift times must be HH:MM (24-hour).')
	if (s.shiftEnd <= s.shiftStart) fail('Shift end must be after shift start.')
	const int = (v: unknown, lo: number, hi: number, name: string) => {
		const n = Number(v)
		if (!Number.isFinite(n) || n < lo || n > hi) fail(`${name} must be between ${lo} and ${hi}.`)
		return n
	}
	const workDays = [...new Set((s.workDays ?? []).map(Number))].filter((d) => d >= 1 && d <= 7).sort()
	if (!workDays.length) fail('Pick at least one work day.')
	if (!MODES.includes(s.zohoMode)) fail('Unknown Zoho mode.')
	if (!DCS.includes(s.dataCenter)) fail('Unknown Zoho data centre.')
	if (!CADENCES.includes(s.promptCadence)) fail('Unknown reminder cadence.')
	if (!/^https:\/\//.test(s.attendanceUrl)) fail('The Zoho attendance page must be an https:// address.')
	const email = s.email.trim()
	if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('That email does not look right.')
	return {
		...s,
		graceMinutes: Math.round(int(s.graceMinutes, 0, 180, 'Grace minutes')),
		promptInterval: Math.round(int(s.promptInterval, 1, 240, 'Prompt interval')),
		minHours: int(s.minHours, 0, 24, 'Minimum hours'),
		wrapupDelay: Math.round(int(s.wrapupDelay ?? 30, 0, 240, 'Wrap-up delay')),
		workDays,
		email,
		oauthClientId: s.oauthClientId.trim(),
		scopes: scopesFor(s.zohoMode),
		billingStatus: s.billingStatus === 'billable' ? 'billable' : 'non-billable',
	}
}

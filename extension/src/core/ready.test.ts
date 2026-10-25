import { describe, expect, it } from 'vitest'

import { FRESH, readiness, type ReadyInput } from './ready'
import { parseIst } from './time'

const NOW = parseIst('2026-10-13T11:00:00')
const input = (patch: Partial<ReadyInput> = {}): ReadyInput => ({
	now: NOW,
	read: { at: NOW - 60_000, firstIn: '09:02', lastOut: null, source: 'page', missing: [] },
	jobs: 12,
	shift: { start: '09:00', end: '18:30', confirmed: true },
	tabOpen: true,
	apiReady: false,
	...patch,
})

const step = (i: ReadyInput, id: string) => readiness(i).steps.find((s) => s.id === id)!

describe('whether it is actually working', () => {
	it('should be ready when it can see your day', () => {
		const r = readiness(input())
		expect(r.ready).toBe(true)
		expect(r.summary).toBe('Everything is set up.')
	})

	it('should say what it found, not what to do', () => {
		expect(step(input(), 'read').detail).toBe('In 09:02 — still in, from the page')
		expect(step(input({ jobs: 12 }), 'jobs').detail).toBe('12 to log time against')
	})

	it('should not count a read from an hour ago as evidence it works now', () => {
		const stale = input({ read: { at: NOW - FRESH - 1000, firstIn: '09:02', lastOut: null } })
		expect(step(stale, 'read').ok).toBe(false)
		expect(step(stale, 'read').detail).toBe('The last read is too old to count')
		expect(readiness(stale).ready).toBe(false)
	})

	it('should count a successful read of a day with no punch yet', () => {
		const early = input({ read: { at: NOW, firstIn: '-', lastOut: null } })
		expect(step(early, 'read').ok).toBe(true)
		expect(step(early, 'read').detail).toBe('Read the page — no punch on it yet today')
	})

	it('should say plainly when there is no tab to read', () => {
		const r = readiness(input({ tabOpen: false }))
		expect(step(input({ tabOpen: false }), 'tab')).toMatchObject({ ok: false, fix: 'openZoho' })
		expect(r.summary).toBe('Not reading your Zoho yet.')
	})

	it('should skip the page entirely when the API is connected', () => {
		const api = input({ apiReady: true, tabOpen: false, read: undefined })
		expect(readiness(api).ready).toBe(true)
		expect(step(api, 'tab').detail).toMatch(/Not needed/)
		expect(step(api, 'read').detail).toBe('Through the Zoho API')
	})

	it('should treat jobs and the shift as improvements, not gates', () => {
		const r = readiness(input({ jobs: 0, shift: { start: '09:00', end: '18:30', confirmed: false } }))
		expect(r.ready).toBe(true)
		expect(r.summary).toBe('Working — 2 optional things left.')
	})

	it('should say the shift it is using when it was never confirmed', () => {
		expect(step(input({ shift: { start: '10:00', end: '19:00', confirmed: false } }), 'shift').detail).toBe('Using 10:00–19:00. Change it if that is not your shift.')
	})

	it('should give every unfinished step exactly one thing to press', () => {
		for (const s of readiness(input({ tabOpen: false, read: undefined, jobs: 0, shift: { start: '09:00', end: '18:30', confirmed: false } })).steps) {
			expect(s.fix, s.id).toBeTruthy()
		}
	})
})

import { describe, expect, it } from 'vitest'

import { gate, isPro, unavailable, type Licence } from './licence'

const free: Licence = { tier: 'free' }
const pro: Licence = { tier: 'pro', key: 'k' }

describe('licence', () => {
	it('should treat a missing licence as free', () => {
		expect(isPro(undefined)).toBe(false)
		expect(isPro(free)).toBe(false)
		expect(isPro(pro)).toBe(true)
	})

	it('should never withhold a local feature from the free tier', () => {
		for (const f of ['record', 'overtime', 'calibration', 'handover', 'briefing'] as const) {
			expect(gate(f, free).allowed).toBe(true)
		}
	})

	it('should ask once about a local feature, and name it', () => {
		const v = gate('calibration', free)
		expect(v.nag).toContain('How long things really take you')
		expect(v.nag).toContain('working anyway')
		expect(v.nagKey).toBe('wp-nag-calibration')
	})

	it('should refuse a served feature, because the refusal is the server declining work', () => {
		expect(gate('hostedBackup', free).allowed).toBe(false)
		expect(gate('support', free).allowed).toBe(false)
	})

	it('should never nag somebody who has paid', () => {
		for (const f of ['record', 'overtime', 'hostedBackup', 'support'] as const) {
			expect(gate(f, pro)).toEqual({ allowed: true })
		}
	})

	it('should point a refused backup at the free path rather than only at the price', () => {
		expect(unavailable('hostedBackup')).toContain('repository you own is free')
	})

	it('should say nothing about a local feature being unavailable, because it is not', () => {
		expect(unavailable('record')).toBe('')
	})
})

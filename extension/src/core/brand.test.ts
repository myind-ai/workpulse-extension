import { describe, expect, it } from 'vitest'

import { heartColour, pitch } from './brand'
import { parseIst } from './time'

const urls = { source: 'https://github.com/me/workpulse', sponsor: 'https://github.com/sponsors/me', author: 'https://github.com/me', name: 'Someone' }

describe('the heart', () => {
	it('should hold its colour for the hour, then change', () => {
		const a = heartColour(parseIst('2026-10-13T10:00:00'))
		expect(heartColour(parseIst('2026-10-13T10:59:00'))).toBe(a)
		expect(heartColour(parseIst('2026-10-13T11:00:00'))).not.toBe(a)
	})

	it('should be the same for the same hour, so it is a clock and not a flash', () => {
		expect(heartColour(parseIst('2026-10-13T10:30:00'))).toBe(heartColour(parseIst('2026-10-13T10:30:00')))
	})

	it('should come back round rather than run out', () => {
		const seen = new Set(Array.from({ length: 48 }, (_, i) => heartColour(parseIst('2026-10-13T00:00:00') + i * 3_600_000)))
		expect(seen.size).toBeGreaterThan(5)
	})

	it('should cope with a time before the epoch rather than index out of the palette', () => {
		expect(heartColour(-5 * 3_600_000)).toMatch(/^#[0-9a-f]{6}$/)
	})
})

describe('the line that changes', () => {
	const at = (s: string) => pitch(parseIst(s), urls)

	it('should say something different as the hours pass', () => {
		const four = [at('2026-10-13T09:30:00'), at('2026-10-13T10:30:00'), at('2026-10-13T11:30:00'), at('2026-10-13T12:30:00')]
		expect(new Set(four.map((p) => p.kind)).size).toBe(4)
	})

	it('should hold still within the hour', () => {
		expect(at('2026-10-13T09:05:00')).toEqual(at('2026-10-13T09:55:00'))
	})

	it('should never beg', () => {
		for (let h = 0; h < 24; h++) {
			const p = pitch(h * 3_600_000, urls)
			expect(p.text, p.text).not.toMatch(/please|help us|we need|support us so/i)
			expect(p.href).toMatch(/^https:\/\//)
			expect(p.cta.length).toBeLessThan(16)
		}
	})

	it('should carry the author’s own name', () => {
		const day = Array.from({ length: 24 }, (_, h) => pitch(parseIst(`2026-10-13T${String(h).padStart(2, '0')}:30:00`), urls))
		expect(day.find((p) => p.kind === 'author')).toMatchObject({ text: 'Made by Someone.' })
	})
})

describe('changing on every page load as well as every hour', () => {
	const now = parseIst('2026-10-13T10:30:00')

	it('should give a different colour for a different load', () => {
		const seen = new Set(Array.from({ length: 10 }, (_, i) => heartColour(now, i)))
		expect(seen.size).toBeGreaterThan(5)
	})

	it('should hold still for the life of one load', () => {
		// Nothing on screen may flicker between colours while you look at it.
		expect(heartColour(now, 7)).toBe(heartColour(now, 7))
		expect(heartColour(now + 60_000, 7)).toBe(heartColour(now, 7))
	})

	it('should rotate the line on a reload too', () => {
		const kinds = new Set(Array.from({ length: 8 }, (_, i) => pitch(now, urls, i).kind))
		expect(kinds.size).toBe(4)
	})

	it('should still be a valid colour for any seed', () => {
		for (const seed of [0, 1, 999, 1000]) expect(heartColour(now, seed)).toMatch(/^#[0-9a-f]{6}$/)
	})
})

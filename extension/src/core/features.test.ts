import { afterEach, describe, expect, it } from 'vitest'

import { enabled, FEATURES } from './features'

describe('feature switches', () => {
	afterEach(() => {
		delete process.env.WXT_FEATURE_TICK
	})

	it('is on when nothing says otherwise', () => {
		for (const f of Object.keys(FEATURES) as (keyof typeof FEATURES)[]) expect(enabled(f)).toBe(true)
	})

	it('turns off on false, 0 or off, in any case', () => {
		for (const v of ['false', '0', 'off', 'FALSE', ' Off ']) {
			process.env.WXT_FEATURE_TICK = v
			expect(enabled('TICK')).toBe(false)
		}
	})

	it('stays on for anything else', () => {
		process.env.WXT_FEATURE_TICK = 'true'
		expect(enabled('TICK')).toBe(true)
	})
})

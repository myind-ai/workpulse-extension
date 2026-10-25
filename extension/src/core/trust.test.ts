import { describe, expect, it } from 'vitest'

import { API_ENABLED } from './features'
import { ALWAYS, NEVER, ON_REQUEST, trustLine } from './trust'

describe('what WorkPulse can see', () => {
	it('should hold nothing at install that is not needed to ask one question an hour', () => {
		// If this list grows, the install prompt grew — which is a product
		// decision, not an implementation detail.
		const base = ['alarms', 'contextMenus', 'idle', 'notifications', 'offscreen', 'scripting', 'storage', 'tabs', 'unlimitedStorage']
		// `identity` exists only where the official Zoho API path is switched
		// on, exactly as in wxt.config.ts. The panel must track the manifest in
		// BOTH builds: naming a permission that is not held is as wrong as
		// hiding one that is.
		expect(ALWAYS.map((c) => c.id).sort()).toEqual([...base, ...(API_ENABLED ? ['identity'] : [])].sort())
	})

	it('should explain that a Zoho password never reaches WorkPulse, where sign-in exists', () => {
		const id = ALWAYS.find((c) => c.id === 'identity')
		if (!API_ENABLED) return expect(id).toBeUndefined()
		expect(id?.why).toContain('never reaches WorkPulse')
	})

	it('should keep every invasive capability out of the install prompt', () => {
		for (const id of ['desktopCapture', 'history', 'webRequest']) {
			expect(ON_REQUEST.some((c) => c.id === id && c.optional)).toBe(true)
			expect(ALWAYS.some((c) => c.id === id)).toBe(false)
		}
	})

	it('should explain each one by what it does, not by what Chrome calls it', () => {
		for (const c of [...ALWAYS, ...ON_REQUEST]) {
			expect(c.does.length).toBeGreaterThan(20)
			expect(c.why.length).toBeGreaterThan(20)
		}
	})

	it('should promise the things that are actually true of the manifest', () => {
		const all = NEVER.join(' ').toLowerCase()
		expect(all).toContain('no server')
		expect(all).toContain('no manager dashboard')
		expect(all).toContain('no keystrokes')
		expect(all).toContain('no analytics')
	})

	it('should not tell somebody about a capability they have never granted', () => {
		expect(trustLine([])).toContain('holding nothing beyond')
		expect(trustLine([])).not.toContain('recording')
	})

	it('should name what has been granted, and say it can be taken back', () => {
		const line = trustLine(['desktopCapture'])
		expect(line).toContain('recording a screen')
		expect(line).toContain('taken back')
	})
})

import { describe, expect, it, vi } from 'vitest'

import { liftToTopLayer, trapFocus } from './top-layer'

const host = (showPopover?: () => void) => {
	const el = document.createElement('div')
	el.style.cssText = 'z-index:2147483647'
	if (showPopover) Object.assign(el, { showPopover })
	return el as HTMLElement
}

describe('getting above a website’s own modal', () => {
	it('should join the top layer, because no z-index can beat one', () => {
		const show = vi.fn()
		const el = host(show)
		expect(liftToTopLayer(el)).toBe(true)
		expect(show).toHaveBeenCalledOnce()
		expect(el.getAttribute('popover')).toBe('manual')
	})

	it('should undo the box a popover is given for free', () => {
		// A popover is a centred, fit-content box with a border and a
		// background. Right for a tooltip, wrong for a full-screen overlay.
		const el = host(() => undefined)
		liftToTopLayer(el)
		for (const style of ['position:fixed', 'inset:0', 'border:0', 'background:transparent']) {
			expect(el.style.cssText.replace(/\s/g, '')).toContain(style)
		}
	})

	it('should keep the z-index it already had, as the fallback', () => {
		const el = host(() => undefined)
		liftToTopLayer(el)
		expect(el.style.cssText).toContain('2147483647')
	})

	it('should do nothing at all where there is no top layer', () => {
		const el = host()
		expect(liftToTopLayer(el)).toBe(false)
		expect(el.hasAttribute('popover')).toBe(false)
	})

	it('should leave no half-applied popover when showing throws', () => {
		const el = host(() => {
			throw new Error('already showing')
		})
		expect(liftToTopLayer(el)).toBe(false)
		expect(el.hasAttribute('popover')).toBe(false)
	})
})

describe('keeping the keyboard inside', () => {
	const mount = () => {
		const host = document.createElement('div')
		document.body.append(host)
		const outside = document.createElement('button')
		document.body.append(outside)
		return { host, outside }
	}

	it('should take focus back when it escapes to the page behind', () => {
		const { host, outside } = mount()
		const undo = trapFocus(host)
		const pulled = vi.spyOn(host, 'focus')
		outside.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
		expect(pulled).toHaveBeenCalled()
		undo()
	})

	it('should leave focus alone while it is still inside', () => {
		const { host } = mount()
		const undo = trapFocus(host)
		const pulled = vi.spyOn(host, 'focus')
		host.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
		expect(pulled).not.toHaveBeenCalled()
		undo()
	})

	it('should make the host focusable, so there is somewhere to put it back', () => {
		const { host } = mount()
		const undo = trapFocus(host)
		expect(host.getAttribute('tabindex')).toBe('-1')
		undo()
	})

	it('should stop guarding once undone — a listener outliving its overlay is a leak', () => {
		const { host, outside } = mount()
		trapFocus(host)()
		const pulled = vi.spyOn(host, 'focus')
		outside.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
		expect(pulled).not.toHaveBeenCalled()
	})
})

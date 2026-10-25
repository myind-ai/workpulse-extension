import { describe, expect, it, vi } from 'vitest'

import { isDismissKey, isPaletteChord, isPaletteKey, onOpenPalette, openPalette } from './palette-open'

const key = (p: Partial<KeyboardEvent>) => ({ metaKey: false, ctrlKey: false, altKey: false, ...p }) as KeyboardEvent

describe('out on somebody else’s page', () => {
	it('should take Alt+Shift+K, which nothing else wants', () => {
		expect(isPaletteChord(key({ code: 'KeyK', altKey: true, shiftKey: true }))).toBe(true)
		// ⌥K on a Mac types ˚, so the physical key is the only reliable half.
		expect(isPaletteChord(key({ key: '˚', code: 'KeyK', altKey: true, shiftKey: true }))).toBe(true)
	})

	it('should never take ⌘K out there — it belongs to half the web', () => {
		// Slack, Linear, Notion, GitHub. An extension that claims it claims it on
		// every page, for ever.
		expect(isPaletteChord(key({ key: 'k', metaKey: true }))).toBe(false)
		expect(isPaletteChord(key({ key: 'k', ctrlKey: true, shiftKey: true }))).toBe(false)
		expect(isPaletteChord(key({ key: 'k', altKey: true }))).toBe(false) // shift too
	})
})

describe('is this the keystroke', () => {
	it('should take ⌘K and ⌃K, with or without shift', () => {
		expect(isPaletteKey(key({ key: 'k', metaKey: true }))).toBe(true)
		expect(isPaletteKey(key({ key: 'K', metaKey: true, shiftKey: true }))).toBe(true)
		expect(isPaletteKey(key({ key: 'k', ctrlKey: true }))).toBe(true)
	})

	it('should fall back to the physical key when the layout gives nothing useful', () => {
		// A dead layout, or a synthetic event with no `key` on it.
		expect(isPaletteKey(key({ code: 'KeyK', metaKey: true }))).toBe(true)
	})

	it('should leave alone anything that is not it', () => {
		expect(isPaletteKey(key({ key: 'k' }))).toBe(false)
		expect(isPaletteKey(key({ key: 'j', metaKey: true }))).toBe(false)
		// ⌥⌘K is a different shortcut somewhere else; do not steal it.
		expect(isPaletteKey(key({ key: 'k', metaKey: true, altKey: true }))).toBe(false)
	})
})

describe('one opener everything goes through', () => {
	it('should reach a listener, and stop reaching it once it is let go', () => {
		const saw = vi.fn()
		const off = onOpenPalette(saw)
		openPalette()
		expect(saw).toHaveBeenCalledTimes(1)
		off()
		openPalette()
		expect(saw).toHaveBeenCalledTimes(1)
	})

	it('should not depend on the key handler, which is the whole point', () => {
		// The button used to fire a synthetic ⌘K, so the thing meant to rescue a
		// broken shortcut was broken in exactly the same way.
		const saw = vi.fn()
		const off = onOpenPalette(saw)
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
		expect(saw).not.toHaveBeenCalled()
		openPalette()
		expect(saw).toHaveBeenCalled()
		off()
	})
})

describe('closing it again', () => {
	it('should close on Escape, whatever is held down with it', () => {
		expect(isDismissKey(key({ key: 'Escape' }))).toBe(true)
		// A box that opens from a keystroke and cannot be closed by one is a box
		// people stop opening — so nothing about the modifiers may block it.
		expect(isDismissKey(key({ key: 'Escape', shiftKey: true }))).toBe(true)
		expect(isDismissKey(key({ key: 'Escape', metaKey: true }))).toBe(true)
	})

	it('should not close on anything else', () => {
		expect(isDismissKey(key({ key: 'Enter' }))).toBe(false)
		expect(isDismissKey(key({ key: 'Esc' }))).toBe(false)
	})
})

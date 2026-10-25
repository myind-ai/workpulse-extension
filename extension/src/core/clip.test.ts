import { describe, expect, it } from 'vitest'

import { BACKUP_MAX_BYTES, BITS_PER_SECOND, clipLength, clipName, clipSize, clipsToKeep, clipUsable, KEEP_CLIPS, MAX_BYTES } from './clip'

describe('a clip of the tab', () => {
	it('should read its length the way anyone says it', () => {
		expect(clipLength(18_400)).toBe('0:18')
		expect(clipLength(72_000)).toBe('1:12')
	})

	it('should say its size in the unit that fits', () => {
		expect(clipSize(3_400_000)).toBe('3.4 MB')
		expect(clipSize(420_000)).toBe('420 KB')
	})

	it('should refuse what the recorder got wrong', () => {
		expect(clipUsable({ ms: 8000, bytes: 2_000_000 })).toBe(true)
		expect(clipUsable({ ms: 100, bytes: 2000 })).toBe(false) // a mis-click
		expect(clipUsable({ ms: 8000, bytes: 10 })).toBe(false) // nothing recorded
		expect(clipUsable({ ms: 8000, bytes: MAX_BYTES + 1 })).toBe(false)
	})
})

describe('which clips are kept', () => {
	const note = (i: number, shared = false) => ({ at: i, clip: { id: `c${i}` }, shared: shared ? {} : undefined })

	it('should keep the newest few, because each is twenty screenshots', () => {
		const keep = clipsToKeep(Array.from({ length: 20 }, (_, i) => note(i)))
		expect(keep).toHaveLength(KEEP_CLIPS)
		expect(keep).toContain('c19')
		expect(keep).not.toContain('c0')
	})

	it('should never drop one somebody else is relying on', () => {
		// Shared means it is in an issue with a link to it: dropping it locally is
		// fine, but it is kept here first.
		const notes = [note(0, true), ...Array.from({ length: 20 }, (_, i) => note(i + 1))]
		expect(clipsToKeep(notes)).toContain('c0')
	})

	it('should keep nothing when there is nothing', () => {
		expect(clipsToKeep([])).toEqual([])
	})
})

describe('long recordings', () => {
	it('should keep a ten-minute recording rather than dropping it as too big', () => {
		const tenMinutes = { ms: 600_000, bytes: (BITS_PER_SECOND / 8) * 600 }
		expect(clipUsable(tenMinutes)).toBe(true)
		expect(clipLength(tenMinutes.ms)).toBe('10:00')
	})

	it('should keep a long recording out of the git backup', () => {
		expect((BITS_PER_SECOND / 8) * 600).toBeGreaterThan(BACKUP_MAX_BYTES)
		expect((BITS_PER_SECOND / 8) * 20).toBeLessThan(BACKUP_MAX_BYTES)
	})
})

describe('what a recording is called once it leaves', () => {
	it('should name the file by when it was taken, not "recording (3)"', () => {
		const name = clipName({ id: 'a1b2c3d4', at: new Date(2026, 9, 16, 9, 18).getTime() })
		expect(name).toBe('workpulse-2026-10-16-0918-a1b2')
	})
})

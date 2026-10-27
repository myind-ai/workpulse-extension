import { describe, expect, it } from 'vitest'

import { dueForCheck, newer, readRelease, updateNotice } from './update'

describe('newer', () => {
	it('compares part by part, not as text', () => {
		expect(newer('1.10.0', '1.9.2')).toBe(true)
		expect(newer('v1.4.0', '1.3.0')).toBe(true)
		expect(newer('1.3.0', '1.3.0')).toBe(false)
		expect(newer('1.3', '1.3.0')).toBe(false)
		expect(newer('1.2.9', '1.3.0')).toBe(false)
	})
})

describe('readRelease', () => {
	const gh = { tag_name: 'v1.4.0', html_url: 'https://github.com/x/releases/tag/v1.4.0', published_at: '2026-10-28T10:00:00Z', body: '## Title\n\n### New\n- **One** thing\n- Two\nplain words\n', assets: [{ browser_download_url: 'https://x/workpulse-extension-1.4.0-chrome.zip' }] }
	it('reads the version, page, zip and the bullet lines of the notes', () => {
		expect(readRelease(gh)).toEqual({ version: '1.4.0', url: gh.html_url, notes: '### New\n- **One** thing\n- Two', at: Date.parse('2026-10-28T10:00:00Z'), zip: 'https://x/workpulse-extension-1.4.0-chrome.zip' })
	})
	it('ignores drafts, prereleases, odd tags and error bodies', () => {
		expect(readRelease({ ...gh, draft: true })).toBeNull()
		expect(readRelease({ ...gh, prerelease: true })).toBeNull()
		expect(readRelease({ ...gh, tag_name: 'nightly' })).toBeNull()
		expect(readRelease({ message: 'API rate limit exceeded' })).toBeNull()
	})
})

describe('updateNotice', () => {
	const latest = { version: '1.4.0', url: 'u', notes: '' }
	it('says a newer one is out until that version is dismissed', () => {
		expect(updateNotice({ current: '1.3.0', latest })).toEqual({ kind: 'available', release: latest })
		expect(updateNotice({ current: '1.3.0', latest, dismissed: '1.4.0' })).toBeNull()
		expect(updateNotice({ current: '1.4.0', latest })).toBeNull()
	})
	it('says it was updated, once, right after', () => {
		expect(updateNotice({ current: '1.4.0', seen: '1.3.0' })).toEqual({ kind: 'updated', from: '1.3.0' })
		expect(updateNotice({ current: '1.4.0', seen: '1.4.0' })).toBeNull()
	})
	it('checks once a day', () => {
		expect(dueForCheck(undefined, 5)).toBe(true)
		expect(dueForCheck(0, 86_399_999)).toBe(false)
		expect(dueForCheck(0, 86_400_000)).toBe(true)
	})
})

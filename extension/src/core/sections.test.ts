import { describe, expect, it } from 'vitest'

import { findSections, SECTIONS } from './sections'

const titles = (q: string) => findSections(q).map((s) => s.title)

describe('finding a section by name', () => {
	it('should find a page by its own name', () => {
		expect(titles('regularisation')[0]).toBe('Regularisation')
		expect(titles('timesheet')[0]).toBe('Review & timesheet')
	})

	it('should find a settings section rather than the whole page', () => {
		expect(titles('backup')[0]).toBe('Backup to GitHub')
		expect(titles('meeting')[0]).toBe('Meetings that repeat')
		expect(titles('prefix')[0]).toBe('Ticket prefixes')
	})

	it('should find it by a word the title does not contain', () => {
		expect(titles('sound')).toContain('Alarms & nudges')
		expect(titles('water')).toContain('Reminders')
		expect(titles('sponsor')).toContain('Sponsor & source')
		expect(titles('jira')).toContain('Ticket prefixes')
	})

	it('should need every word', () => {
		expect(titles('github token')).toContain('Backup to GitHub')
		expect(titles('github biscuits')).toEqual([])
	})

	it('should say nothing when nothing was typed', () => {
		expect(findSections('')).toEqual([])
		expect(findSections('   ')).toEqual([])
	})

	it('should land on the page with the right filter', () => {
		expect(findSections('backup')[0].hash).toBe('#/settings/backup')
		expect(findSections('learnings')[0].hash).toBe('#/journal')
	})

	it('should carry a page name for every section, for grouping', () => {
		for (const s of SECTIONS) {
			expect(s.page, s.title).toBeTruthy()
			expect(s.hash.startsWith('#/'), s.title).toBe(true)
		}
	})
})

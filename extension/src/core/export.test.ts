import { describe, expect, it } from 'vitest'

import { cell, csv, fileName, learningsCsv, learningsMarkdown, timesheet, timesheetCsv } from './export'
import type { Learning } from './learn'
import type { Entry } from './types'

describe('CSV cells', () => {
	it('should leave a plain value alone', () => {
		expect(cell('ci broke')).toBe('ci broke')
		expect(cell(42)).toBe('42')
		expect(cell(null)).toBe('')
	})

	it('should quote anything a reader would misread', () => {
		expect(cell('a,b')).toBe('"a,b"')
		expect(cell('say "hi"')).toBe('"say ""hi"""')
		expect(cell('two\nlines')).toBe('"two\nlines"')
		expect(cell(' padded ')).toBe('" padded "')
	})

	it('should write a file Excel opens correctly', () => {
		const out = csv(['A', 'B'], [[1, 'x,y']])
		expect(out.startsWith('﻿')).toBe(true) // UTF-8 BOM
		expect(out).toContain('A,B\r\n1,"x,y"')
	})
})

const learning = (patch: Partial<Learning>): Learning => ({
	id: 'x',
	date: '2026-10-13',
	at: Date.parse('2026-10-13T10:00:00Z'),
	kind: 'mistake',
	text: '',
	tags: [],
	...patch,
})

describe('learnings out', () => {
	const items = [
		learning({ text: 'Cleared the cache after a migration #mysql', tags: ['mysql'], date: '2026-10-13' }),
		learning({ text: 'Zoho needs the CSRF token in the body, not the header', kind: 'learning', date: '2026-10-12', ticketId: 'abc' }),
	]

	it('should write a CSV a spreadsheet can group by tag', () => {
		const out = learningsCsv(items)
		expect(out).toContain('Date,Kind,Tags,Note,Ticket')
		expect(out).toContain('2026-10-13,Mistake,#mysql,Cleared the cache after a migration,')
		expect(out).toContain('2026-10-12,Learned,,"Zoho needs the CSRF token in the body, not the header",abc')
	})

	it('should write Markdown grouped by day, newest first', () => {
		const md = learningsMarkdown(items)
		expect(md.indexOf('## 2026-10-13')).toBeLessThan(md.indexOf('## 2026-10-12'))
		expect(md).toContain('### Mistake · #mysql')
		expect(md).toContain('### Learned')
	})

	it('should keep a multi-line note on one CSV line, readably', () => {
		const out = learningsCsv([learning({ text: '## What broke\n\n- the index was missing' })])
		expect(out).toContain('## What broke · - the index was missing')
		expect(out.split('\r\n').filter(Boolean)).toHaveLength(2) // header + one row
	})
})

describe('the timesheet out', () => {
	const entry = (patch: Partial<Entry>): Entry => ({
		uid: 'e1',
		synced: false,
		date: '2026-10-13',
		slotStart: Date.parse('2026-10-13T03:30:00Z'),
		slotEnd: Date.parse('2026-10-13T04:30:00Z'),
		minutes: 60,
		text: 'wrote the parser',
		kind: 'work',
		...patch,
	})

	it('should name the job rather than its id', () => {
		const out = timesheetCsv([entry({ jobId: 'j1' })], [{ id: 'j1', name: 'Platform', project: 'Core' }])
		expect(out).toContain('60,01:00,work,Platform,wrote the parser')
	})

	it('should leave the job empty when there is none', () => {
		expect(timesheetCsv([entry({})], [])).toContain(',work,,wrote the parser')
	})
})

describe('file names', () => {
	it('should say what it is and when', () => {
		expect(fileName('learnings', 'md', '2026-10-13')).toBe('workpulse-learnings-2026-10-13.md')
	})
})

describe('a timesheet in whatever shape the tool wants', () => {
	const rows = [
		{ job: 'Payments', minutes: 105, description: 'wrote the parser; reviewed the PR', key: 'PAY-2433' },
		{ job: 'Internal', minutes: 30, description: 'Daily standup, and release planning' },
	]

	it('should write Clockify’s columns in Clockify’s order', () => {
		const out = timesheet(rows, 'clockify', '2026-10-12')
		expect(out).toContain('Project,Client,Description,Task,Billable,Start Date')
		expect(out).toContain('Payments,,wrote the parser; reviewed the PR,PAY-2433,Yes,2026-10-12,,2026-10-12,,01:45:00,1.75')
	})

	it('should write Harvest’s decimal hours', () => {
		expect(timesheet(rows, 'harvest', '2026-10-12')).toContain('2026-10-12,,Payments,PAY-2433,wrote the parser; reviewed the PR,1.75')
	})

	it('should write Tempo’s seconds, keyed by the issue', () => {
		expect(timesheet(rows, 'tempo', '2026-10-12')).toContain('PAY-2433,2026-10-12,6300,wrote the parser; reviewed the PR')
	})

	it('should quote a description with a comma in it, in every CSV it writes', () => {
		for (const f of ['clockify', 'harvest', 'tempo', 'csv'] as const) {
			expect(timesheet(rows, f, '2026-10-12'), f).toContain('"Daily standup, and release planning"')
		}
	})

	it('should write a Markdown table that survives a pipe in the text', () => {
		const out = timesheet([{ job: 'A', minutes: 60, description: 'this | that' }], 'markdown', '2026-10-12')
		expect(out).toContain('| A | 01:00 | this \\| that |')
	})

	it('should write plain text for a chat message', () => {
		expect(timesheet(rows, 'text', '2026-10-12')).toContain('01:45  Payments (PAY-2433) — wrote the parser; reviewed the PR')
	})
})

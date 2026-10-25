import { describe, expect, it } from 'vitest'

import { standup, standupDate, standupText, type StandupInput } from './standup'
import { istWeekday, parseIst, atIst } from './time'
import type { Entry, Task } from './types'

const entry = (date: string, from: string, text: string, minutes: number, jobId?: string): Entry => ({
	uid: `${date}${from}`,
	date,
	slotStart: parseIst(`${date}T${from}:00`),
	slotEnd: parseIst(`${date}T${from}:00`) + minutes * 60_000,
	text,
	jobId,
	minutes,
	kind: 'work',
	synced: false,
})

const task = (title: string, patch: Partial<Task> = {}): Task => ({ uid: title, title, status: 'todo', createdAt: 1, spentMinutes: 0, ...patch })

const input = (patch: Partial<StandupInput> = {}): StandupInput => ({
	entries: [
		entry('2026-10-12', '09:00', 'PAY-2433: wrote the parser', 60, 'j1'),
		entry('2026-10-12', '10:00', 'PAY-2433 reviewed the PR', 45, 'j1'),
		entry('2026-10-12', '11:00', 'Daily standup and release planning', 30, 'j2'),
		entry('2026-10-13', '09:00', 'today, not yesterday', 60, 'j1'),
	],
	jobs: [
		{ id: 'j1', name: 'Payments', project: 'Core' },
		{ id: 'j2', name: 'Internal', project: 'Core' },
	],
	tasks: [task('Finish the review comments', { key: 'PAY-2433', priority: 'high' }), task('Waiting on staging credentials', { blocked: true }), task('Old note', { kind: 'note' })],
	tickets: [{ name: 'PAY-2433 financing button' }],
	...patch,
})

describe('what the standup says', () => {
	const s = () => standup(input(), '2026-10-12')

	it('should group by the thing worked on, not by the hour', () => {
		expect(s().yesterday.map((l) => [l.label, l.minutes])).toEqual([
			['PAY-2433', 105],
			['Internal', 30],
		])
	})

	it('should keep what you said, in the order you said it', () => {
		expect(s().yesterday[0].said).toEqual(['wrote the parser', 'reviewed the PR'])
	})

	it('should not repeat the ticket key in every line under its own heading', () => {
		expect(s().yesterday[0].said.join(' ')).not.toContain('PAY-2433')
	})

	it('should take the ticket key over the job name, since that is what people recognise', () => {
		expect(s().yesterday[0].label).toBe('PAY-2433')
		expect(s().yesterday[1].label).toBe('Internal') // no key in the text: the job stands in
	})

	it('should leave other days out of it', () => {
		expect(s().minutes).toBe(135)
	})

	it('should put the blocked work under Blocked, not under Today', () => {
		expect(s().today).toEqual(['PAY-2433 — Finish the review comments'])
		expect(s().blocked).toEqual(['Waiting on staging credentials'])
	})

	it('should leave saved links out — they are not tasks', () => {
		expect(s().today.join(' ')).not.toContain('Old note')
	})

	it('should show at most three things for today', () => {
		const many = input({ tasks: Array.from({ length: 9 }, (_, i) => task(`Task ${i}`)) })
		expect(standup(many, '2026-10-12').today).toHaveLength(3)
	})

	it('should put high priority first', () => {
		const mixed = input({ tasks: [task('Low', { priority: 'low' }), task('High', { priority: 'high' }), task('Normal')] })
		expect(standup(mixed, '2026-10-12').today).toEqual(['High', 'Normal', 'Low'])
	})
})

describe('the text you paste', () => {
	const s = standup(input(), '2026-10-12')

	it('should be Slack-shaped by default', () => {
		const text = standupText(s)
		expect(text).toContain('*Yesterday*')
		expect(text).toContain('• PAY-2433 · 1h 45m — wrote the parser; reviewed the PR')
		expect(text).toContain('*Today*')
		expect(text).toContain('*Blocked*')
	})

	it('should be Markdown when a document wants it', () => {
		expect(standupText(s, 'markdown')).toContain('**Yesterday**')
		expect(standupText(s, 'markdown')).toContain('- PAY-2433')
	})

	it('should be plain when neither is wanted', () => {
		const text = standupText(s, 'plain')
		expect(text).toContain('Yesterday\n')
		expect(text).not.toContain('*')
	})

	it('should leave Blocked out when nothing is blocked', () => {
		const none = standup(input({ tasks: [task('Something')] }), '2026-10-12')
		expect(standupText(none)).not.toContain('Blocked')
	})

	it('should say so rather than print an empty heading', () => {
		const empty = standup(input({ entries: [], tasks: [] }), '2026-10-12')
		expect(standupText(empty)).toContain('Nothing logged.')
		expect(standupText(empty)).toContain('Nothing planned yet.')
	})
})

describe('which day the standup is about', () => {
	const weekdayOf = (date: string) => istWeekday(atIst(date, '12:00'))

	it('should be yesterday on an ordinary day', () => {
		expect(standupDate('2026-10-13', [1, 2, 3, 4, 5], weekdayOf)).toBe('2026-10-12')
	})

	it('should be Friday on a Monday', () => {
		expect(standupDate('2026-10-12', [1, 2, 3, 4, 5], weekdayOf)).toBe('2026-10-09')
	})

	it('should follow whatever days you actually work', () => {
		expect(standupDate('2026-10-13', [2, 3, 4, 5, 6], weekdayOf)).toBe('2026-10-10') // Saturday
	})
})

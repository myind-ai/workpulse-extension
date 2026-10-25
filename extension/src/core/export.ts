// Your own data out, in two shapes: Markdown to read or paste into a document,
// CSV to open in a spreadsheet. Pure string building — the file is written by
// whichever page asked for it.

import { KIND_LABEL, withoutTags, type Learning } from './learn'
import { hhmm } from './time'
import type { Entry, Job } from './types'

/** One CSV cell, quoted when it has to be. */
export function cell(value: unknown): string {
	const s = value == null ? '' : String(value)
	// A comma, a quote, a newline or leading space all change what a reader sees.
	return /[",\n\r]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function csv(header: string[], rows: unknown[][]): string {
	// \r\n and a BOM: what Excel needs to open a UTF-8 file without mangling it.
	return `﻿${[header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`
}

export function learningsCsv(items: Learning[]): string {
	return csv(
		['Date', 'Kind', 'Tags', 'Note', 'Ticket'],
		items.map((i) => [i.date, KIND_LABEL[i.kind], i.tags.map((t) => `#${t}`).join(' '), oneLine(i.text), i.ticketId ?? '']),
	)
}

/** A document, grouped by day, newest first — for a notebook or a 1:1. */
export function learningsMarkdown(items: Learning[], title = 'Learnings & mistakes'): string {
	const days = [...new Set(items.map((i) => i.date))].sort((a, b) => b.localeCompare(a))
	const out = [`# ${title}`, '']
	for (const date of days) {
		out.push(`## ${date}`, '')
		for (const i of items.filter((x) => x.date === date)) {
			out.push(`### ${KIND_LABEL[i.kind]}${i.tags.length ? ` · ${i.tags.map((t) => `#${t}`).join(' ')}` : ''}`, '', i.text.trim(), '')
		}
	}
	return out.join('\n')
}

/** The timesheet as logged, for a spreadsheet or an appraisal. */
export function timesheetCsv(entries: Entry[], jobs: Job[]): string {
	const names = new Map(jobs.map((j) => [j.id, j.name]))
	return csv(
		['Date', 'From', 'To', 'Minutes', 'Hours', 'Kind', 'Job', 'What'],
		entries.map((e) => [
			e.date,
			new Date(e.slotStart).toISOString(),
			new Date(e.slotEnd).toISOString(),
			e.minutes,
			hhmm(e.minutes),
			e.kind,
			e.jobId ? (names.get(e.jobId) ?? e.jobId) : '',
			oneLine(e.text),
		]),
	)
}

// Lines become " · " before the tags come off: withoutTags collapses runs of
// whitespace, which would otherwise eat the line breaks it should have marked.
const oneLine = (s: string) => {
	const flat = (s ?? '').replace(/\s*\n+\s*/g, ' · ').trim()
	return withoutTags(flat) || flat
}

/** `workpulse-learnings-2026-10-13.md` */
export const fileName = (what: string, ext: string, date: string) => `workpulse-${what}-${date}.${ext}`

// ── a timesheet anybody's tool will take ────────────────────────────────────

export type SheetFormat = 'clockify' | 'harvest' | 'tempo' | 'csv' | 'markdown' | 'text'

export const SHEET_LABEL: Record<SheetFormat, string> = {
	clockify: 'Clockify CSV',
	harvest: 'Harvest CSV',
	tempo: 'Jira / Tempo CSV',
	csv: 'Plain CSV',
	markdown: 'Markdown table',
	text: 'Plain text',
}

export interface SheetRow {
	/** The job, project or ticket this row is against. */
	job: string
	minutes: number
	description: string
	/** The ticket key, when the description or job carries one. */
	key?: string
}

const hhmmss = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}:00`
const decimal = (min: number) => (min / 60).toFixed(2)

/**
 * The same rows, in whatever shape the tool in front of you wants. Zoho is one
 * timesheet; the rest of the world uses Clockify, Harvest, Tempo or a
 * spreadsheet, and the rows are the same either way.
 */
export function timesheet(rows: SheetRow[], format: SheetFormat, date: string): string {
	switch (format) {
		case 'clockify':
			// Clockify's import columns, in its order.
			return csv(
				['Project', 'Client', 'Description', 'Task', 'Billable', 'Start Date', 'Start Time', 'End Date', 'End Time', 'Duration (h)', 'Duration (decimal)'],
				rows.map((r) => [r.job, '', r.description, r.key ?? '', 'Yes', date, '', date, '', hhmmss(r.minutes), decimal(r.minutes)]),
			)
		case 'harvest':
			return csv(
				['Date', 'Client', 'Project', 'Task', 'Notes', 'Hours'],
				rows.map((r) => [date, '', r.job, r.key ?? '', r.description, decimal(r.minutes)]),
			)
		case 'tempo':
			// Tempo takes seconds and wants the issue key first.
			return csv(
				['Issue Key', 'Date Started', 'Time Spent (seconds)', 'Description'],
				rows.map((r) => [r.key ?? '', date, r.minutes * 60, r.description]),
			)
		case 'csv':
			return csv(
				['Date', 'Job', 'Ticket', 'Hours', 'Minutes', 'Description'],
				rows.map((r) => [date, r.job, r.key ?? '', hhmm(r.minutes), r.minutes, r.description]),
			)
		case 'markdown': {
			const out = [`| Job | Hours | What |`, `| --- | --- | --- |`]
			for (const r of rows) out.push(`| ${cell(r.job)} | ${hhmm(r.minutes)} | ${r.description.replace(/\|/g, '\\|')} |`)
			return `${out.join('\n')}\n`
		}
		default:
			return `${rows.map((r) => `${hhmm(r.minutes)}  ${r.job}${r.key ? ` (${r.key})` : ''} — ${r.description}`).join('\n')}\n`
	}
}

// Asking a model to write the timesheet, without letting it write the hours.
//
// `groupEntries` already produces correct rows — the right jobs, the right
// minutes — and a description that is every entry's text joined with a
// semicolon. That is honest and unreadable: "fixed webhook; looked at retry;
// webhook again" is three true things and one bad sentence.
//
// So the model gets one job and is given no way to do any other: rewrite each
// description, in order, and return the same number of them. The hours are
// never in the response, so they cannot be changed. The row count is checked,
// so a row cannot be invented or dropped. Anything that comes back in the
// wrong shape is discarded whole rather than merged — a half-applied draft is
// worse than none, because nobody can see which half.
//
// What it must not do is add work that did not happen. That cannot be checked
// mechanically, which is why the UI shows the original beside the draft and
// nothing is saved until somebody has looked.

export interface DraftRow {
	jobName: string
	minutes: number
	description: string
}

/** How long one description may be. A timesheet cell, not an essay. */
export const MAX_DESCRIPTION = 240

export const SYSTEM = [
	'You tidy timesheet descriptions for an engineer.',
	'',
	'You are given rows. Each has a job, a number of minutes, and a description made by joining that hour\'s notes with semicolons.',
	'',
	'Rewrite ONLY the description of each row, in the same order.',
	'',
	'Rules, all of them absolute:',
	'- Use ONLY facts present in the given description. Add nothing.',
	'- Never invent a ticket, a name, an outcome, a number or a result.',
	'- If the notes are vague, leave them vague. Do not improve the work, only the sentence.',
	'- Keep ticket keys exactly as written.',
	'- One sentence or a short clause list. No bullet points, no preamble.',
	`- At most ${MAX_DESCRIPTION} characters.`,
	'- British English. Past tense. No first person pronouns.',
	'',
	'Return ONLY a JSON array of strings, one per row, in order. No prose, no code fence.',
].join('\n')

export function promptFor(rows: DraftRow[]): string {
	return rows.map((r, i) => `${i + 1}. [${r.jobName} · ${Math.round(r.minutes)} min] ${r.description || '(nothing written)'}`).join('\n')
}

/**
 * The model's answer, or a reason it was thrown away.
 *
 * Models wrap JSON in a code fence about a third of the time whatever you ask,
 * so that is tolerated. Everything else is not: wrong length, wrong type, or
 * an empty string means the whole draft is discarded, because a row silently
 * left as the original among rows that were rewritten is undetectable.
 */
export function parseDraft(text: string, expected: number): { ok: true; rows: string[] } | { ok: false; why: string } {
	const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
	let parsed: unknown
	try {
		parsed = JSON.parse(body)
	} catch {
		return { ok: false, why: 'It did not answer with a list. Try again, or a different model.' }
	}
	if (!Array.isArray(parsed)) return { ok: false, why: 'It answered with something other than a list.' }
	if (parsed.length !== expected) {
		return { ok: false, why: `It returned ${parsed.length} rows for ${expected}. Nothing has been changed.` }
	}
	const rows: string[] = []
	for (const v of parsed) {
		if (typeof v !== 'string' || !v.trim()) return { ok: false, why: 'One of the rows came back empty. Nothing has been changed.' }
		rows.push(v.trim().slice(0, MAX_DESCRIPTION))
	}
	return { ok: true, rows }
}

/**
 * Words in the draft that were nowhere in the original.
 *
 * Not a guarantee and not presented as one — a model can invent a claim using
 * only words it was given. It catches the obvious case, which is a ticket key
 * or a proper noun arriving from nowhere, and that is worth catching.
 */
export function novelWords(original: string, draft: string): string[] {
	const words = (s: string) => new Set(s.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [])
	const had = words(original)
	// Ordinary connective English is not evidence of invention.
	const ordinary = new Set([
		'the', 'and', 'for', 'with', 'from', 'was', 'were', 'had', 'has', 'into', 'onto', 'that', 'this',
		'then', 'than', 'but', 'not', 'added', 'fixed', 'updated', 'worked', 'reviewed', 'investigated',
		'implemented', 'checked', 'changed', 'made', 'ran', 'built', 'wrote', 'read', 'after', 'before',
		'while', 'over', 'under', 'across', 'about', 'their', 'its', 'also', 'some', 'more', 'each',
	])
	return [...words(draft)].filter((w) => !had.has(w) && !ordinary.has(w))
}

/** The sentence a regularisation form wants, from what actually happened. */
export const REASON_SYSTEM = [
	'You write one sentence for an attendance regularisation form at an Indian company.',
	'',
	'Rules:',
	'- One sentence. Under 200 characters.',
	'- Factual and neutral. No apology, no excuse, no explanation of consequences.',
	'- Say what happened to the punch, not what the person was feeling.',
	'- Never invent a reason that was not given. If the reason is simply that the punch was missed, say that.',
	'- British English. No first person pronouns beyond what the form needs.',
	'',
	'Return ONLY the sentence. No quotes, no preamble.',
].join('\n')

export function reasonPrompt(i: { date: string; inAt?: string; outAt?: string; missing: string; evidence: string; work: string }): string {
	return [
		`Date: ${i.date}`,
		i.inAt ? `Recorded in: ${i.inAt}` : '',
		i.outAt ? `Recorded out: ${i.outAt}` : '',
		`What was missing: ${i.missing}`,
		`What the time is based on: ${i.evidence}`,
		i.work ? `Work logged that day: ${i.work}` : '',
	]
		.filter(Boolean)
		.join('\n')
}

// Is WorkPulse actually working? Asked as a question with an answer, not as a
// page of instructions.
//
// The first-run problem with a tool that reads your own Zoho session is that
// nothing tells you whether it worked: no error, no success, just a dashboard
// that may or may not be seeing anything. So instead of explaining what to do,
// this checks, says what it found, and gives one button for whatever is missing.

export type StepId = 'tab' | 'read' | 'jobs' | 'shift'

export interface Step {
	id: StepId
	label: string
	ok: boolean
	/** What was actually found — a time, a count, a reason. */
	detail: string
	/** The one thing to press when it is not ok. */
	fix?: 'openZoho' | 'check' | 'settings' | 'refreshJobs'
}

export interface ReadyInput {
	now: number
	/** The last read of your Zoho page, if there has been one. */
	read?: { at: number; firstIn: string | null; lastOut: string | null; source?: string; missing?: string[] }
	/** Zoho job list, cached. */
	jobs: number
	/** Shift times as configured, and whether they were ever confirmed. */
	shift: { start: string; end: string; confirmed: boolean }
	/** A Zoho People tab is open in this browser. */
	tabOpen: boolean
	/** The API path is connected and allowed, which skips the page reading. */
	apiReady: boolean
}

/** A read older than this is history, not evidence that it works now. */
export const FRESH = 10 * 60_000

export function readiness(i: ReadyInput): { steps: Step[]; ready: boolean; summary: string } {
	const fresh = i.read != null && i.now - i.read.at < FRESH
	const sawPunch = fresh && !!i.read?.firstIn && !['', '-', '--'].includes(i.read.firstIn.trim())

	const steps: Step[] = [
		{
			id: 'tab',
			label: 'Your Zoho People tab',
			ok: i.apiReady || i.tabOpen,
			detail: i.apiReady ? 'Not needed — the Zoho API is connected' : i.tabOpen ? 'Open and signed in' : 'Not open. WorkPulse reads your own session from that tab.',
			fix: 'openZoho',
		},
		{
			id: 'read',
			label: "Reading today's attendance",
			ok: i.apiReady || fresh,
			detail: i.apiReady
				? 'Through the Zoho API'
				: !i.read
					? 'Nothing read back yet'
					: !fresh
						? 'The last read is too old to count'
						: sawPunch
							? `In ${i.read!.firstIn!.trim()}${i.read!.lastOut?.trim() ? `, out ${i.read!.lastOut.trim()}` : ' — still in'}, from ${i.read!.source === 'endpoint' ? "Zoho's own call" : 'the page'}`
							: i.read?.missing?.length
								? `Read it, but ${i.read.missing.join(' and ')} were not on the page`
								: 'Read the page — no punch on it yet today',
			fix: 'check',
		},
		{
			id: 'jobs',
			label: 'Your Zoho jobs',
			ok: i.jobs > 0,
			detail: i.jobs > 0 ? `${i.jobs} to log time against` : 'None yet — needed only when you push a timesheet',
			fix: 'refreshJobs',
		},
		{
			id: 'shift',
			label: 'Your shift',
			ok: i.shift.confirmed,
			detail: i.shift.confirmed ? `${i.shift.start}–${i.shift.end}` : `Using ${i.shift.start}–${i.shift.end}. Change it if that is not your shift.`,
			fix: 'settings',
		},
	]

	// Ready means it can see your day. Jobs and shift are improvements, not gates.
	const ready = steps[0].ok && steps[1].ok
	const left = steps.filter((s) => !s.ok).length
	return {
		steps,
		ready,
		summary: ready
			? left === 0
				? 'Everything is set up.'
				: `Working — ${left} optional ${left === 1 ? 'thing' : 'things'} left.`
			: 'Not reading your Zoho yet.',
	}
}

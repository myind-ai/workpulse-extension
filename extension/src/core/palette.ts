// The one keystroke, on any page.
//
// Everything in WorkPulse is two or three clicks from somewhere: open the
// widget, find the tab, find the field. That is fine when you are already
// looking at it and useless when you are in the middle of something — which is
// exactly when you need to write a line down, start a block, or file the page
// you are on. By the time the thought has survived three clicks it is gone.
//
// So: one keystroke, a box, and everything the app can do in it. Type to
// filter, Tab to change what you are doing with what you typed, Enter to do it.

export type Mode = 'go' | 'log' | 'page' | 'learn' | 'task' | 'ticket' | 'group' | 'focus'

export interface ModeSpec {
	id: Mode
	label: string
	/** What Enter will do, said in the box itself. */
	hint: string
	/** Nothing typed yet: what this mode is for. */
	empty: string
	/** Modes that need words before Enter does anything. */
	needsText: boolean
}

export const MODES: ModeSpec[] = [
	{ id: 'go', label: 'Go to', hint: 'Enter opens it', empty: 'Jump to a page, a ticket, or anything you have written', needsText: false },
	{ id: 'log', label: 'Log', hint: 'Enter logs it against this slot', empty: 'What you have been working on', needsText: true },
	// The page you are on, which is the one thing the box knows that the
	// dashboard does not. Writing one and reading the ones already there are the
	// same mode, because they are the same thought.
	{ id: 'page', label: 'This page', hint: 'Enter keeps it against this page', empty: 'What is worth remembering about this page', needsText: true },
	{ id: 'learn', label: 'Learned', hint: 'Enter saves it to your learnings', empty: 'Something worth remembering, or not repeating', needsText: true },
	{ id: 'task', label: 'To do', hint: 'Enter adds it to your tasks', empty: 'Something to come back to', needsText: true },
	{ id: 'ticket', label: 'File page', hint: 'Enter files this page under it', empty: 'The ticket this page belongs to', needsText: false },
	// Both directions in one mode, because they are the same thought: the name
	// you type either matches a group you already have — Enter reopens it — or
	// it does not, and Enter keeps this window under it. Naming it afterwards,
	// from another screen, is the part people never got round to.
	{ id: 'group', label: 'Tab group', hint: 'Enter opens it, or saves these tabs under it', empty: 'Open a saved group, or name these tabs to keep them', needsText: false },
	{ id: 'focus', label: 'Focus', hint: 'Enter starts the block', empty: '25, 50 or 90 minutes on one thing', needsText: false },
]

/**
 * Which mode the words themselves imply.
 *
 * A prefix is faster than Tab once you know it, and invisible until you do.
 * `>` is a command, `#` is a learning, `/` is a search — the conventions people
 * already have from every other box like this.
 */
export function modeFor(text: string, current: Mode): { mode: Mode; text: string } {
	const t = text.trimStart()
	const by: [RegExp, Mode][] = [
		[/^>\s*/, 'log'],
		[/^#\s*/, 'learn'],
		[/^\/\s*/, 'go'],
		[/^!\s*/, 'task'],
		[/^@\s*/, 'page'],
		[/^\*\s*/, 'group'],
	]
	for (const [re, mode] of by) {
		if (re.test(t)) return { mode, text: t.replace(re, '') }
	}
	return { mode: current, text }
}

/** Left to right, wrapping — which is what Tab and Shift+Tab do. */
export function nextMode(current: Mode, back = false, available: Mode[] = MODES.map((m) => m.id)): Mode {
	const i = available.indexOf(current)
	const at = i < 0 ? 0 : i
	return available[(at + (back ? -1 : 1) + available.length) % available.length]
}

/** Can Enter do anything yet? */
export function canSubmit(mode: Mode, text: string, hasPick: boolean): boolean {
	const spec = MODES.find((m) => m.id === mode)
	if (!spec) return false
	if (mode === 'go' || mode === 'ticket') return hasPick
	if (mode === 'focus') return true
	return spec.needsText ? text.trim().length >= 2 : true
}

/** What the footer of the box says, given where you are. */
export function footerFor(mode: Mode, text: string, hasPick: boolean): string {
	const spec = MODES.find((m) => m.id === mode)!
	if (!canSubmit(mode, text, hasPick)) return spec.empty
	return spec.hint
}

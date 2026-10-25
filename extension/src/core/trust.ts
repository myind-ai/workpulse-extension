// What WorkPulse can see, said in the second person.
//
// A privacy policy is a document somebody writes once and nobody reads. This
// is the same information as a live panel: every capability the extension
// holds, whether it holds it right now, what it is actually for, and what it
// would mean if it were switched on.
//
// The reason to build it is not compliance. It is that "deliberately useless
// as a surveillance tool" is the single strongest thing about this product and
// it is currently invisible — somebody wary of being watched has no way to
// satisfy themselves short of reading the source.
//
// Every line here must be checkable against the manifest. A trust panel that
// overstates its own restraint is worse than no panel — so the one permission
// that varies by build varies here too, from the same flag.

import { API_ENABLED } from './features'

export interface Capability {
	/** The Chrome permission, where there is one. */
	id: string
	label: string
	/** What it lets WorkPulse do — not what Chrome calls it. */
	does: string
	/** Asked for at install, or only when a feature first needs it. */
	optional: boolean
	/** Why it is needed at all. The honest answer, including when it is dull. */
	why: string
}

/**
 * Signing in with Zoho, which only exists in a build where the official API
 * path is switched on. It is listed only in those builds, because a panel that
 * names a permission the extension does not hold is as wrong as one that hides
 * a permission it does.
 */
const IDENTITY: Capability = {
	id: 'identity',
	label: 'Signing in with Zoho',
	does: 'Open Zoho’s own sign-in page and receive the token it hands back',
	optional: false,
	why: 'Only in builds with the official API switched on. Your Zoho password is typed on Zoho’s page and never reaches WorkPulse.',
}

/**
 * Held from the moment it is installed. Each one is the minimum for something
 * visible: there is no "analytics" row because there is no analytics.
 */
export const ALWAYS: Capability[] = [
	{ id: 'alarms', label: 'Timers', does: 'Wake up on the hour to ask you one question', optional: false, why: 'Without it the card never arrives, which is the whole product.' },
	{ id: 'idle', label: 'Whether you are at the desk', does: 'Tell whether the machine has gone quiet — never what is on it', optional: false, why: 'So a break is not logged as work, and so the check-out you forgot can be reconstructed.' },
	{ id: 'notifications', label: 'Notifications', does: 'Show a reminder when a tab cannot', optional: false, why: 'A reminder you did not see is not a reminder.' },
	{ id: 'storage', label: 'Local storage', does: 'Keep your entries on this machine', optional: false, why: 'This is where the record lives. It is not sent anywhere.' },
	{ id: 'unlimitedStorage', label: 'Room for screenshots and recordings', does: 'Store large files locally rather than refusing them', optional: false, why: 'A recording is megabytes. Without this Chrome would cap it at a few.' },
	{ id: 'tabs', label: 'Tab titles and addresses', does: 'See the title and URL of your open tabs', optional: false, why: 'To tell which ticket a page belongs to, to group tabs, and to show the card on the page you are on. Never the contents of a page.' },
	{ id: 'scripting', label: 'Drawing on a page', does: 'Put the card and the command box onto whatever page you are on', optional: false, why: 'Injected only when something is owed — not into every tab at load.' },
	{ id: 'contextMenus', label: 'Right-click menu', does: 'Add WorkPulse items to the menu', optional: false, why: 'So a note or a time conversion is one click from where you already are.' },
	{ id: 'offscreen', label: 'A hidden page', does: 'Play a chime, and hold a recording while it is being made', optional: false, why: 'A background worker cannot play audio or hold a camera stream. Nothing is displayed.' },
	// Mirrors the manifest's own condition in wxt.config.ts. A trust panel that
	// drifts from the manifest is worse than no trust panel.
	...(API_ENABLED ? [IDENTITY] : []),
]

/**
 * Asked for the first time the feature is used, and never before. Somebody who
 * never records a screen is never asked whether WorkPulse may record a screen.
 */
export const ON_REQUEST: Capability[] = [
	{ id: 'desktopCapture', label: 'Recording a screen', does: 'Record the screen, window or tab you pick, with your narration', optional: true, why: 'Only ever while you are recording, only what you chose in the picker, and only after you press record.' },
	{ id: 'history', label: 'Browsing history', does: 'Read the pages open in an hour you cannot remember', optional: true, why: 'Only for the hour the card is asking about, only as suggestions, and never saved unless you accept them.' },
	{ id: 'webRequest', label: 'Watching Zoho requests', does: 'Observe the calls Zoho’s own page makes, during setup', optional: true, why: 'Observation only — it never blocks or alters anything. Session cookies and auth headers are stripped before anything is recorded.' },
	{ id: 'tabGroups', label: 'Grouping tabs', does: 'Open a saved group as a real Chrome tab group', optional: true, why: 'Cosmetic. Without it the tabs still open, just ungrouped.' },
]

/**
 * The promises, as a list somebody can check rather than a paragraph they
 * have to trust. Each is true of the shipped manifest.
 */
export const NEVER: string[] = [
	'No server. There is nothing for your record to be sent to.',
	'No account, no sign-up, no email address required.',
	'No analytics, no telemetry, no crash reporting, no usage counts.',
	'No manager dashboard. There is no version of this that reports on you.',
	'No keystrokes, no mouse tracking, no webcam, no location.',
	'No screenshots on a schedule — only the one taken when you write a note, and only of the page you are on.',
	'No reading the contents of the pages you visit. Titles and addresses only.',
	'Nothing is uploaded unless you point it somewhere: a repository you own, or an issue you chose to open.',
]

/** What is written down, so "delete everything" can say what it will delete. */
export interface Holding {
	label: string
	count: number
	/** Said plainly: where it actually sits. */
	where: string
}

/**
 * One sentence for the top of the panel, and it changes with the truth: a
 * profile that has never recorded anything should not be told about recording.
 */
export function trustLine(granted: string[]): string {
	const extra = ON_REQUEST.filter((c) => granted.includes(c.id))
	if (!extra.length) return 'WorkPulse is holding nothing beyond what it needs to ask you one question an hour.'
	return `Beyond the basics, you have allowed: ${extra.map((c) => c.label.toLowerCase()).join(', ')}. Each can be taken back in Chrome at any time.`
}

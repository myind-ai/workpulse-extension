// Every place in WorkPulse you can go, as a list. The sidebar's search runs over
// this: you type what you are looking for and it takes you there — it is a way
// of navigating, not a way of searching your notes. Each page has its own
// search for its own content.

export interface Section {
	/** Where it is. `#/settings/backup` lands on the page with that filter applied. */
	hash: string
	/** The page it lives on, for grouping. */
	page: string
	title: string
	/** What it is for, shown under the title. */
	detail: string
	/** Words someone might type that the title does not contain. */
	keywords: string
}

export const SECTIONS: Section[] = [
	{ hash: '#/today', page: 'Today', title: 'Today', detail: 'The day so far, check in and out, what is logged', keywords: 'home day clock elapsed punch attendance heatmap' },
	{ hash: '#/review', page: 'Review', title: 'Review & timesheet', detail: "Group the day's entries into rows and push them to Zoho", keywords: 'timesheet push zoho rows split hours entries log send submit' },
	{ hash: '#/tasks', page: 'Tasks', title: 'Tasks', detail: 'Open work, what is running, a day at a time', keywords: 'todo task timer start stop priority history' },
	{ hash: '#/tasks', page: 'Tasks', title: 'Reminders', detail: 'Times you asked to be interrupted at, and repeats', keywords: 'remind alarm water medicine repeat every snooze due' },
	{ hash: '#/links', page: 'Tickets & links', title: 'Tickets & links', detail: "A ticket's PR, deploys and docs, reopened as one tab group", keywords: 'ticket group tabs workspace pr stage dev link label jira pay leap bookmark' },
	{ hash: '#/links', page: 'Tickets & links', title: 'Ticket notes', detail: 'Markdown notes under a ticket, by day', keywords: 'note markdown decision blocker gotcha day diary' },
	{ hash: '#/journal', page: 'Learnings', title: 'Learnings & mistakes', detail: 'What you learned or would not repeat, tagged and exported', keywords: 'learn mistake howto journal tag repeat export csv markdown private' },
	{ hash: '#/record', page: 'Your record', title: 'What have you been working on?', detail: 'A week, a month or six months — grouped, in your own words', keywords: 'appraisal review promo self assessment period report month six months cv resume summary 1:1 standup export' },
	{ hash: '#/record', page: 'Your record', title: 'The hours you actually worked', detail: 'Overtime and short days, counted from your own clock', keywords: 'overtime hours extra long week balance clock worked expected short' },
	{ hash: '#/record', page: 'Your record', title: 'How long things really take you', detail: 'Your estimates against the hours that followed', keywords: 'estimate actual planning multiplier calibration velocity guess' },
	{ hash: '#/record', page: 'Your record', title: 'Cover for me', detail: 'A handover: where every ticket stands, with the links and the gotchas', keywords: 'handover cover leave sick holiday away colleague takeover brief' },
	{ hash: '#/team', page: 'Team', title: 'Your team', detail: 'One private repository the team shares — hours, tickets, learnings', keywords: 'team shared colleague manager together board standup private repository member' },
	{ hash: '#/team', page: 'Team', title: 'Notes on a page', detail: 'Raise an issue about the page you are on, with a screenshot', keywords: 'note comment page issue screenshot bug staging feedback reply close github' },
	{ hash: '#/issues', page: 'Regularisation', title: 'Regularisation', detail: 'Days that will cost you, and the one thing to do about each', keywords: 'issue missing checkout absent short hours fix attendance regularise' },
	{ hash: '#/connect', page: 'Zoho setup', title: 'Zoho setup', detail: 'Connect to Zoho People, or read your own pages instead', keywords: 'zoho connect api client setup helper record capture session' },
	{ hash: '#/settings/schedule', page: 'Settings', title: 'Schedule', detail: 'Shift times, workdays, how often you are asked', keywords: 'shift start end hours workdays interval prompt grace minimum' },
	{ hash: '#/settings/chime', page: 'Settings', title: 'Alarms & nudges', detail: 'Chime, check-in and check-out alarms, break and end-of-day', keywords: 'sound chime ring alarm notification break stand up learned' },
	{ hash: '#/settings/backup', page: 'Settings', title: 'Backup to GitHub', detail: 'Write your data to a repository you own, once a day', keywords: 'backup github repository token sync restore private local export' },
	{ hash: '#/settings/prefix', page: 'Settings', title: 'Ticket prefixes', detail: 'PAY, LEAP, SALESPRO — what your keys start with', keywords: 'prefix ticket key jira right click menu detect' },
	{ hash: '#/settings/keyboard', page: 'Settings', title: 'Keyboard', detail: 'The box on any page, and the shortcut that opens it', keywords: 'shortcut keyboard hotkey command palette spotlight quick capture cmd k' },
	{ hash: '#/settings/block', page: 'Settings', title: 'Blocks you book in advance', detail: 'Deep work on the calendar rather than on willpower', keywords: 'deep work focus block book schedule recurring daily concentration calendar' },
	{ hash: '#/notes', page: 'Work', title: 'Notes on pages', detail: 'What you found on a page, kept against its address', keywords: 'note page url tab comment bug staging remember screenshot share team' },
	{ hash: '#/settings/focus', page: 'Settings', title: 'During a focus block', detail: 'The sites a block quietly objects to — never blocked', keywords: 'focus deep work distraction detour reddit youtube twitter block sites nudge' },
	{ hash: '#/record', page: 'Your record', title: 'This week', detail: 'Where the week went — meetings, deep work, switches', keywords: 'week meetings share split deep work switches where did the week go review friday' },
	{ hash: '#/record', page: 'Your record', title: 'Not moving', detail: 'What is waiting on somebody else, and what you started and stopped', keywords: 'blocked waiting review stuck stale abandoned started stopped quiet pr open' },
	{ hash: '#/record', page: 'Your record', title: 'Deep work', detail: 'What the week of focus blocks came to', keywords: 'deep work focus blocks concentration pomodoro flow hours' },
	{ hash: '#/settings/zone', page: 'Settings', title: 'Time zones', detail: 'Your zone, your team’s, and converting a time on any page', keywords: 'timezone time zone utc ist pst convert clock meeting' },
	{ hash: '#/settings/meeting', page: 'Settings', title: 'Meetings that repeat', detail: 'Standup, sprint review — a nudge before each one', keywords: 'meeting standup daily recurring reminder before lead' },
	{ hash: '#/settings/mode', page: 'Settings', title: 'What may be written to Zoho', detail: 'Reminder only, time logs, or full', keywords: 'mode permission write zoho reminder timelogs full' },
	{ hash: '#/settings/advanced', page: 'Settings', title: 'Advanced', detail: 'Grace, wrap-up delay, data centre, clearing a day', keywords: 'advanced grace wrapup delay scopes data centre clear restore' },
	{ hash: '#/settings/support', page: 'Settings', title: 'Sponsor & source', detail: 'Open source, the repository, and sponsoring it', keywords: 'sponsor donate open source licence github issues support bug' },
]

/**
 * Sections matching what was typed, best first. A word in the title counts for
 * more than the same word in the keywords, and a run of the whole query counts
 * for most — enough to put the obvious answer at the top without ranking games.
 */
export function findSections(query: string, list: Section[] = SECTIONS): Section[] {
	const q = query.trim().toLowerCase()
	if (!q) return []
	const words = q.split(/\s+/).filter(Boolean)
	return list
		.map((s) => {
			const title = `${s.title} ${s.page}`.toLowerCase()
			const hay = `${title} ${s.detail} ${s.keywords}`.toLowerCase()
			if (!words.every((w) => hay.includes(w))) return { s, score: 0 }
			let score = 1
			if (title.includes(q)) score += 10
			if (title.startsWith(q)) score += 5
			score += words.filter((w) => title.includes(w)).length * 3
			return { s, score }
		})
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score || a.s.title.localeCompare(b.s.title))
		.map((x) => x.s)
}

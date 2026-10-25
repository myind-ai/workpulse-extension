// Dashboard tab: Today · Review · Tasks · Regularisation · Settings (hash routes).

import { useEffect, useState } from 'react'

import { API_ENABLED, enabled } from '@/core/features'
import { call } from '@/lib/rpc'
import { Brand } from '@/ui/Brand'
import { Palette } from '@/ui/Palette'
import { isPaletteKey, onOpenPalette } from '@/ui/palette-open'
import { useLive } from '@/ui/hooks'

import { Footer, SideFoot } from './Footer'
import { Search } from './Search'
import { BrainView } from './views/BrainView'
import { ConnectView } from './views/ConnectView'
import { IssuesView } from './views/IssuesView'
import { JournalView } from './views/JournalView'
import { LinksView } from './views/LinksView'
import { ReviewView } from './views/ReviewView'
import { SettingsView } from './views/SettingsView'
import { TasksView } from './views/TasksView'
import { NotesView } from './views/Notes'
import { RecordView } from './views/Record'
import { TeamView } from './views/Team'
import { TodayView } from './views/TodayView'

// Four places, not ten.
//
// Every one of these pages earns its keep, but a sidebar of ten made the app
// look like something you have to learn rather than something you use. They
// group by the rhythm they belong to: the loop you run every day, the shelf you
// put things on and pick them off, and the payoff you collect now and then.
const VIEWS = [
	{ id: 'today', label: 'Today', group: null, blurb: '' },
	{ id: 'links', label: 'Tickets & links', group: 'Work', blurb: 'The PR, the deploy, the notes — under the ticket' },
	{ id: 'tasks', label: 'Tasks', group: 'Work', blurb: 'What is open, what is running' },
	{ id: 'journal', label: 'Learnings', group: 'Work', blurb: 'What you learned, what you would not repeat' },
	{ id: 'notes', label: 'Page notes', group: 'Work', blurb: 'What you found on a page, where you found it' },
	{ id: 'brain', label: 'Brain', group: 'Work', blurb: 'Tickets, mistakes, debugging and reports — shared with Claude Code' },
	{ id: 'review', label: 'Timesheet', group: 'Record', blurb: "Today's entries, and the push to Zoho" },
	{ id: 'record', label: 'Your record', group: 'Record', blurb: 'The six months you cannot remember' },
	{ id: 'issues', label: 'Regularisation', group: 'Record', blurb: 'Days that will cost you' },
	{ id: 'team', label: 'Team', group: 'Record', blurb: 'One private repository the team shares' },
	{ id: 'connect', label: 'Zoho setup', group: 'Settings', blurb: 'Connect Zoho People' },
	{ id: 'settings', label: 'Settings', group: 'Settings', blurb: 'Shift, alarms, backup, zones' },
] as const

type ViewId = (typeof VIEWS)[number]['id']
type Group = 'Work' | 'Record' | 'Settings'

/** The four things in the sidebar, and where each one lands. */
const TABS: { group: Group | null; label: string; home: ViewId }[] = [
	{ group: null, label: 'Today', home: 'today' },
	{ group: 'Work', label: 'Work', home: 'links' },
	{ group: 'Record', label: 'Record', home: 'review' },
	{ group: 'Settings', label: 'Settings', home: 'settings' },
]

/** A page whose feature is switched off in this build is not a page at all. */
const shown = (id: ViewId) => id !== 'brain' || enabled('BRAIN')

const groupOf = (view: ViewId): Group | null => VIEWS.find((v) => v.id === view)?.group ?? null

function readHash(): { view: ViewId; arg?: string } {
	const [view, arg] = location.hash.replace(/^#\/?/, '').split('/')
	return { view: (VIEWS.some((v) => v.id === view && shown(v.id)) ? view : 'today') as ViewId, arg }
}

export function App() {
	const [route, setRoute] = useState(readHash)
	const [palette, setPalette] = useState(false)
	const { data: state } = useLive(() => call('state'))

	useEffect(() => {
		const on = () => setRoute(readHash())
		window.addEventListener('hashchange', on)
		return () => window.removeEventListener('hashchange', on)
	}, [])

	// The same box as every other page, on the same keystroke: a shortcut that
	// means one thing here and another thing out there is a shortcut nobody
	// trusts. Chrome's own command cannot reach an extension page, so this one
	// listens for itself.
	useEffect(() => {
		// Capture, on the document, so it is heard before anything on the page can
		// stop it — a field that swallows keys, a card that guards its own. Both
		// ⌘K and ⌘⇧K: Chrome's own command is ⌘⇧K because a bare ⌘K is not a key
		// an extension may claim on every page, but on our own page it is free,
		// and muscle memory says ⌘K.
		const onKey = (e: KeyboardEvent) => {
			if (!isPaletteKey(e)) return
			e.preventDefault()
			e.stopPropagation()
			setPalette((p) => !p)
		}
		document.addEventListener('keydown', onKey, true)
		// And the same box from a button, which must keep working when the
		// keystroke does not.
		const off = onOpenPalette(() => setPalette(true))
		return () => {
			document.removeEventListener('keydown', onKey, true)
			off()
		}
	}, [])

	return (
		<div className="wp-root">
			{palette && <Palette onClose={() => setPalette(false)} />}
			<div className="wp-shell">
				<nav className="wp-side" aria-label="WorkPulse">
					<Brand />
					<Search />
					{TABS.map((t) => {
						const here = groupOf(route.view) === t.group
						const alerts = (t.group === 'Record' ? (state?.issues.length ?? 0) + (state?.pendingDays.length ?? 0) : 0)
						return (
							<div key={t.label}>
								<a className="wp-nav" href={`#/${t.home}`} aria-current={here ? 'page' : undefined}>
									{t.label}
									{!!alerts && <span className="wp-count">{alerts}</span>}
								</a>
								{/* The pages inside a group appear only when you are in it, so
								    the sidebar is four lines until you need more. */}
								{here && t.group && (
									<div className="wp-subnav">
										{VIEWS.filter((v) => v.group === t.group && shown(v.id)).map((v) => (
											<a key={v.id} className="wp-subnav-item" href={`#/${v.id}`} aria-current={route.view === v.id ? 'page' : undefined} title={v.blurb}>
												{v.label}
												{v.id === 'issues' && !!state?.issues.length && <span className="wp-count">{state.issues.length}</span>}
												{v.id === 'review' && !!state?.pendingDays.length && <span className="wp-count">{state.pendingDays.length}</span>}
											</a>
										))}
									</div>
								)}
							</div>
						)
					})}
					<div className="wp-side-foot wp-muted wp-small">
						<div>{state?.roleBlocked ? 'Reading your Zoho tab' : API_ENABLED && state?.hasZoho ? 'Zoho connected' : ''}</div>
						<SideFoot />
					</div>
				</nav>
				<main className="wp-main">
					{route.view === 'today' && <TodayView />}
					{route.view === 'review' && <ReviewView date={route.arg} />}
					{route.view === 'tasks' && <TasksView />}
					{route.view === 'links' && <LinksView id={route.arg} />}
					{route.view === 'journal' && <JournalView />}
					{route.view === 'team' && <TeamView />}
					{route.view === 'notes' && <NotesView />}
					{route.view === 'brain' && <BrainView arg={route.arg} />}
					{route.view === 'record' && <RecordView />}
					{route.view === 'issues' && <IssuesView />}
					{route.view === 'connect' && <ConnectView />}
					{route.view === 'settings' && <SettingsView find={route.arg} />}

					{/* Every page, not just the ones that remembered to ask. */}
					<Footer />
				</main>
			</div>
		</div>
	)
}

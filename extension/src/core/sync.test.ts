import { describe, expect, it } from 'vitest'

import { backupDue, changedFiles, commitMessage, dayPage, digest, digestsOf, filesFor, newRepoUrl, parseRepo, safeSettings, setupStep, shotName, syncTarget, type Backup } from './sync'
import { parseIst } from './time'
import { DEFAULT_SETTINGS } from './types'

const backup = (patch: Partial<Backup> = {}): Backup => ({
	version: 1,
	exportedAt: parseIst('2026-10-13T20:00:00'),
	settings: {},
	learnings: [],
	tickets: [],
	jobs: [],
	goals: [],
	plans: [],
	issues: [],
	meetings: [],
	tasks: [],
	entries: {},
	days: [],
	...patch,
})

describe('what never leaves this machine', () => {
	it('should strip the token, the client id and the email', () => {
		const out = safeSettings({ ...DEFAULT_SETTINGS, email: 'me@example.com', oauthClientId: 'abc123' })
		expect(out.email).toBeUndefined()
		expect(out.oauthClientId).toBeUndefined()
		expect(JSON.stringify(out)).not.toContain('abc123')
	})

	it('should keep the settings that are only preferences', () => {
		expect(safeSettings(DEFAULT_SETTINGS).shiftStart).toBe('09:00')
	})
})

describe('the files written to the repository', () => {
	it('should always write the manifest, the small stuff and a readme', () => {
		expect(filesFor(backup()).map((f) => f.path)).toEqual(['workpulse/data/meta.json', 'workpulse/index.json', 'workpulse/README.md'])
	})

	it('should shard by month, so a day’s backup rewrites a day’s worth of bytes', () => {
		const entry = (date: string) => ({ uid: date, synced: false, date, slotStart: 1, slotEnd: 2, minutes: 60, text: 'x', kind: 'work' as const })
		const b = backup({
			entries: { '2026-09-30': [entry('2026-09-30')], '2026-10-13': [entry('2026-10-13')] },
			days: [{ date: '2026-09-30' }, { date: '2026-10-13' }],
			learnings: [
				{ id: 'a', date: '2026-09-01', at: 1, kind: 'learning', text: 'old', tags: [] },
				{ id: 'b', date: '2026-10-13', at: 2, kind: 'learning', text: 'new', tags: [] },
			],
			tickets: [{ id: 't1', name: 'PAY-1' }, { id: 't2', name: 'PAY-2' }],
		})
		const paths = filesFor(b).map((f) => f.path)
		expect(paths).toContain('workpulse/data/days/2026-09.json')
		expect(paths).toContain('workpulse/data/days/2026-10.json')
		expect(paths).toContain('workpulse/data/learnings/2026-09.json')
		expect(paths).toContain('workpulse/data/tickets/t1.json')
		expect(paths).toContain('workpulse/data/tickets/t2.json')
		// September's shard holds September and nothing else.
		const sept = JSON.parse(filesFor(b).find((f) => f.path.endsWith('data/days/2026-09.json'))!.content)
		expect(Object.keys(sept.entries)).toEqual(['2026-09-30'])
	})

	it('should list every shard in the manifest, for the restore to read back', () => {
		const b = backup({ learnings: [{ id: 'a', date: '2026-10-01', at: 1, kind: 'learning', text: 'x', tags: [] }], tickets: [{ id: 't1', name: 'PAY-1' }] })
		const m = JSON.parse(filesFor(b).find((f) => f.path.endsWith('index.json'))!.content)
		expect(m.version).toBe(2)
		expect(m.shards.learnings).toEqual(['workpulse/data/learnings/2026-10.json'])
		expect(m.shards.tickets).toEqual(['workpulse/data/tickets/t1.json'])
		expect(m.counts).toMatchObject({ learnings: 1, tickets: 1 })
	})

	it('should write the readable copies only when there is something to read', () => {
		const b = backup({
			learnings: [{ id: '1', date: '2026-10-13', at: 1, kind: 'mistake', text: 'Missing index #mysql', tags: ['mysql'] }],
			tickets: [{ name: 'PAY-2433 financing', tabs: [{ title: 'PR', url: 'https://github.com/a/b/pull/1', note: 'merged on dev' }], notes: [{ date: '2026-10-13', text: 'waiting on the flag' }] }],
		})
		const paths = filesFor(b).map((f) => f.path)
		expect(paths).toContain('workpulse/learnings/2026-10.md')
		expect(paths).toContain('workpulse/learnings/all.csv')
		expect(paths).toContain('workpulse/tickets.md')
		const tickets = filesFor(b).find((f) => f.path.endsWith('tickets.md'))!.content
		expect(tickets).toContain('## PAY-2433 financing')
		expect(tickets).toContain('**merged on dev** · [PR](https://github.com/a/b/pull/1)')
		expect(tickets).toContain('### 2026-10-13')
	})

	it('should file a timesheet under the month it belongs to, with the job named', () => {
		const entry = { uid: 'e', synced: false, date: '2026-10-13', slotStart: 1, slotEnd: 2, minutes: 60, text: 'work', kind: 'work' as const, jobId: 'j1' }
		const files = filesFor(backup({ entries: { '2026-10-13': [entry] }, jobs: [{ id: 'j1', name: 'Platform', project: 'Core' }] }))
		const csv = files.find((f) => f.path === 'workpulse/timesheets/2026-10.csv')
		expect(csv).toBeTruthy()
		// The job list used to be looked for on the tickets, where it never was.
		expect(csv!.content).toContain('Platform')
	})

	it('should take the folder it was given', () => {
		expect(filesFor(backup(), 'notes/work')[0].path).toBe('notes/work/data/meta.json')
		expect(filesFor(backup(), '/trailing/')[0].path).toBe('trailing/data/meta.json')
		expect(filesFor(backup(), '')[0].path).toBe('workpulse/data/meta.json')
	})

	it('should say in the readme that nothing secret is in there', () => {
		expect(filesFor(backup()).find((f) => f.path.endsWith('README.md'))!.content).toContain('No tokens')
	})
})

describe('pushing only what changed', () => {
	const files = [
		{ path: 'a', content: 'one' },
		{ path: 'b', content: 'two' },
	]

	it('should push everything the first time', () => {
		expect(changedFiles(files)).toHaveLength(2)
	})

	it('should push nothing when nothing changed', () => {
		expect(changedFiles(files, digestsOf(files))).toEqual([])
	})

	it('should push just the file that changed', () => {
		const next = [files[0], { path: 'b', content: 'two and a half' }]
		expect(changedFiles(next, digestsOf(files)).map((f) => f.path)).toEqual(['b'])
	})

	it('should tell apart contents of the same length', () => {
		expect(digest('abc')).not.toBe(digest('acb'))
	})
})

describe('reading the repository someone pasted', () => {
	it('should take a name, a URL or a clone line', () => {
		for (const input of ['me/notes', 'https://github.com/me/notes', 'https://github.com/me/notes.git', 'git@github.com:me/notes.git', '  me/notes/  ']) {
			expect(parseRepo(input), input).toEqual({ owner: 'me', repo: 'notes' })
		}
	})

	it('should refuse what is not a repository', () => {
		expect(parseRepo('notes')).toBeNull()
		expect(parseRepo('')).toBeNull()
	})
})

describe('when a backup is owed', () => {
	const at = (s: string) => parseIst(s)
	const base = { on: true, now: at('2026-10-13T20:00:00'), dayClosed: false, after: at('2026-10-13T19:00:00') }

	it('should not run at all when it is off', () => {
		expect(backupDue({ ...base, on: false })).toBe(false)
	})

	it('should run once the day is closed, whatever the time', () => {
		expect(backupDue({ ...base, now: at('2026-10-13T14:00:00'), dayClosed: true })).toBe(true)
	})

	it('should run in the evening even if the day was never closed', () => {
		expect(backupDue(base)).toBe(true)
		expect(backupDue({ ...base, now: at('2026-10-13T18:00:00') })).toBe(false)
	})

	it('should not run twice in a day', () => {
		expect(backupDue({ ...base, lastPushAt: at('2026-10-13T09:00:00') })).toBe(false)
		expect(backupDue({ ...base, lastPushAt: at('2026-10-12T20:00:00') })).toBe(true)
	})

	it('should back off after a failed attempt rather than retry every minute', () => {
		expect(backupDue({ ...base, lastTryAt: at('2026-10-13T19:50:00') })).toBe(false)
		expect(backupDue({ ...base, lastTryAt: at('2026-10-13T19:20:00') })).toBe(true) // half an hour later
	})
})

describe('the commit message', () => {
	const now = parseIst('2026-10-13T20:00:00')
	const entry = (minutes: number, text: string) => ({ uid: text, synced: false, date: '2026-10-13', slotStart: 1, slotEnd: 2, minutes, text, kind: 'work' as const })

	const day = backup({
		exportedAt: now,
		entries: { '2026-10-13': [entry(60, 'parser'), entry(105, 'review')] },
		learnings: [{ id: 'l', date: '2026-10-13', at: now, kind: 'mistake', text: 'Missing index again #mysql', tags: ['mysql'] }],
		tickets: [{ id: 't', name: 'PAY-2433 financing', at: now, updatedAt: now }],
	})

	it('should say what the day amounted to on the subject line', () => {
		expect(commitMessage(day, now).split('\n')[0]).toBe('WorkPulse 2026-10-13 — 2h 45m, 1 learning, 1 ticket')
	})

	it('should say what moved in the body', () => {
		const body = commitMessage(day, now, [{ path: 'a', content: 'x' }])
		expect(body).toContain('Logged    2h 45m across 2 entries')
		expect(body).toContain('Mistake   Missing index again') // the tag belongs on the note, not here
		expect(body).toContain('Ticket    PAY-2433 financing')
		expect(body).toContain('1 file written')
	})

	it('should be the date alone on a day with nothing on it', () => {
		expect(commitMessage(backup({ exportedAt: now }), now)).toBe('WorkPulse 2026-10-13')
	})

	it('should not list yesterday’s work as today’s', () => {
		const old = backup({ exportedAt: now, learnings: [{ id: 'l', date: '2026-10-01', at: 1, kind: 'learning', text: 'old', tags: [] }] })
		expect(commitMessage(old, now)).toBe('WorkPulse 2026-10-13')
	})

	it('should not list thirty tickets', () => {
		const many = backup({ exportedAt: now, tickets: Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, name: `PAY-${i}`, at: now, updatedAt: now })) })
		const body = commitMessage(many, now)
		expect(body.split('\n').filter((l) => l.startsWith('Ticket'))).toHaveLength(7) // six, and a line saying how many more
		expect(body).toContain('…and 24 more')
	})
})

describe('everything the app stores, in the backup', () => {
	it('should carry the goals, the plans and the regularisation state', () => {
		const b = backup({
			goals: [{ key: '2026-W42', scope: 'week', text: 'Ship the retry fix', at: 1 }],
			plans: [
				{ date: '2026-09-30', goal: 'September', todos: ['one'] },
				{ date: '2026-10-13', goal: 'Today', todos: ['two'] },
			],
			issues: [{ date: '2026-10-09', kind: 'missing_checkout', detail: 'x', firstSeen: 1 }],
		})
		const files = filesFor(b)
		const meta = JSON.parse(files.find((f) => f.path.endsWith('data/meta.json'))!.content)
		expect(meta.goals).toHaveLength(1)
		expect(meta.issues).toHaveLength(1)

		// Plans are dated, so they shard with everything else dated.
		const paths = files.map((f) => f.path)
		expect(paths).toContain('workpulse/data/plans/2026-09.json')
		expect(paths).toContain('workpulse/data/plans/2026-10.json')
		const manifest = JSON.parse(files.find((f) => f.path.endsWith('index.json'))!.content)
		expect(manifest.shards.plans).toEqual(['workpulse/data/plans/2026-09.json', 'workpulse/data/plans/2026-10.json'])
	})

	it('should not write a plans shard when there are none', () => {
		expect(filesFor(backup()).some((f) => f.path.includes('/plans/'))).toBe(false)
	})
})

describe('notes left on a page, in the backup', () => {
	const note = { id: 'n1abc', at: parseIst('2026-10-16T14:00:00'), url: 'https://stage.acme.com/orders/12', title: 'Orders', text: 'The total ignores the discount', shot: 'data:image/jpeg;base64,/9j/AAA' }
	const b = backup({ pageNotes: [note] })

	it('should keep the words, by month like everything else', () => {
		const file = filesFor(b, 'workpulse').find((f) => f.path.includes('page-notes'))
		expect(file?.path).toBe('workpulse/data/page-notes/2026-10.json')
		expect(file?.content).toContain('The total ignores the discount')
	})

	it('should leave the picture out of the document, and name it instead', () => {
		const file = filesFor(b, 'workpulse', b.exportedAt, true).find((f) => f.path.includes('page-notes'))!
		expect(file.content).not.toContain('/9j/AAA')
		// Six months later, the only time anyone opens the folder, the name has
		// to say what it is a picture of.
		expect(file.content).toContain('2026-10-16-stage-acme-com-orders-n1ab.jpg')
	})

	it('should not name a picture it did not write', () => {
		// A record pointing at a file that is not there wastes an afternoon; one
		// that admits the picture was left behind costs nothing.
		const file = filesFor(b, 'workpulse').find((f) => f.path.includes('page-notes'))!
		expect(file.content).not.toContain('.jpg')
		expect(JSON.parse(file.content)[0].shotDropped).toBe(true)
	})

	it('should only write the pictures when they were asked for', () => {
		expect(filesFor(b, 'workpulse').some((f) => f.path.includes('/shots/'))).toBe(false)
		const withShots = filesFor(b, 'workpulse', b.exportedAt, true)
		const shot = withShots.find((f) => f.path.includes('/shots/'))
		expect(shot?.raw).toBe(true)
		expect(shot?.content).toBe('/9j/AAA')
	})

	it('should tell a restore where the pictures are, and only when there are any', () => {
		const withShots = JSON.parse(filesFor(b, 'workpulse', b.exportedAt, true).find((f) => f.path.endsWith('index.json'))!.content)
		expect(withShots.shots).toBe('workpulse/shots')
		expect(withShots.shards.pageNotes).toEqual(['workpulse/data/page-notes/2026-10.json'])

		// Without them, the manifest does not send a restore looking in vain.
		const without = JSON.parse(filesFor(b, 'workpulse').find((f) => f.path.endsWith('index.json'))!.content)
		expect(without.shots).toBeUndefined()
		expect(without.shards.pageNotes).toHaveLength(1)
	})

	it('should lead with the ticket, so a folder groups by the work', () => {
		// `PAY-3092` then finds the lot — in a listing, in GitHub's search, in grep.
		const withTicket = backup({
			tickets: [{ id: 't1', name: 'PAY-3092 master-key ACL' }],
			pageNotes: [{ ...note, ticketId: 't1' }],
		})
		const file = filesFor(withTicket, 'workpulse', withTicket.exportedAt, true).find((f) => f.path.includes('/shots/'))
		expect(file?.path).toBe('workpulse/shots/PAY-3092-2026-10-16-stage-acme-com-orders-n1ab.jpg')
	})

	it('should leave an unfiled note alone rather than inventing a key', () => {
		const file = filesFor(b, 'workpulse', b.exportedAt, true).find((f) => f.path.includes('/shots/'))
		expect(file?.path).toBe('workpulse/shots/2026-10-16-stage-acme-com-orders-n1ab.jpg')
	})

	it('should put the name you gave it in the filename', () => {
		// Rename the note to "discount rounding" and the file in the repository is
		// called that too — it is the only part of the name written by a person.
		expect(shotName({ ...note, title: 'Discount rounding' })).toBe('2026-10-16-stage-acme-com-discount-rounding-n1ab.jpg')
	})

	it('should still say where and when, with no name of its own', () => {
		expect(shotName({ id: 'n1abc', at: note.at, url: 'https://stage.acme.com/orders/12' })).toBe('2026-10-16-stage-acme-com-n1ab.jpg')
		expect(shotName({ id: 'zz', at: note.at, url: 'nonsense' })).toContain('nonsense')
	})

	it('should write a recording beside the pictures, under the same name', () => {
		const clip = { id: note.id, at: note.at, url: note.url, title: 'Discount rounding', data: 'data:video/webm;base64,GkXf' }
		const files = filesFor(b, 'workpulse', b.exportedAt, true, [clip])
		const file = files.find((f) => f.path.includes('/clips/'))
		expect(file?.path).toBe('workpulse/clips/2026-10-16-stage-acme-com-discount-rounding-n1ab.webm')
		expect(file?.raw).toBe(true)
		expect(file?.content).toBe('GkXf')
	})

	it('should not mention a recording it did not write', () => {
		const withClip = backup({ pageNotes: [{ ...note, clip: { id: 'c1', ms: 8000, bytes: 1000, at: note.at, type: 'video/webm' } }] })
		const doc = JSON.parse(filesFor(withClip, 'workpulse', withClip.exportedAt, true).find((f) => f.path.includes('page-notes'))!.content)
		expect(doc[0].clip).toBeUndefined()
		expect(JSON.parse(filesFor(withClip, 'workpulse').find((f) => f.path.endsWith('index.json'))!.content).clips).toBeUndefined()
	})

	it('should take an extension, for the things that are not pictures', () => {
		expect(shotName({ ...note, title: 'A clip' }, 'webm')).toMatch(/\.webm$/)
	})
})

import { describe, expect, it } from 'vitest'

import { appendLine, brainOf, cleanSaveUrl, isSavedUrl, libraryKey, changedFiles, devicesOf, EDITABLE, entriesPath, filter, fold, JIRA_COMMANDS, linkTestCode, linkTestFound, linkTestPhrase, newEntry, parseJsonl, reportMarkdown, secretsIn, setupCommands, SOURCE_LABEL, sourceKey, sourceLink, sourceOf, summarise, tokenUrl } from './bridge'

const AT = Date.UTC(2026, 9, 25, 10, 0)
const e = (o: Record<string, unknown>) => JSON.stringify({ id: 'x', at: AT, kind: 'note', title: 't', ...o })

describe('bridge', () => {
	it('a change that only sets the source is not an edit; any other change is', () => {
		const line = (o: Record<string, unknown>) => JSON.stringify({ kind: 'note', title: 'ignored', ...o })
		const file = (...changes: Record<string, unknown>[]) => ({
			'bridge/entries/2026-10/a.jsonl': [e({ id: '1', at: AT, title: 'lesson' }), ...changes.map(line)].join('\n'),
		})
		const source = { type: 'youtube', url: 'https://youtu.be/a' }
		const [backfilled] = fold(file({ id: 'c1', at: AT + 5, amends: '1', set: { source } }))
		expect(backfilled.source).toEqual(source)
		expect(backfilled.editedAt).toBeUndefined()

		const [real] = fold(file({ id: 'c1', at: AT + 5, amends: '1', set: { title: 'new title' } }))
		expect(real.editedAt).toBe(AT + 5)
		const [both] = fold(file({ id: 'c1', at: AT + 5, amends: '1', set: { source, title: 'new title' } }))
		expect(both.editedAt).toBe(AT + 5)
		const [archived] = fold(file({ id: 'c1', at: AT + 5, amends: '1', state: 'archived' }), { archived: true })
		expect(archived.editedAt).toBe(AT + 5)
		// A real edit before the backfill keeps its own time.
		const [kept] = fold(file({ id: 'c1', at: AT + 5, amends: '1', set: { title: 'new title' } }, { id: 'c2', at: AT + 9, amends: '1', set: { source } }))
		expect(kept.editedAt).toBe(AT + 5)
		expect(kept.source).toEqual(source)
	})

	it('files entries by month and device', () => {
		expect(entriesPath(AT, 'mbp-cli')).toBe('bridge/entries/2026-10/mbp-cli.jsonl')
	})

	it('skips a bad line instead of losing the file', () => {
		const got = parseJsonl([e({ id: 'a' }), '{oops', e({ id: 'b', kind: 'nope' }), e({ id: 'c', at: '2026-10-25T10:00:00Z' })].join('\n'))
		expect(got.map((x) => x.id)).toEqual(['a', 'c'])
		expect(got[1].at).toBe(AT)
	})

	it('folds every file, once per id, newest first', () => {
		const all = fold({
			'bridge/entries/2026-10/a.jsonl': [e({ id: '1', at: AT }), e({ id: '2', at: AT + 5 })].join('\n'),
			'bridge/entries/2026-10/b.jsonl': e({ id: '1', at: AT + 9, title: 'newer' }),
			'bridge/inbox/x.json': e({ id: '3' }),
		})
		expect(all.map((x) => x.id)).toEqual(['1', '2'])
		expect(all[0].title).toBe('newer')
	})

	it('defaults scope to work and reads tags from the text', () => {
		const [x] = parseJsonl(e({ title: 'Guard at the server #Idempotency', scope: 'nope' }))
		expect(x.scope).toBe('work')
		expect(x.tags).toEqual(['idempotency'])
	})

	it('filters by kind, scope, ticket and words', () => {
		const all = parseJsonl(
			[e({ id: '1', kind: 'mistake', ticket: 'PAY-1', title: 'enter key' }), e({ id: '2', kind: 'debug', scope: 'personal', project: 'side', title: 'cors' })].join('\n'),
		)
		expect(filter(all, { kind: 'mistake' }).map((x) => x.id)).toEqual(['1'])
		expect(filter(all, { scope: 'personal' }).map((x) => x.id)).toEqual(['2'])
		expect(filter(all, { ticket: 'PAY-1' }).map((x) => x.id)).toEqual(['1'])
		expect(filter(all, { query: 'CORS' }).map((x) => x.id)).toEqual(['2'])
	})

	it('summarises tickets, projects and the mistakes that repeat', () => {
		const all = parseJsonl(
			[
				e({ id: '1', kind: 'ticket', ticket: 'PAY-1', title: 'Double submit', project: 'acme/web' }),
				e({ id: '2', kind: 'mistake', ticket: 'PAY-1', title: 'missed it #forms' }),
				e({ id: '3', kind: 'mistake', title: 'again #forms' }),
			].join('\n'),
		)
		const s = summarise(all)
		expect(s.byKind.mistake).toBe(2)
		expect(s.tickets).toEqual([expect.objectContaining({ key: 'PAY-1', count: 2, title: 'Double submit' })])
		expect(s.projects[0].name).toBe('acme/web')
		expect(s.repeats).toEqual([{ tag: 'forms', count: 2 }])
	})

	it('refuses to write anything shaped like a secret, and names it without the value', () => {
		expect(secretsIn('token ghp_abcdefghijklmnopqrstuvwxyz123456')).toEqual(['GitHub token'])
		expect(secretsIn('plain text')).toEqual([])
		expect(() => newEntry({ kind: 'note', scope: 'work', title: 'key sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa' }, 'd', AT)).toThrow(/API key/)
	})

	it('knows the vault key, an age identity, the way the CLI file check does', () => {
		const key = 'AGE-SECRET-KEY-1' + 'Q'.repeat(58)
		expect(secretsIn(`the key is ${key}`)).toEqual(['age secret key'])
		expect(secretsIn('AGE-SECRET-KEY-1 is how one starts')).toEqual([])
		expect(() => newEntry({ kind: 'note', scope: 'work', title: 'pasted', body: key }, 'd', AT)).toThrow(/age secret key/)
	})

	it('appends a line to the device file', () => {
		const x = newEntry({ kind: 'learning', scope: 'personal', title: 'Use ETags #github' }, 'ext-1', AT)
		expect(x.tags).toEqual(['github'])
		expect(appendLine('a\n\n', x)).toBe(`a\n${JSON.stringify(x)}\n`)
		expect(appendLine(null, x)).toBe(`${JSON.stringify(x)}\n`)
	})

	it('writes a report of a span, grouped, oldest first', () => {
		const all = parseJsonl(
			[
				e({ id: '1', kind: 'ticket', ticket: 'PAY-1', title: 'Double submit', done: 'guarded', links: { pr: 'https://x/pr/1' } }),
				e({ id: '2', kind: 'mistake', title: 'enter key', rootCause: 'one path', at: AT + 1 }),
				e({ id: '3', kind: 'learning', title: 'old', at: AT - 86_400_000 * 30 }),
			].join('\n'),
		)
		const md = reportMarkdown(all, AT - 86_400_000, AT + 86_400_000, 'Week')
		expect(md).toContain('# Week')
		expect(md).toContain('- **PAY-1** — Double submit: guarded ([PR](https://x/pr/1))')
		expect(md).toContain('- enter key — one path')
		expect(md).not.toContain('old')
	})

	it('lists who has written, so a page can show that Claude Code is linked', () => {
		const got = devicesOf(parseJsonl([e({ id: '1', device: 'cli-mac', at: AT }), e({ id: '2', device: 'cli-mac', at: AT + 5 }), e({ id: '3', device: 'ext-ab12', at: AT + 1 })].join('\n')))
		expect(got).toEqual([
			{ device: 'cli-mac', kind: 'cli', count: 2, last: AT + 5 },
			{ device: 'ext-ab12', kind: 'ext', count: 1, last: AT + 1 },
		])
	})

	it('writes the setup commands for a repository and branch', () => {
		const c = setupCommands('me/notes', 'brain')
		expect(c.clone).toBe('git clone https://github.com/myind-ai/workpulse-extension.git ~/workpulse-extension')
		expect(c.setup).toBe('node ~/workpulse-extension/cli/wp-brain.mjs setup --repo me/notes --branch brain')
		expect(setupCommands('me/notes', '').setup).not.toContain('--branch')
	})

	it('offers the Claude Code plugin first, and a sentence that links it', () => {
		const c = setupCommands('me/notes', 'brain')
		expect(c.plugin).toBe('/plugin install workpulse-brain --marketplace myind-ai/workpulse-extension')
		expect(c.pluginOld).toContain('/plugin install workpulse-brain@workpulse')
		expect(c.ask).toBe('Link my WorkPulse Brain to me/notes (branch brain)')
		expect(setupCommands('me/notes', '').ask).toBe('Link my WorkPulse Brain to me/notes')
	})

	it('connects in one line, with the same flags as setup', () => {
		const c = setupCommands('me/notes', 'brain')
		expect(c.connect).toBe('curl -fsSL https://raw.githubusercontent.com/myind-ai/workpulse-extension/main/install.sh | bash -s -- --repo me/notes --branch brain')
	})

	it('pre-fills the token page with Contents: write and nothing else', () => {
		const u = new URL(tokenUrl('me'))
		expect(u.origin + u.pathname).toBe('https://github.com/settings/personal-access-tokens/new')
		expect(u.searchParams.get('contents')).toBe('write')
		expect(u.searchParams.get('target_name')).toBe('me')
		expect(u.searchParams.get('expires_in')).toBe('90')
		expect([...u.searchParams.keys()].sort()).toEqual(['contents', 'description', 'expires_in', 'name', 'target_name'])
		expect(new URL(tokenUrl()).searchParams.has('target_name')).toBe(false)
	})

	it('fetches only entry files whose sha moved', () => {
		const got = changedFiles({ 'bridge/entries/2026-10/a.jsonl': '1' }, [
			{ path: 'bridge/entries/2026-10/a.jsonl', sha: '1' },
			{ path: 'bridge/entries/2026-10/b.jsonl', sha: '2' },
			{ path: 'workpulse/data/meta.json', sha: '3' },
		])
		expect(got.fetch).toEqual(['bridge/entries/2026-10/b.jsonl'])
		expect(Object.keys(got.shas)).toHaveLength(2)
	})

	it('also keeps work logs, and nothing from the library, inbox or config', () => {
		const got = changedFiles({}, [
			{ path: 'bridge/entries/2026-10/a.jsonl', sha: '1' },
			{ path: 'bridge/worklogs/2026-10/cli-a.jsonl', sha: '2' },
			{ path: 'bridge/worklogs/2026-10/notes.txt', sha: '3' },
			{ path: 'bridge/library/youtube/x/meta.json', sha: '4' },
			{ path: 'bridge/library/youtube/x/notes.jsonl', sha: '5' },
			{ path: 'bridge/inbox/cli-a.jsonl', sha: '6' },
			{ path: 'bridge/config/c.jsonl', sha: '7' },
		])
		expect(got.fetch.sort()).toEqual(['bridge/entries/2026-10/a.jsonl', 'bridge/worklogs/2026-10/cli-a.jsonl'])
		expect(Object.keys(got.shas).sort()).toEqual(got.fetch.sort())
	})

	it('never reads a work log as a Brain entry', () => {
		const line = JSON.stringify({ id: 'w1', at: AT, kind: 'learning', title: 'looks like a lesson', device: 'cli-w', schema: 'workpulse.worklog/1', from: AT, to: AT + 6e4, text: 'x' })
		const files = { 'bridge/worklogs/2026-10/cli-w.jsonl': line, 'bridge/entries/2026-10/cli-a.jsonl': e({ id: 'a', device: 'cli-a' }) }
		expect(brainOf({ bridge: { files } }).map((x) => x.id)).toEqual(['a'])
	})
})

describe('the end-to-end link test', () => {
	const learning = (title: string, device: string, at: number) => newEntry({ kind: 'learning', scope: 'personal', title }, device, at)

	it('should give each browser its own code, the same every time', () => {
		expect(linkTestCode('ext-ab12cd')).toBe('wp-link-ab12cd')
		expect(linkTestPhrase('ext-ab12cd')).toBe('Save it as a learning: WorkPulse link test wp-link-ab12cd')
	})

	it('should pass only on a Claude Code machine writing this browser\'s code, and report the newest', () => {
		const entries = [
			learning('WorkPulse link test wp-link-ab12cd', 'ext-ab12cd', 1), // this browser wrote it: proves nothing about Claude Code
			learning('WorkPulse link test wp-link-zz99zz', 'cli-mac', 2), // another browser's code
			learning('workpulse link test WP-LINK-AB12CD', 'cli-mac', 3), // however Claude capitalised it
			learning('WorkPulse link test wp-link-ab12cd', 'cli-work', 4),
		]
		expect(linkTestFound(entries, 'ext-ab12cd')).toMatchObject({ device: 'cli-work', at: 4 })
		expect(linkTestFound(entries.slice(0, 2), 'ext-ab12cd')).toBeNull()
	})

	it('should hand over the Jira plugin commands from the same marketplace as the Brain plugin', () => {
		expect(JIRA_COMMANDS.plugin).toContain('--marketplace myind-ai/workpulse-extension')
		expect(setupCommands('me/notes', 'brain').plugin).toContain('--marketplace myind-ai/workpulse-extension')
	})
})

describe('when Claude Code says the plugin is not in the marketplace', () => {
	it('should hand over both fixes: add the marketplace, or update an old copy of it', () => {
		const c = setupCommands('me/notes', 'brain')
		expect(c.marketplaceAdd).toBe('/plugin marketplace add myind-ai/workpulse-extension')
		expect(c.marketplaceUpdate).toBe('/plugin marketplace update workpulse')
		expect(c.installAt).toBe('/plugin install workpulse-brain@workpulse')
		expect(c.plugin).toBe('/plugin install workpulse-brain --marketplace myind-ai/workpulse-extension')
	})
})

describe('source', () => {
	const entry = (o: Record<string, unknown>) => parseJsonl(e({ device: 'cli-a', ...o }))[0]
	it('returns the stored source', () => {
		const source = { type: 'instagram', url: 'https://www.instagram.com/reel/a/', by: 'someone' }
		expect(sourceOf(entry({ source }))).toEqual(source)
	})
	it('derives youtube from a youtube-learning entry, without the trailing full stop', () => {
		const got = sourceOf(entry({ project: 'youtube-learning', body: 'From "x" (y) https://www.youtube.com/watch?v=a&t=3s. Notes: z' }))
		expect(got).toEqual({ type: 'youtube', url: 'https://www.youtube.com/watch?v=a&t=3s' })
	})
	it('derives instagram when the url is on instagram.com', () => {
		expect(sourceOf(entry({ project: 'youtube-learning', body: 'From "x" https://www.instagram.com/reel/abc/. Notes' }))).toEqual({ type: 'instagram', url: 'https://www.instagram.com/reel/abc/' })
	})
	it('gives workpulse for an entry written by the extension', () => {
		expect(sourceOf(entry({ device: 'ext-ab12cd' }))).toEqual({ type: 'workpulse' })
	})
	it('gives undefined when nothing says where it came from', () => {
		expect(sourceOf(entry({}))).toBeUndefined()
	})
	it('can be edited, and fold applies a change record that sets it', () => {
		expect(EDITABLE).toContain('source')
		const source = { type: 'youtube', url: 'https://youtu.be/a', title: 'T' }
		const files = {
			'bridge/entries/2026-10/cli-a.jsonl': [e({ id: 'a', device: 'cli-a' }), e({ id: 'c', at: AT + 5, amends: 'a', set: { source } })].join('\n'),
		}
		expect(fold(files)[0].source).toEqual(source)
	})
})

describe('source keys and links', () => {
	const yt = (url: string) => sourceKey({ type: 'youtube', url })
	it('gives one key per video however it was linked', () => {
		expect(yt('https://www.youtube.com/watch?v=abc&t=3s')).toBe('youtube:abc')
		expect(yt('https://youtu.be/abc?t=9')).toBe('youtube:abc')
		expect(yt('https://www.youtube.com/shorts/abc')).toBe('youtube:abc')
	})
	it('drops tracking and trailing slashes, keeps real query values', () => {
		const k = (url: string) => sourceKey({ type: 'site', url })
		expect(k('https://Example.COM/a/?utm_source=x&si=1&igsh=2&fbclid=3&t=4')).toBe(k('https://example.com/a'))
		expect(k('https://example.com/p?id=12')).not.toBe(k('https://example.com/p?id=13'))
	})
	it('falls back to the library folder, then the type, then nothing', () => {
		expect(sourceKey({ type: 'instagram', library: 'instagram/x' })).toBe('library:instagram/x')
		expect(sourceKey({ type: 'workpulse' })).toBe('type:workpulse')
		expect(sourceKey(undefined)).toBeUndefined()
	})
	it('only links to http(s)', () => {
		expect(sourceLink({ type: 'site', url: 'javascript:alert(1)' })).toBeUndefined()
		expect(sourceLink({ type: 'site', url: 'not a url' })).toBeUndefined()
		expect(sourceLink({ type: 'site', url: 'file:///x' })).toBeUndefined()
		expect(sourceLink({ type: 'site', url: 'https://a.io/x' })).toBe('https://a.io/x')
		expect(sourceLink(undefined)).toBeUndefined()
	})
	it('names a library folder the same way with or without its prefix', () => {
		expect(libraryKey('bridge/library/youtube/a')).toBe('youtube/a')
		expect(libraryKey('youtube/a')).toBe('youtube/a')
	})
	it('labels every source, and none as "No source"', () => {
		expect(SOURCE_LABEL.none).toBe('No source')
		expect(SOURCE_LABEL.youtube).toBe('YouTube')
	})
	it('counts entries by source', () => {
		const all = parseJsonl([e({ id: '1', source: { type: 'youtube' } }), e({ id: '2', project: 'youtube-learning' }), e({ id: '3' })].join('\n'))
		expect(summarise(all).bySource).toMatchObject({ youtube: 2, none: 1, site: 0 })
	})
})

describe('saving a page to the inbox', () => {
	it('refuses what is not a web page', () => {
		for (const raw of ['chrome://x', 'chrome-extension://x/y', 'file:///x', 'not a url']) expect(cleanSaveUrl(raw)).toEqual({ error: 'Only web pages can be saved.' })
	})
	it('removes the login and secret-named query values, keeps the rest and the fragment', () => {
		const got = cleanSaveUrl('https://user:pw@Example.com/a?id=12&Token=x&ACCESS_TOKEN=y&key=1&api_key=2&auth=3&code=4&session=5&sig=6&signature=7&password=8&pwd=9&v=keep#frag')
		expect(got).toEqual({ url: 'https://example.com/a?id=12&v=keep#frag' })
	})
	it('removes the other secret-named query values, whatever their case', () => {
		const got = cleanSaveUrl('https://example.com/a?apikey=1&client_secret=2&refresh_token=3&id_token=4&secret=5&X-Amz-Signature=6&APIKEY=7&v=keep&tokenizer=stays')
		expect(got).toEqual({ url: 'https://example.com/a?v=keep&tokenizer=stays' })
	})
	it('removes a fragment that carries a token, and keeps every other fragment', () => {
		for (const f of ['#access_token=abc&state=1', '#state=1&id_token=abc', '#ACCESS_TOKEN=abc', '#/callback?access_token=abc']) expect(cleanSaveUrl(`https://example.com/a?v=1${f}`)).toEqual({ url: 'https://example.com/a?v=1' })
		for (const f of ['#part', '#/route/a', '#t=42', '#no_access_token', '#my_id_token=x']) expect(cleanSaveUrl(`https://example.com/a${f}`)).toEqual({ url: `https://example.com/a${f}` })
	})
	it('knows a saved-url message', () => {
		const base = { schema: 'workpulse.bridge.msg/1' as const, id: 'a', at: 1, from: 'ext-a', text: 'Save to Brain: https://a.io/' }
		expect(isSavedUrl({ ...base, type: 'save-url', url: 'https://a.io/' })).toBe(true)
		expect(isSavedUrl(base)).toBe(false)
		expect(isSavedUrl({ ...base, type: 'save-url' })).toBe(false)
	})
})

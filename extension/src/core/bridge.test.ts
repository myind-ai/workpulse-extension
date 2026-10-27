import { describe, expect, it } from 'vitest'

import { appendLine, changedFiles, devicesOf, entriesPath, filter, fold, JIRA_COMMANDS, linkTestCode, linkTestFound, linkTestPhrase, newEntry, parseJsonl, reportMarkdown, secretsIn, setupCommands, summarise, tokenUrl } from './bridge'

const AT = Date.UTC(2026, 9, 25, 10, 0)
const e = (o: Record<string, unknown>) => JSON.stringify({ id: 'x', at: AT, kind: 'note', title: 't', ...o })

describe('bridge', () => {
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

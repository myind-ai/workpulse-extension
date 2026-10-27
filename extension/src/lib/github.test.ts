import { describe, expect, it, vi } from 'vitest'

import { decode, encode64, GitHub, GitHubError } from './github'

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
const fail = (status: number, body = '{}') => new Response(body, { status })

const client = (fetchFn: typeof fetch, branch?: string) => new GitHub('tok', { owner: 'me', repo: 'notes', branch }, fetchFn)

describe('base64 that survives real notes', () => {
	it('should round-trip em dashes, emoji and newlines', () => {
		const text = '# Learned — the hard way 🧠\n\n- [x] done\n'
		expect(decode(encode64(text))).toBe(text)
	})

	it('should read the wrapped base64 GitHub returns', () => {
		const wrapped = encode64('x'.repeat(200)).replace(/(.{60})/g, '$1\n')
		expect(decode(wrapped.replace(/\s/g, ''))).toBe('x'.repeat(200))
	})
})

describe('writing a backup as one commit', () => {
	/** A repo with one commit already in it. */
	const live = (seen: [string, RequestInit?][]) =>
		vi.fn(async (url: string, init?: RequestInit) => {
			const u = String(url)
			seen.push([u, init])
			if (u.endsWith('/git/ref/heads/main')) return ok({ object: { sha: 'head-sha' } })
			if (u.includes('/git/commits/head-sha')) return ok({ tree: { sha: 'tree-sha' } })
			if (u.endsWith('/git/trees')) return ok({ sha: 'new-tree' })
			if (u.endsWith('/git/commits')) return ok({ sha: 'new-commit' })
			if (u.includes('/git/refs/heads/main')) return ok({})
			return ok({ full_name: 'me/notes', private: true, permissions: { push: true }, default_branch: 'main' })
		}) as unknown as typeof fetch

	const files = [
		{ path: 'workpulse/backup.json', content: '{}' },
		{ path: 'workpulse/learnings.md', content: '# Learnings' },
	]

	it('should make one commit however many files there are', async () => {
		const seen: [string, RequestInit?][] = []
		const out = await client(live(seen)).commit(files, 'WorkPulse 2026-10-13')
		expect(out).toEqual({ sha: 'new-commit', files: 2 })
		expect(seen.filter(([u]) => u.endsWith('/git/commits') )).toHaveLength(1)
	})

	it('should build the tree on top of the current one, with the files inline', async () => {
		const seen: [string, RequestInit?][] = []
		await client(live(seen)).commit(files, 'msg')
		const body = JSON.parse(String(seen.find(([u]) => u.endsWith('/git/trees'))![1]!.body))
		expect(body.base_tree).toBe('tree-sha')
		expect(body.tree).toEqual([
			{ path: 'workpulse/backup.json', mode: '100644', type: 'blob', content: '{}' },
			{ path: 'workpulse/learnings.md', mode: '100644', type: 'blob', content: '# Learnings' },
		])
	})

	it('should move the branch to the new commit', async () => {
		const seen: [string, RequestInit?][] = []
		await client(live(seen)).commit(files, 'msg')
		const move = seen.find(([u, i]) => u.includes('/git/refs/heads/main') && i?.method === 'PATCH')!
		expect(JSON.parse(String(move[1]!.body))).toEqual({ sha: 'new-commit' })
	})

	it('should take the branch it was given rather than the default', async () => {
		const seen: [string, RequestInit?][] = []
		const fetchFn = vi.fn(async (url: string) => {
			const u = String(url)
			seen.push([u])
			if (u.endsWith('/git/ref/heads/backups')) return ok({ object: { sha: 's' } })
			if (u.includes('/git/commits/s')) return ok({ tree: { sha: 't' } })
			return ok({ sha: 'x' })
		}) as unknown as typeof fetch
		await new GitHub('tok', { owner: 'me', repo: 'notes', branch: 'backups' }, fetchFn).commit(files, 'msg')
		expect(seen.some(([u]) => u.includes('/git/ref/heads/backups'))).toBe(true)
		expect(seen.some(([u]) => u.includes('/repos/me/notes') && u.endsWith('/repos/me/notes'))).toBe(false) // no need to ask for the default
	})

	it.each([
		['404', 404],
		['409, which is what GitHub answers for an empty repository', 409],
	])('should start the history through the contents API when there are no commits (%s)', async (_label, status) => {
		const seen: [string, RequestInit?][] = []
		let started = false
		const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
			const u = String(url)
			seen.push([u, init])
			// The git database does not exist until something has been written.
			if (u.includes('/git/ref/heads/')) return started ? ok({ object: { sha: 'first' } }) : fail(status)
			if (u.includes('/git/commits/first')) return ok({ tree: { sha: 'tree0' } })
			if (u.includes('/contents/') && init?.method === 'PUT') {
				started = true
				return ok({})
			}
			if (u.includes('/contents/')) return fail(404)
			if (u.endsWith('/git/trees')) return ok({ sha: 'tree1' })
			if (u.endsWith('/git/commits')) return ok({ sha: 'commit1' })
			if (u.includes('/git/refs/heads/main')) return ok({})
			return ok({ full_name: 'me/notes', private: true, permissions: { push: true }, default_branch: 'main' })
		}) as unknown as typeof fetch

		const out = await client(fetchFn).commit(files, 'first backup')
		// The first file bootstraps the repository…
		const put = seen.find(([u, i]) => u.includes('/contents/') && i?.method === 'PUT')!
		expect(JSON.parse(String(put[1]!.body))).toMatchObject({ message: 'first backup', branch: 'main', content: encode64('{}') })
		// …and the rest go in one commit on top of it.
		const tree = JSON.parse(String(seen.find(([u]) => u.endsWith('/git/trees'))![1]!.body))
		expect(tree.tree).toHaveLength(1)
		expect(tree.tree[0].path).toBe('workpulse/learnings.md')
		expect(out).toEqual({ sha: 'commit1', files: 2 })
	})

	describe('a named branch that is not there yet', () => {
		/** `main` has history; `brain` does not exist. `emptyRepo` makes main missing too. */
		const repo = (seen: [string, RequestInit?][], opts: { emptyRepo?: boolean; refusePutOnBrain?: boolean } = {}) => {
			let started = false
			return vi.fn(async (url: string, init?: RequestInit) => {
				const u = String(url)
				seen.push([u, init])
				if (u.endsWith('/git/ref/heads/main')) return opts.emptyRepo && !started ? fail(409) : ok({ object: { sha: 'main-sha' } })
				if (u.endsWith('/git/ref/heads/brain')) return started && !opts.refusePutOnBrain ? ok({ object: { sha: 'first' } }) : fail(404)
				if (u.includes('/git/commits/')) return ok({ tree: { sha: 't0' } })
				if (u.includes('/contents/') && init?.method === 'PUT') {
					const body = JSON.parse(String(init.body))
					if (opts.refusePutOnBrain && body.branch === 'brain') return fail(404, '{"message":"Branch brain not found"}')
					started = true
					return ok({})
				}
				if (u.includes('/contents/')) return fail(404)
				if (u.endsWith('/git/trees')) return ok({ sha: 'tree-new' })
				if (u.endsWith('/git/commits')) return ok({ sha: 'commit-new' })
				if (u.endsWith('/git/refs') || u.includes('/git/refs/heads/')) return ok({})
				return ok({ full_name: 'me/notes', private: true, permissions: { push: true }, default_branch: 'main' })
			}) as unknown as typeof fetch
		}
		const body = (seen: [string, RequestInit?][], match: (u: string, i?: RequestInit) => boolean) => JSON.parse(String(seen.find(([u, i]) => match(u, i))![1]!.body))

		it('should start it empty beside the code: no base tree, no parent, then create the ref', async () => {
			const seen: [string, RequestInit?][] = []
			expect(await client(repo(seen), 'brain').commit(files, 'first backup')).toEqual({ sha: 'commit-new', files: 2 })
			expect(body(seen, (u) => u.endsWith('/git/trees')).base_tree).toBeUndefined()
			expect(body(seen, (u) => u.endsWith('/git/commits')).parents).toEqual([])
			expect(body(seen, (u, i) => u.endsWith('/git/refs') && i?.method === 'POST')).toEqual({ ref: 'refs/heads/brain', sha: 'commit-new' })
			expect(seen.some(([u, i]) => u.includes('/contents/') && i?.method === 'PUT')).toBe(false) // never writes next to the code on main
		})

		it('should start an empty repository on that branch when GitHub accepts it', async () => {
			const seen: [string, RequestInit?][] = []
			await client(repo(seen, { emptyRepo: true }), 'brain').commit(files, 'first backup')
			expect(body(seen, (u, i) => u.includes('/contents/') && i?.method === 'PUT').branch).toBe('brain')
		})

		it('should start an empty repository with a README on main, then the branch, when GitHub refuses', async () => {
			const seen: [string, RequestInit?][] = []
			expect(await client(repo(seen, { emptyRepo: true, refusePutOnBrain: true }), 'brain').commit(files, 'first backup')).toEqual({ sha: 'commit-new', files: 2 })
			const puts = seen.filter(([u, i]) => u.includes('/contents/') && i?.method === 'PUT').map(([u, i]) => [u.split('/contents/')[1], JSON.parse(String(i!.body)).branch])
			expect(puts).toEqual([['workpulse/backup.json', 'brain'], ['README.md', 'main']])
			expect(body(seen, (u, i) => u.endsWith('/git/refs') && i?.method === 'POST').ref).toBe('refs/heads/brain')
			expect(body(seen, (u) => u.endsWith('/git/trees')).tree).toHaveLength(2) // every file is on brain
		})
	})

	it('should not reach for the git database at all for a single first file', async () => {
		const seen: string[] = []
		const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
			const u = String(url)
			seen.push(u)
			if (u.includes('/git/ref/heads/')) return fail(409)
			if (u.includes('/contents/')) return init?.method === 'PUT' ? ok({}) : fail(404)
			return ok({ full_name: 'me/notes', private: true, permissions: { push: true }, default_branch: 'main' })
		}) as unknown as typeof fetch

		expect(await client(fetchFn).commit([files[0]], 'first backup')).toEqual({ sha: '', files: 1 })
		expect(seen.some((u) => u.endsWith('/git/trees'))).toBe(false)
	})

	it('should do nothing at all when nothing changed', async () => {
		const fetchFn = vi.fn(async () => ok({})) as unknown as typeof fetch
		expect(await client(fetchFn).commit([], 'msg')).toBeNull()
		expect((fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0)
	})
})

describe('when GitHub says no', () => {
	const refuses = (status: number) => client(vi.fn(async () => fail(status)) as unknown as typeof fetch)

	it('should say what to do about it, not just the number', async () => {
		await expect(refuses(401).check()).rejects.toThrow(/token.*expired|copied in full/i)
		await expect(refuses(403).check()).rejects.toThrow(/Contents: Read and write/)
		await expect(refuses(404).check()).rejects.toThrow(/cannot see that repository/)
		await expect(refuses(500).commit([{ path: 'a', content: 'b' }], 'c')).rejects.toThrow(/GitHub returned 500/)
	})

	it('should treat a missing file as absent rather than as an error', async () => {
		expect(await refuses(404).read('nope.json')).toBeNull()
	})

	it('should carry the status for anything else', async () => {
		await expect(refuses(500).check()).rejects.toBeInstanceOf(GitHubError)
	})
})

describe('checking the repository', () => {
	it('should report whether the token can write', async () => {
		const fetchFn = vi.fn(async () => ok({ full_name: 'me/notes', private: true, permissions: { push: true }, default_branch: 'main' })) as unknown as typeof fetch
		expect(await client(fetchFn).check()).toEqual({ full_name: 'me/notes', private: true, canWrite: true, defaultBranch: 'main' })
	})

	it('should send the token as a bearer and nothing else', async () => {
		const fetchFn = vi.fn(async () => ok({ full_name: 'x', private: false, default_branch: 'main' })) as unknown as typeof fetch
		await client(fetchFn).check()
		const [, init] = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
	})
})

describe('calling fetch at all', () => {
	it('should call the global fetch with the global scope as its receiver', async () => {
		// Storing `fetch` as a field and calling `this.fetchFn(...)` makes the
		// client the receiver, and the browser refuses with "Illegal invocation".
		// This is that bug, caught without a browser: a global that checks `this`.
		const real = globalThis.fetch
		let receiver: unknown = 'never called'
		Object.defineProperty(globalThis, 'fetch', {
			configurable: true,
			writable: true,
			value: function (this: unknown) {
				receiver = this
				return Promise.resolve(ok({ full_name: 'me/notes', private: false, default_branch: 'main' }))
			},
		})
		try {
			await new GitHub('tok', { owner: 'me', repo: 'notes' }).check()
		} finally {
			Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: real })
		}
		expect(receiver === globalThis || receiver === undefined).toBe(true)
		expect(receiver).not.toBeInstanceOf(GitHub)
	})
})

describe('a screenshot is bytes, not text', () => {
	const live = (seen: [string, RequestInit?][]) =>
		vi.fn(async (url: string, init?: RequestInit) => {
			const u = String(url)
			seen.push([u, init])
			if (u.endsWith('/git/ref/heads/main')) return ok({ object: { sha: 'head-sha' } })
			if (u.includes('/git/commits/head-sha')) return ok({ tree: { sha: 'tree-sha' } })
			if (u.endsWith('/git/blobs')) return ok({ sha: 'blob-sha' })
			if (u.endsWith('/git/trees')) return ok({ sha: 'new-tree' })
			if (u.endsWith('/git/commits')) return ok({ sha: 'new-commit' })
			if (u.includes('/git/refs/heads/main')) return ok({})
			return ok({ full_name: 'me/notes', private: true, permissions: { push: true }, default_branch: 'main' })
		}) as unknown as typeof fetch

	it('should upload a raw file as a base64 blob and point the tree at it', async () => {
		const seen: [string, RequestInit?][] = []
		await client(live(seen), 'main').commit([{ path: 'team/shots/a.png', content: 'iVBOR', raw: true }], 'notes: screenshot')
		const blob = seen.find(([u]) => u.endsWith('/git/blobs'))
		expect(JSON.parse(String(blob?.[1]?.body))).toEqual({ content: 'iVBOR', encoding: 'base64' })
		const tree = JSON.parse(String(seen.find(([u]) => u.endsWith('/git/trees'))?.[1]?.body))
		expect(tree.tree[0]).toEqual({ path: 'team/shots/a.png', mode: '100644', type: 'blob', sha: 'blob-sha' })
	})

	it('should still inline text files, which need no blob of their own', async () => {
		const seen: [string, RequestInit?][] = []
		await client(live(seen), 'main').commit([{ path: 'team/members/me.json', content: '{}' }], 'team: me')
		expect(seen.some(([u]) => u.endsWith('/git/blobs'))).toBe(false)
	})
})

describe('a note on a page is an issue', () => {
	const live = (seen: [string, RequestInit?][]) =>
		vi.fn(async (url: string, init?: RequestInit) => {
			const u = String(url)
			seen.push([u, init])
			if (/\/issues\/7\/comments/.test(u)) return ok([{ user: { login: 'priya' }, body: 'Seen it too', created_at: '2026-10-13T10:00:00Z' }])
			if (/\/issues\/7$/.test(u)) return ok({ number: 7, title: 'Orders — total is wrong', body: 'b', state: 'open', user: { login: 'me' }, created_at: '2026-10-13T09:00:00Z', html_url: 'https://github.com/me/notes/issues/7' })
			if (u.includes('/issues?')) return ok([{ number: 7, title: 't', body: 'b', state: 'open', user: { login: 'me' }, created_at: '2026-10-13T09:00:00Z' }])
			return ok({ number: 7, html_url: 'https://github.com/me/notes/issues/7' })
		}) as unknown as typeof fetch

	it('should open, read, reply to and close one', async () => {
		const seen: [string, RequestInit?][] = []
		const gh = client(live(seen))
		expect(await gh.openIssue('Orders — total is wrong', 'body', ['workpulse-page'])).toEqual({ number: 7, url: 'https://github.com/me/notes/issues/7' })
		expect((await gh.issue(7))?.state).toBe('open')
		expect(await gh.issueComments(7)).toEqual([{ author: 'priya', text: 'Seen it too', at: Date.parse('2026-10-13T10:00:00Z') }])
		await gh.replyToIssue(7, 'Fixed on stage')
		await gh.closeIssue(7)
		expect(seen.filter(([, i]) => i?.method === 'POST')).toHaveLength(2)
		expect(seen.find(([, i]) => i?.method === 'PATCH')?.[1]?.body).toBe('{"state":"closed"}')
	})

	it('should say nothing rather than throw when the issue is gone', async () => {
		const gone = vi.fn(async () => fail(404)) as unknown as typeof fetch
		expect(await client(gone).issue(7)).toBeNull()
	})

	it('should treat a missing folder as an empty one', async () => {
		const gone = vi.fn(async () => fail(404)) as unknown as typeof fetch
		expect(await client(gone).list('team/members')).toEqual([])
	})
})

describe('two people, one branch', () => {
	it('should lose the race politely and build on what the other wrote', async () => {
		let refCalls = 0
		const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
			const u = String(url)
			if (u.endsWith('/git/ref/heads/main')) return ok({ object: { sha: `head-${++refCalls}` } })
			if (u.includes('/git/commits/head-')) return ok({ tree: { sha: 'tree' } })
			if (u.endsWith('/git/trees')) return ok({ sha: 'new-tree' })
			if (u.endsWith('/git/commits')) return ok({ sha: 'new-commit' })
			// The first attempt to move the branch loses; the second wins.
			if (u.includes('/git/refs/heads/main')) return refCalls === 1 ? fail(422, '{"message":"Update is not a fast forward"}') : ok({})
			return ok({ full_name: 'me/notes', private: true, permissions: { push: true }, default_branch: 'main' })
		}) as unknown as typeof fetch

		const out = await client(fetchFn, 'main').commit([{ path: 'team/members/me.json', content: '{}' }], 'team: me')
		expect(out).toEqual({ sha: 'new-commit', files: 1 })
		expect(refCalls).toBe(2) // it read the new head before trying again
	})

	it('should give up rather than hammer, and say what GitHub said', async () => {
		const always = vi.fn(async (url: string) => {
			const u = String(url)
			if (u.endsWith('/git/ref/heads/main')) return ok({ object: { sha: 'head' } })
			if (u.includes('/git/commits/head')) return ok({ tree: { sha: 'tree' } })
			if (u.endsWith('/git/trees')) return ok({ sha: 'new-tree' })
			if (u.endsWith('/git/commits')) return ok({ sha: 'new-commit' })
			if (u.includes('/git/refs/heads/main')) return fail(409)
			return ok({ full_name: 'me/notes', private: true, permissions: { push: true }, default_branch: 'main' })
		}) as unknown as typeof fetch

		await expect(client(always, 'main').commit([{ path: 'a.json', content: '{}' }], 'x', 2)).rejects.toThrow(/conflict/i)
	})

	it('should not retry something that is actually wrong', async () => {
		const refused = vi.fn(async (url: string) => (String(url).endsWith('/git/ref/heads/main') ? fail(401) : fail(401))) as unknown as typeof fetch
		await expect(client(refused, 'main').commit([{ path: 'a.json', content: '{}' }], 'x')).rejects.toThrow(/token/i)
	})
})

describe('never a cached answer', () => {
	// GitHub sends Cache-Control: private, max-age=60. A cached read followed by
	// a write is how a line appended a moment ago gets overwritten.
	it('asks the browser not to cache any call, including the conditional tree read', async () => {
		const seen: RequestInit[] = []
		const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
			seen.push(init ?? {})
			if (String(url).includes('/git/trees/')) return new Response(JSON.stringify({ tree: [] }), { status: 200 })
			return ok({ content: encode64('x'), sha: 's', default_branch: 'main', full_name: 'me/notes', private: true })
		}) as unknown as typeof fetch
		const gh = client(fetchFn, 'main')
		await gh.read('a.txt')
		await gh.treeIfChanged('"v1"')
		expect(seen.length).toBe(2)
		for (const init of seen) expect(init.cache).toBe('no-store')
	})

	it('treats a 304 as nothing changed', async () => {
		const fetchFn = vi.fn(async () => new Response(null, { status: 304 })) as unknown as typeof fetch
		expect(await client(fetchFn, 'main').treeIfChanged('"v1"')).toBeNull()
	})
})

// The GitHub Contents API, which is all this needs: read a file, write a file.
// No git, no library. Called only from the background, where host permissions
// let a cross-origin fetch through.
//
// The token is a fine-grained personal access token with Contents: write on one
// repository. It is read from storage at the moment of use, never logged, never
// written into a backup, and never sent anywhere but api.github.com.

const API = 'https://api.github.com'

/**
 * A file to commit. `raw` means the content is already base64 — a screenshot
 * arrives that way from the browser, and decoding it only to encode it again
 * would be a megabyte of pointless work.
 */
export interface CommitFile {
	path: string
	content: string
	raw?: boolean
}

export interface Repo {
	owner: string
	repo: string
	branch?: string
}

export class GitHubError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message)
		this.name = 'GitHubError'
	}
}

/** What a 401, a 404 or a 403 actually means for someone setting this up. */
function explain(status: number, body: string): string {
	if (status === 401) return 'GitHub refused the token. Check it has not expired and was copied in full.'
	if (status === 403) return 'GitHub refused the token’s permissions. It needs Contents: Read and write on this repository.'
	if (status === 404) return 'GitHub cannot see that repository. Check the name, and that the token lists this repository.'
	if (status === 409)
		return 'GitHub refused that write as a conflict — usually because the repository changed somewhere else a moment ago. Press Back up now again; if it keeps happening, add any file to the repository on GitHub and retry.'
	if (status === 422) return `GitHub rejected the write: ${body.slice(0, 200)}`
	return `GitHub returned ${status}: ${body.slice(0, 200)}`
}

export class GitHub {
	constructor(
		private token: string,
		private repo: Repo,
		/**
		 * Wrapped, not handed over: storing `fetch` itself as a field means it is
		 * later called as a method of this object, and the browser refuses —
		 * "Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation".
		 * It has to be called with the global scope as its receiver.
		 */
		private fetchFn: typeof fetch = (input, init) => globalThis.fetch(input, init),
	) {}

	private async call(path: string, init: RequestInit = {}): Promise<unknown> {
		const res = await this.fetchFn(`${API}${path}`, {
			...init,
			// GitHub answers with `Cache-Control: private, max-age=60`, so the browser
			// would hand back the same file for a minute after it changed. Read a
			// file, append a line, write it back within that minute, and the line
			// written in between is silently lost. Every answer here must be fresh.
			cache: 'no-store',
			headers: {
				Accept: 'application/vnd.github+json',
				Authorization: `Bearer ${this.token}`,
				'X-GitHub-Api-Version': '2022-11-28',
				...(init.body ? { 'Content-Type': 'application/json' } : {}),
			},
		})
		const text = await res.text()
		if (!res.ok) throw new GitHubError(res.status, explain(res.status, text))
		return text ? JSON.parse(text) : null
	}

	private get where() {
		return `${encodeURIComponent(this.repo.owner)}/${encodeURIComponent(this.repo.repo)}`
	}

	/** Who the token belongs to. Needs no permission beyond being a valid token. */
	async me(): Promise<{ login: string }> {
		const r = (await this.call('/user')) as { login: string }
		return { login: r.login }
	}

	/**
	 * The repositories this token can reach — which, for a fine-grained token
	 * scoped to selected repositories, is exactly the ones it was given. That
	 * makes it the right list to choose from: anything in it is known to work.
	 */
	async repos(): Promise<{ full_name: string; private: boolean; canWrite: boolean; pushed_at?: string }[]> {
		const r = (await this.call('/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator')) as {
			full_name: string
			private: boolean
			permissions?: { push?: boolean }
			pushed_at?: string
		}[]
		return r.map((x) => ({ full_name: x.full_name, private: x.private, canWrite: !!x.permissions?.push, pushed_at: x.pushed_at }))
	}

	/** The repository's name and whether the token can write to it. */
	async check(): Promise<{ full_name: string; private: boolean; canWrite: boolean; defaultBranch: string }> {
		const r = (await this.call(`/repos/${this.where}`)) as { full_name: string; private: boolean; permissions?: { push?: boolean }; default_branch: string }
		return { full_name: r.full_name, private: r.private, canWrite: !!r.permissions?.push, defaultBranch: r.default_branch }
	}

	/** What is in a folder. Used to find the team's members without a search. */
	async list(path: string): Promise<{ name: string; path: string; sha: string }[]> {
		const query = this.repo.branch ? `?ref=${encodeURIComponent(this.repo.branch)}` : ''
		try {
			const r = (await this.call(`/repos/${this.where}/contents/${encode(path)}${query}`)) as { name: string; path: string; sha: string; type: string }[]
			return Array.isArray(r) ? r.filter((f) => f.type === 'file').map((f) => ({ name: f.name, path: f.path, sha: f.sha })) : []
		} catch (e) {
			if (e instanceof GitHubError && e.status === 404) return []
			throw e
		}
	}

	/**
	 * A file's bytes, still base64 — for a screenshot, which must not be put
	 * through a text decode on the way back.
	 */
	async readBinary(path: string): Promise<string | null> {
		const query = this.repo.branch ? `?ref=${encodeURIComponent(this.repo.branch)}` : ''
		try {
			const r = (await this.call(`/repos/${this.where}/contents/${encode(path)}${query}`)) as { content?: string }
			return r.content ? r.content.replace(/\s/g, '') : null
		} catch (e) {
			if (e instanceof GitHubError && e.status === 404) return null
			throw e
		}
	}

	/** A file's current contents and its blob sha, or null if it is not there. */
	async read(path: string): Promise<{ text: string; sha: string } | null> {
		const query = this.repo.branch ? `?ref=${encodeURIComponent(this.repo.branch)}` : ''
		try {
			const r = (await this.call(`/repos/${this.where}/contents/${encode(path)}${query}`)) as { content?: string; encoding?: string; sha: string }
			if (!r.content) return null
			// GitHub wraps base64 at 60 characters; atob will not have the newlines.
			return { text: decode(r.content.replace(/\s/g, '')), sha: r.sha }
		} catch (e) {
			if (e instanceof GitHubError && e.status === 404) return null
			throw e
		}
	}

	/**
	 * Every file in the branch, with its blob sha — or null when nothing has
	 * moved since `etag`. GitHub answers an unchanged conditional request with a
	 * 304 that does not count against the rate limit, which is what makes
	 * checking every few minutes free when nobody wrote anything.
	 */
	async treeIfChanged(etag?: string): Promise<{ etag?: string; files: { path: string; sha: string }[] } | null> {
		const branch = this.repo.branch?.trim() || (await this.check()).defaultBranch
		const res = await this.fetchFn(`${API}/repos/${this.where}/git/trees/${encodeURIComponent(branch)}?recursive=1`, {
			// The ETag is handled here, not by the browser's cache (see `call`).
			cache: 'no-store',
			headers: {
				Accept: 'application/vnd.github+json',
				Authorization: `Bearer ${this.token}`,
				'X-GitHub-Api-Version': '2022-11-28',
				...(etag ? { 'If-None-Match': etag } : {}),
			},
		})
		if (res.status === 304) return null
		const text = await res.text()
		// An empty repository has no tree yet: nothing to read, not an error.
		if (res.status === 404 || res.status === 409) return { files: [] }
		if (!res.ok) throw new GitHubError(res.status, explain(res.status, text))
		const r = JSON.parse(text) as { tree: { path: string; sha: string; type: string }[] }
		return { etag: res.headers.get('ETag') ?? undefined, files: r.tree.filter((t) => t.type === 'blob').map((t) => ({ path: t.path, sha: t.sha })) }
	}

	// ── issues, for notes left on a page ──────────────────────────────────
	// A note on a page is an issue: somewhere the team already looks, already
	// gets notified about, and can close. Nothing here invents a workflow.

	async openIssue(title: string, body: string, labels: string[] = []): Promise<{ number: number; url: string }> {
		const r = (await this.call(`/repos/${this.where}/issues`, { method: 'POST', body: JSON.stringify({ title, body, labels }) })) as { number: number; html_url: string }
		return { number: r.number, url: r.html_url }
	}

	async issue(number: number): Promise<{ number: number; title: string; body: string; state: 'open' | 'closed'; user: string; at: string; url: string } | null> {
		try {
			const r = (await this.call(`/repos/${this.where}/issues/${number}`)) as { number: number; title: string; body?: string; state: 'open' | 'closed'; user?: { login?: string }; created_at: string; html_url: string }
			return { number: r.number, title: r.title, body: r.body ?? '', state: r.state, user: r.user?.login ?? '', at: r.created_at, url: r.html_url }
		} catch (e) {
			if (e instanceof GitHubError && e.status === 404) return null
			throw e
		}
	}

	async issueComments(number: number): Promise<{ author: string; text: string; at: number }[]> {
		const r = (await this.call(`/repos/${this.where}/issues/${number}/comments?per_page=50`)) as { user?: { login?: string }; body?: string; created_at: string }[]
		return r.map((c) => ({ author: c.user?.login ?? '', text: c.body ?? '', at: Date.parse(c.created_at) }))
	}

	async replyToIssue(number: number, body: string): Promise<void> {
		await this.call(`/repos/${this.where}/issues/${number}/comments`, { method: 'POST', body: JSON.stringify({ body }) })
	}

	async closeIssue(number: number, state: 'open' | 'closed' = 'closed'): Promise<void> {
		await this.call(`/repos/${this.where}/issues/${number}`, { method: 'PATCH', body: JSON.stringify({ state }) })
	}

	/** Every note the repository holds, newest first — for rebuilding the index. */
	async issuesWith(label: string): Promise<{ number: number; title: string; body: string; state: 'open' | 'closed'; user: string; at: string }[]> {
		const r = (await this.call(`/repos/${this.where}/issues?state=all&per_page=100&labels=${encodeURIComponent(label)}`)) as {
			number: number
			title: string
			body?: string
			state: 'open' | 'closed'
			user?: { login?: string }
			created_at: string
		}[]
		return r.map((i) => ({ number: i.number, title: i.title, body: i.body ?? '', state: i.state, user: i.user?.login ?? '', at: i.created_at }))
	}

	// ── release assets, for the things too big to commit ──────────────────
	//
	// Git keeps every version of every file for ever: a three-hundred-megabyte
	// recording committed once makes every clone of that repository three
	// hundred megabytes for ever, and GitHub blocks a single blob over a hundred
	// anyway. A release asset sits beside the repository rather than inside it —
	// two gigabytes each, no history, and a plain URL anyone on the repository
	// can open.

	/** The release everything is attached to, made the first time it is needed. */
	private async releaseFor(tag: string): Promise<{ id: number }> {
		try {
			return (await this.call(`/repos/${this.where}/releases/tags/${encodeURIComponent(tag)}`)) as { id: number }
		} catch (e) {
			if (!(e instanceof GitHubError) || e.status !== 404) throw e
		}
		return (await this.call(`/repos/${this.where}/releases`, {
			method: 'POST',
			body: JSON.stringify({
				tag_name: tag,
				name: 'WorkPulse recordings',
				body: 'Screen recordings attached to WorkPulse notes. Kept here rather than committed: git keeps every version of every file for ever.',
				// Not a release anybody is meant to install; keeping it out of the
				// repository's release list is the polite thing to do.
				prerelease: true,
			}),
		})) as { id: number }
	}

	/**
	 * One file, attached to that release. Returns where it can be opened.
	 *
	 * The upload host is a different one from the API, and it wants the bytes
	 * themselves rather than JSON — which is the whole reason this does not go
	 * through `call`.
	 */
	async uploadAsset(tag: string, name: string, blob: Blob): Promise<string> {
		const release = await this.releaseFor(tag)
		// A name already taken answers 422 rather than replacing, so the old one
		// goes first. Re-uploading the same recording is a retry, not a second file.
		const existing = (await this.call(`/repos/${this.where}/releases/${release.id}/assets`)) as { id: number; name: string }[]
		for (const a of existing.filter((a) => a.name === name)) {
			await this.call(`/repos/${this.where}/releases/assets/${a.id}`, { method: 'DELETE' }).catch(() => undefined)
		}
		const res = await this.fetchFn(`https://uploads.github.com/repos/${this.where}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
			method: 'POST',
			headers: {
				Accept: 'application/vnd.github+json',
				Authorization: `Bearer ${this.token}`,
				'X-GitHub-Api-Version': '2022-11-28',
				'Content-Type': blob.type || 'application/octet-stream',
			},
			body: blob,
		})
		const text = await res.text()
		if (!res.ok) throw new GitHubError(res.status, explain(res.status, text))
		return (JSON.parse(text) as { browser_download_url: string }).browser_download_url
	}

	/**
	 * Writes every file as a single commit. The Contents API would be one commit
	 * per file — six a day for a backup that is one event — so this goes through
	 * the git data API instead: build a tree on top of the current one, commit
	 * it, move the branch. Four requests whatever the number of files.
	 *
	 * A repository with no commits in it is handled rather than refused: the tree
	 * is built from nothing, the commit has no parent, and the branch is created.
	 */
	/**
	 * Writes every file as a single commit, retrying if the branch moved.
	 *
	 * Two people on one team repository commit to the same branch. Their
	 * *content* never collides — each writes only their own file — but the ref
	 * update does: whoever is second is told the branch has moved and has to
	 * build on the new head. That is not an error to show anybody, it is a race
	 * to lose politely and run again.
	 */
	async commit(files: CommitFile[], message: string, tries = 3): Promise<{ sha: string; files: number } | null> {
		for (let i = 0; ; i++) {
			try {
				return await this.commitOnce(files, message)
			} catch (e) {
				const moved = e instanceof GitHubError && (e.status === 409 || e.status === 422)
				if (!moved || i >= tries - 1) throw e
				// Someone else got there first. Wait a moment — longer each time —
				// and build on what they wrote.
				await new Promise((r) => setTimeout(r, 300 * (i + 1)))
			}
		}
	}

	private async commitOnce(files: CommitFile[], message: string): Promise<{ sha: string; files: number } | null> {
		if (!files.length) return null
		const named = this.repo.branch?.trim()
		const branch = named || (await this.check()).defaultBranch
		let head = await this.ref(branch)

		// A named branch that is not there yet — the `brain` branch beside a repository's
		// code — starts empty, the way the CLI starts it: no shared history with the code.
		// That needs a git database, so it is only possible once the repository has a commit.
		if (!head && named) {
			const main = await this.ref((await this.check()).defaultBranch)
			if (main) return this.orphan(files, branch, message)
		}

		// A repository with no commits at all has no git database yet: the tree and
		// commit endpoints answer 409 until something has been written. The contents
		// API is the one thing that works there, so the first file goes through it
		// and starts the history; everything after this is the normal path.
		if (!head) {
			const [first, ...rest] = files
			try {
				await this.putFile(first.path, first.raw ? first.content : encode64(first.content), message, branch)
			} catch (e) {
				// GitHub may refuse to start an empty repository on a branch that does not
				// exist. Then the repository starts on its own default branch with a line
				// saying where the notes are, and the notes go to their branch as above.
				if (!named || !(e instanceof GitHubError) || (e.status !== 404 && e.status !== 422)) throw e
				await this.putFile('README.md', encode64(`# WorkPulse notes\n\nThe notes are on the \`${branch}\` branch.\n`), 'Start the repository', (await this.check()).defaultBranch)
				return this.orphan(files, branch, message)
			}
			if (!rest.length) return { sha: '', files: 1 }
			head = await this.ref(branch)
			if (!head) throw new GitHubError(409, 'GitHub accepted the first file but the branch is still not there. Try again in a moment.')
			return this.onto(head, rest, branch, message).then((r) => ({ ...r, files: files.length }))
		}
		return this.onto(head, files, branch, message)
	}

	/** The tree entries for these files. */
	private entries(files: CommitFile[]) {
		// Text goes inline, which creates the blob as part of the tree. Bytes
		// cannot: a PNG inlined as a string would be mangled, so it becomes a
		// base64 blob of its own first and the tree points at the sha.
		return Promise.all(
			files.map(async (f) => {
				if (!f.raw) return { path: f.path, mode: '100644', type: 'blob', content: f.content }
				const blob = (await this.call(`/repos/${this.where}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: f.content, encoding: 'base64' }) })) as { sha: string }
				return { path: f.path, mode: '100644', type: 'blob', sha: blob.sha }
			}),
		)
	}

	/** A new branch holding only these files: a tree from nothing, a commit with no parent, then the ref. */
	private async orphan(files: CommitFile[], branch: string, message: string): Promise<{ sha: string; files: number }> {
		const tree = (await this.call(`/repos/${this.where}/git/trees`, { method: 'POST', body: JSON.stringify({ tree: await this.entries(files) }) })) as { sha: string }
		const commit = (await this.call(`/repos/${this.where}/git/commits`, { method: 'POST', body: JSON.stringify({ message, tree: tree.sha, parents: [] }) })) as { sha: string }
		// 422 here means someone made the branch a moment ago; commit() retries and builds on it.
		await this.call(`/repos/${this.where}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }) })
		return { sha: commit.sha, files: files.length }
	}

	/** One commit of these files on top of `head`. */
	private async onto(head: { commitSha: string; treeSha: string }, files: CommitFile[], branch: string, message: string): Promise<{ sha: string; files: number }> {
		const entries = await this.entries(files)
		const tree = (await this.call(`/repos/${this.where}/git/trees`, {
			method: 'POST',
			body: JSON.stringify({ base_tree: head.treeSha, tree: entries }),
		})) as { sha: string }

		const commit = (await this.call(`/repos/${this.where}/git/commits`, {
			method: 'POST',
			body: JSON.stringify({ message, tree: tree.sha, parents: [head.commitSha] }),
		})) as { sha: string }

		await this.call(`/repos/${this.where}/git/refs/heads/${encodeURIComponent(branch)}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) })
		return { sha: commit.sha, files: files.length }
	}

	/**
	 * One file through the contents API — the only write an empty repository
	 * takes. `content` is already base64 here, since that is what this endpoint
	 * wants either way.
	 */
	private async putFile(path: string, content: string, message: string, branch: string): Promise<void> {
		const existing = await this.read(path).catch(() => null)
		await this.call(`/repos/${this.where}/contents/${encode(path)}`, {
			method: 'PUT',
			body: JSON.stringify({ message, content, branch, ...(existing ? { sha: existing.sha } : {}) }),
		})
	}

	/** Where the branch points, and the tree it points at. Null for an empty repository. */
	private async ref(branch: string): Promise<{ commitSha: string; treeSha: string } | null> {
		try {
			const r = (await this.call(`/repos/${this.where}/git/ref/heads/${encodeURIComponent(branch)}`)) as { object: { sha: string } }
			const commit = (await this.call(`/repos/${this.where}/git/commits/${r.object.sha}`)) as { tree: { sha: string } }
			return { commitSha: r.object.sha, treeSha: commit.tree.sha }
		} catch (e) {
			// A repository with no commits in it answers 409 "Git Repository is
			// empty" here, not 404 — which is the whole reason this path exists.
			if (e instanceof GitHubError && (e.status === 404 || e.status === 409)) return null
			throw e
		}
	}
}

/** Each path segment encoded, but the slashes kept — they are the path. */
const encode = (path: string) => path.split('/').map(encodeURIComponent).join('/')

/** UTF-8 safe base64 both ways: notes contain em dashes and emoji. */
export function encode64(text: string): string {
	const bytes = new TextEncoder().encode(text)
	let binary = ''
	for (const b of bytes) binary += String.fromCharCode(b)
	return btoa(binary)
}

export function decode(base64: string): string {
	const binary = atob(base64)
	const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
	return new TextDecoder().decode(bytes)
}

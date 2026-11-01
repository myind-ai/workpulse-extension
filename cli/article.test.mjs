// node --test cli/article.test.mjs
// readable() on saved HTML, and `wp-brain learn` against a local server. Never the network, never the real working folder.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MIN_WORDS, readable } from './article.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, 'wp-brain.mjs')
const INDEXER = join(here, '..', 'plugins', 'youtube-learning', 'skills', 'youtube-learning', 'scripts', 'yt_learn.py')
const WORDS = (n, w = 'word') => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ')

test('article wins over the rest of the page', () => {
	const html = `<html><head><title>T</title></head><body><div>${WORDS(80, 'side')}</div>
		<article><h1>Head</h1><p>Real ${WORDS(5, 'body')}</p></article><main>${WORDS(60, 'main')}</main></body></html>`
	const r = readable(html, 'http://x.test/a')
	assert.match(r.text, /Real body0/)
	assert.doesNotMatch(r.text, /side0|main0/)
})

test('main is next, then the longest text block', () => {
	const m = readable(`<body><div>${WORDS(50, 'side')}</div><main><p>${WORDS(10, 'mn')}</p></main></body>`, 'http://x.test/')
	assert.match(m.text, /mn0/)
	assert.doesNotMatch(m.text, /side0/)
	const d = readable(`<body><div><a>menu one</a> <a>menu two</a></div><div id=c><p>${WORDS(40, 'long')}</p><p>${WORDS(40, 'more')}</p></div></body>`, 'http://x.test/')
	assert.match(d.text, /long0/)
	assert.doesNotMatch(d.text, /menu one/)
})

test('script, style, nav, aside, footer and form text is gone; entities decoded', () => {
	const html = `<article><script>var secret=1</script><style>.x{}</style><nav>NAVTEXT</nav><aside>ASIDETEXT</aside>
		<form>FORMTEXT</form><p>Fish &amp; chips &lt;3 &#39;quoted&#39; &#x41;&nbsp;done</p><footer>FOOTTEXT</footer></article>`
	const { text } = readable(html, 'http://x.test/')
	for (const bad of ['secret', 'NAVTEXT', 'ASIDETEXT', 'FORMTEXT', 'FOOTTEXT', '.x{}']) assert.ok(!text.includes(bad), bad)
	assert.match(text, /Fish & chips <3 'quoted' A done/)
})

test('title: og:title, then <title>; words counted', () => {
	const a = readable(`<head><title>Plain</title><meta property="og:title" content="Og &amp; Title"><meta name="author" content="Ann"></head><article>${WORDS(7)}</article>`, 'http://x.test/')
	assert.equal(a.title, 'Og & Title')
	assert.equal(a.by, 'Ann')
	assert.equal(a.words, 7)
	assert.equal(readable('<head><title> Plain </title></head><article>hi</article>', 'http://x.test/').title, 'Plain')
})

/** A local server: /a article, /empty 2 words, /doc.pdf PDF. */
async function withServer(fn) {
	const server = createServer((req, res) => {
		if (req.url === '/a') {
			res.setHeader('content-type', 'text/html; charset=utf-8')
			res.end(`<html><head><title>My Page</title><meta name="author" content="Ann"></head><body><nav>menu</nav><article><h1>My Page</h1><p>${WORDS(120)}</p></article></body></html>`)
		} else if (req.url.startsWith('/w')) {
			res.setHeader('content-type', 'text/html')
			res.end(`<article>${WORDS(Number(req.url.slice(2)))}</article>`)
		} else if (req.url === '/huge') {
			res.setHeader('content-type', 'text/html') // no content-length: chunked
			const chunk = `<p>${WORDS(100_000)}</p>`
			let sent = 0
			const pump = () => {
				while (sent < 6 * 1024 * 1024) {
					sent += chunk.length
					if (!res.write(chunk)) return res.once('drain', pump)
				}
				res.end()
			}
			res.on('error', () => {})
			pump()
		} else if (req.url === '/redir') {
			res.statusCode = 302
			res.setHeader('location', 'file:///etc/passwd')
			res.end()
		} else if (req.url === '/empty') {
			res.setHeader('content-type', 'text/html')
			res.end('<html><head><title>Login</title></head><body><p>please login</p></body></html>')
		} else {
			res.setHeader('content-type', 'application/pdf')
			res.end('%PDF-1.4')
		}
	})
	await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
	try {
		return await fn(`http://127.0.0.1:${server.address().port}`)
	} finally {
		server.close()
	}
}

const learn = (url, root) =>
	new Promise((ok) => {
		const p = spawn('node', [CLI, 'learn', url, '--root', root], { env: { ...process.env, WP_BRAIN_CONFIG: join(root, 'no-such.json') } })
		let out = ''
		let err = ''
		p.stdout.on('data', (d) => (out += d))
		p.stderr.on('data', (d) => (err += d))
		p.on('close', (status) => ok({ status, out, err }))
	})

test('learn writes the folder, reuses it, keeps notes, and index lists it', async () => {
	const root = mkdtempSync(join(tmpdir(), 'wp-learn-'))
	await withServer(async (base) => {
		const r = await learn(`${base}/a`, root)
		assert.equal(r.status, 0, r.err)
		const j = JSON.parse(r.out.trim())
		assert.equal(j.title, 'My Page')
		assert.equal(j.words, 122)
		assert.deepEqual(j.problems, [])
		assert.match(j.folder, /_my-page_[0-9a-f]{8}$/)
		for (const f of ['article.md', 'meta.json', 'notes.md']) assert.ok(existsSync(join(j.folder, f)), f)
		assert.doesNotMatch(readFileSync(join(j.folder, 'article.md'), 'utf8'), /menu/)
		assert.match(readFileSync(join(j.folder, 'notes.md'), 'utf8'), /<!-- status: pending/)
		const meta = JSON.parse(readFileSync(join(j.folder, 'meta.json'), 'utf8'))
		assert.equal(meta.source_type, 'site')
		assert.equal(meta.webpage_url, `${base}/a`)

		writeFileSync(join(j.folder, 'notes.md'), 'MY NOTES\n')
		const again = JSON.parse((await learn(`${base}/a`, root)).out.trim())
		assert.equal(again.folder, j.folder)
		assert.equal(readFileSync(join(j.folder, 'notes.md'), 'utf8'), 'MY NOTES\n')
		assert.equal(readdirSync(root).filter((d) => d !== 'INDEX.md').length, 1)

		const idx = spawnSync('python3', ['-I', INDEXER, 'index', '--root', root], { encoding: 'utf8' })
		assert.equal(idx.status, 0, idx.stderr)
		assert.match(readFileSync(join(root, 'INDEX.md'), 'utf8'), /\[My Page\]\(.*\/notes\.md\) \| Ann/)
	})
})

test('learn refuses a page with too little text and writes no folder', async () => {
	const root = mkdtempSync(join(tmpdir(), 'wp-learn-'))
	await withServer(async (base) => {
		const r = await learn(`${base}/empty`, root)
		assert.notEqual(r.status, 0)
		assert.match(r.err, /couldn't read this page \(login or JavaScript\?\)/)
		assert.deepEqual(readdirSync(root), [])
	})
})

test('learn refuses a PDF by content type and a non-http url', async () => {
	const root = mkdtempSync(join(tmpdir(), 'wp-learn-'))
	await withServer(async (base) => {
		const r = await learn(`${base}/doc.pdf`, root)
		assert.notEqual(r.status, 0)
		assert.match(r.err, /application\/pdf/)
		const f = await learn('file:///etc/passwd', root)
		assert.notEqual(f.status, 0)
		assert.match(f.err, /http/)
		assert.deepEqual(readdirSync(root), [])
	})
})

test('the word floor is 100: 99 words is refused, 100 is saved', async () => {
	assert.equal(MIN_WORDS, 100)
	const root = mkdtempSync(join(tmpdir(), 'wp-learn-'))
	await withServer(async (base) => {
		const no = await learn(`${base}/w99`, root)
		assert.notEqual(no.status, 0)
		assert.match(no.err, /couldn't read this page/)
		assert.deepEqual(readdirSync(root), [])
		const yes = await learn(`${base}/w100`, root)
		assert.equal(yes.status, 0, yes.err)
		assert.equal(JSON.parse(yes.out.trim()).words, 100)
	})
})

test('a body over 5 MB with no content-length is refused; a redirect to a non-http url is refused', async () => {
	const root = mkdtempSync(join(tmpdir(), 'wp-learn-'))
	await withServer(async (base) => {
		const big = await learn(`${base}/huge`, root)
		assert.notEqual(big.status, 0)
		assert.match(big.err, /over 5 MB/)
		const r = await learn(`${base}/redir`, root)
		assert.notEqual(r.status, 0)
		assert.match(r.err, /http/)
		assert.deepEqual(readdirSync(root), [])
	})
})

// Hostile pages: the parse is synchronous, so it has to be linear in the size of the page.
const timed = (html) => {
	const t = Date.now()
	const r = readable(html, 'http://x.test/')
	return { ms: Date.now() - t, r }
}
test('unclosed tags are parsed in linear time (about 200 KB each)', () => {
	const shapes = {
		nav: `<article>${WORDS(120)}${'<nav>'.repeat(40_000)}</article>`,
		'div no >': `<article>${WORDS(120)}${'<div '.repeat(40_000)}`,
		article: '<article>'.repeat(22_000) + WORDS(120),
	}
	for (const [name, html] of Object.entries(shapes)) {
		const { ms, r } = timed(html)
		assert.ok(ms < 1000, `${name}: ${ms} ms`)
		assert.ok(r.words >= 100 || name === 'nav', name)
	}
})
test('a 5 MB page of unclosed <div  finishes in bounded time', () => {
	const { ms } = timed('<div '.repeat(1_048_576))
	assert.ok(ms < 5000, `${ms} ms`)
})
test('unclosed script and style text never reaches the article; nested nav tails are dropped', () => {
	const a = readable(`<article><p>keep ${WORDS(5)}</p><script>var LEAKED=1; ${WORDS(5, 'js')}`, 'http://x.test/')
	assert.match(a.text, /keep/)
	assert.doesNotMatch(a.text, /LEAKED|js0/)
	const b = readable(`<article><p>keep</p><style>.LEAKEDCSS{color:red}`, 'http://x.test/')
	assert.doesNotMatch(b.text, /LEAKEDCSS/)
	const c = readable('<article><p>keep</p><nav>NAVA<nav>NAVB</nav>NAVTAIL</nav><p>after</p></article>', 'http://x.test/')
	assert.doesNotMatch(c.text, /NAV/)
	assert.match(c.text, /after/)
	const d = readable('<article><p>keep</p><footer>F1<footer>F2</footer>FTAIL</footer><form>X<form>Y</form>FORMTAIL</form></article>', 'http://x.test/')
	assert.doesNotMatch(d.text, /F1|F2|FTAIL|FORMTAIL/)
})

test('an open or self-closed nav, form, aside or svg never hides the article (150 words each)', () => {
	const A = (inner = '') => `<article><p>${WORDS(75, 'a')}</p>${inner}<p>${WORDS(75, 'b')}</p></article>`
	const pages = {
		'<nav/> before': `<nav/>${A()}`,
		'<nav/> in header': `<header><nav/></header>${A()}`,
		'unclosed form before': `<form>${A()}`,
		'unclosed form, text only': `<form><div>${WORDS(150)}</div>`,
		'unclosed aside inside': A('<aside>side'),
		'<svg/> inside': A('<svg/>'),
		'unclosed nav before': `<nav><a>menu</a>${A()}`,
		'webforms': `<form action="x"><div><article>${WORDS(150)}</article></div></form>`,
	}
	for (const [name, html] of Object.entries(pages)) assert.ok(readable(html, 'http://x.test/').words >= 100, `${name}: ${readable(html, 'http://x.test/').words}`)
})

test('unclosed noscript and template text never reaches the article', () => {
	const n = readable(`<article><p>keep ${WORDS(5)}</p><noscript>NSLEAK ${WORDS(5, 'ns')}`, 'http://x.test/')
	assert.doesNotMatch(n.text, /NSLEAK|ns0/)
	const t = readable(`<article><p>keep ${WORDS(5)}</p><template>TPLEAK ${WORDS(5, 'tp')}`, 'http://x.test/')
	assert.doesNotMatch(t.text, /TPLEAK|tp0/)
	assert.match(t.text, /keep/)
	// the retry with skip tags kept must not let script text in either
	const r = readable(`<form><script>JSLEAK ${WORDS(150, 'js')}</script><article><p>${WORDS(120)}</p></article>`, 'http://x.test/')
	assert.doesNotMatch(r.text, /JSLEAK/)
	const r2 = readable(`<nav><script>JSLEAK2 ${WORDS(5)}</script>${WORDS(150)}`, 'http://x.test/')
	assert.doesNotMatch(r2.text, /JSLEAK2/)
	assert.ok(r2.words >= 100)
})

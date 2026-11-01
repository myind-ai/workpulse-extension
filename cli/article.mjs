// wp-brain learn — save a web article as a learning folder, the way yt_learn.py saves a video.
//
// readable() is a pure function: HTML in, the article's text out (built-ins only, no parser library).
// learn() fetches the page and writes <root>/<date>_<slug>_<hash8>/ with article.md, meta.json and a
// pending notes.md, in the shape `yt_learn.py index` reads. It needs no Brain config and makes no commit;
// the library and the lessons come afterwards (`library add --type site`, `add --source-type site`).

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MIN_WORDS = 100
export const MAX_BYTES = 5 * 1024 * 1024
export const TIMEOUT_MS = 20_000
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' }

export function decode(s) {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
		if (e[0] === '#') {
			const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
			return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m
		}
		return NAMED[e.toLowerCase()] ?? m
	})
}

const countWords = (s) => (s.match(/\S+/g) || []).length
const RAW = ['script', 'style', 'noscript', 'template'] // text up to the closer, or to the end of the page when there is none
const SKIP = ['nav', 'aside', 'footer', 'form', 'svg'] // dropped with everything inside, nesting counted
const FRAME = ['article', 'main', 'div', 'section', 'body']
const rawEnd = Object.fromEntries([...RAW, 'title'].map((n) => [n, new RegExp(`</${n}\\b`, 'gi')]))

/** Entities decoded, whitespace collapsed. */
function tidy(t) {
	return decode(t)
		.replace(/[ \t\f\v\u00a0]+/g, ' ')
		.replace(/ ?\n ?/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
}

const attr = (tag, name) => {
	const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'))
	return m ? decode(m[1] ?? m[2]) : ''
}

/**
 * One pass over the page, linear in its size: every step moves forward past what it read, and a `<` with no
 * `>` after it is plain text. Text is written to `out` with a running word count, so a block's words and its
 * text are two array slices, never a re-parse.
 */
function scan(html, keepSkipped = false) {
	const out = []
	const cum = [0] // cum[k] = words in out[0..k)
	const emit = (s, words) => {
		out.push(s)
		cum.push(cum[cum.length - 1] + (words ? countWords(s) : 0))
	}
	const meta = {}
	const info = { title: '', time: '' }
	const open = { root: { name: '#root', start: 0, kids: 0 } }
	const stack = [open.root]
	const count = {}
	const blocks = { article: [], main: [], block: [] }
	let skip = 0
	let skipped = false
	const finish = (f) => {
		const end = out.length
		const total = cum[end] - cum[f.start]
		stack[stack.length - 1].kids += total
		const row = { start: f.start, end, total, own: total - f.kids }
		if (f.name === 'article' || f.name === 'main') blocks[f.name].push(row)
		else blocks.block.push(row)
	}
	const lastGt = html.lastIndexOf('>')
	let i = 0
	const n = html.length
	while (i < n) {
		const lt = html.indexOf('<', i)
		if (lt < 0 || lt > lastGt) {
			if (!skip) emit(html.slice(i), true)
			break
		}
		if (lt > i && !skip) emit(html.slice(i, lt), true)
		const c = html[lt + 1]
		if (c === '!' && html.startsWith('<!--', lt)) {
			const e = html.indexOf('-->', lt + 4)
			if (e < 0) break
			i = e + 3
			continue
		}
		if (!(c === '/' || c === '!' || c === '?' || /[a-z]/i.test(c ?? ''))) {
			if (!skip) emit('<', true)
			i = lt + 1
			continue
		}
		const gt = html.indexOf('>', lt)
		const tag = html.slice(lt, gt + 1)
		i = gt + 1
		const m = /^<(\/?)([a-z][a-z0-9:-]*)/i.exec(tag.length > 64 ? tag.slice(0, 64) : tag)
		if (!m) continue
		const closing = m[1] === '/'
		const name = m[2].toLowerCase()
		if (!closing && (RAW.includes(name) || name === 'title')) {
			const re = rawEnd[name]
			re.lastIndex = i
			const end = re.exec(html)
			if (name === 'title' && !info.title) info.title = tidy(html.slice(i, end ? end.index : n)).replace(/\s+/g, ' ')
			if (!end) break // an unclosed script or style: everything after it is its text
			const g = html.indexOf('>', end.index)
			i = g < 0 ? n : g + 1
			continue
		}
		if (name === 'meta' && !closing) {
			const k = (attr(tag, 'property') || attr(tag, 'name') || attr(tag, 'itemprop')).toLowerCase()
			if (k && !(k in meta) && attr(tag, 'content').trim()) meta[k] = attr(tag, 'content').trim()
			continue
		}
		if (name === 'time' && !closing && !info.time) info.time = attr(tag, 'datetime')
		if ((name === 'article' || name === 'main') && skip) skip = 0 // an open nav/form never swallows the article
		if (SKIP.includes(name)) {
			if (/\/\s*>$/.test(tag)) continue // self-closed: nothing inside
			if (!closing) {
				skipped = true
				if (!keepSkipped) skip++
			} else if (skip) skip--
			continue
		}
		if (skip) continue
		if (FRAME.includes(name)) {
			if (!closing) {
				const f = { name, start: out.length, kids: 0 }
				stack.push(f)
				count[name] = (count[name] || 0) + 1
			} else if (count[name]) {
				if (name === 'article' || name === 'main') skip = 0
				for (;;) {
					const f = stack.pop()
					count[f.name]--
					finish(f)
					if (f.name === name) break
				}
			}
			emit('\n\n', false)
		} else if (/^h[1-6]$/.test(name)) emit(closing ? '\n\n' : '\n\n## ', false)
		else if (name === 'li') emit(closing ? '\n' : '\n- ', false)
		else if (name === 'br' || ['p', 'pre', 'blockquote', 'tr', 'ul', 'ol', 'table'].includes(name)) emit('\n\n', false)
	}
	while (stack.length > 1) finish(stack.pop())
	finish(open.root)
	const best = (rows, key) => rows.reduce((a, r) => (!a || r[key] > a[key] ? r : a), null)
	const pick = [best(blocks.article, 'total'), best(blocks.main, 'total')].find((r) => r && r.total > 0) || best(blocks.block, 'own')
	return { meta, info, skipped, text: pick ? out.slice(pick.start, pick.end).join('') : '' }
}

/** { title, by, published, text, words } of an HTML page. `url` is the fallback title. */
export function readable(html, url) {
	let { meta, info, text: raw, skipped } = scan(html)
	let text = tidy(raw)
	let words = countWords(text.replace(/^(## |- )/gm, ''))
	if (skipped && words < MIN_WORDS) {
		// An open nav/form/aside may have swallowed the page: read again with those tags kept (script and style stay out).
		const again = tidy(scan(html, true).text)
		const w = countWords(again.replace(/^(## |- )/gm, ''))
		if (words === 0 ? w > 0 : w >= MIN_WORDS) ({ text, words } = { text: again, words: w })
	}
	return {
		title: meta['og:title'] || info.title || url,
		by: meta.author || meta['article:author'] || meta['og:site_name'] || '',
		published: meta['article:published_time'] || meta.datepublished || meta.date || info.time,
		text,
		words,
	}
}

export const slugify = (s, max = 60) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'page'
export const urlHash = (url) => createHash('sha1').update(url).digest('hex').slice(0, 8)

/** Fetches the page text; refuses anything but http(s) HTML or text, over 5 MB, or slower than 20 s. */
export async function fetchPage(url) {
	let u
	try {
		u = new URL(url)
	} catch {
		throw new Error(`"${url}" is not a web address.`)
	}
	if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http and https addresses can be learned from.')
	let res
	for (let hop = 0; ; hop++) {
		res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'Mozilla/5.0 (wp-brain learn)', accept: 'text/html,text/plain;q=0.9' } })
		const to = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
		if (!to) break
		if (hop >= 5) throw new Error('Too many redirects.')
		u = new URL(to, u)
		if (!['http:', 'https:'].includes(u.protocol)) throw new Error('The page redirected somewhere that is not http or https.')
	}
	if (!res.ok) throw new Error(`The page answered HTTP ${res.status}.`)
	const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
	if (type && !['text/html', 'application/xhtml+xml', 'text/plain'].includes(type)) throw new Error(`This is ${type}, not a web page; download it and read it directly.`)
	const reader = res.body.getReader()
	const chunks = []
	let size = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		size += value.length
		if (size > MAX_BYTES) {
			await reader.cancel()
			throw new Error('The page is over 5 MB; nothing was saved.')
		}
		chunks.push(value)
	}
	return { html: Buffer.concat(chunks).toString('utf8'), type }
}

const NOTES_TEMPLATE = (title, today, url, by, words) => `# ${title}

Updated: ${today}
Learning notes on [${title}](${url}) by ${by} (${words} words).
Article: [article.md](article.md)

<!-- status: pending. Claude fills every section from article.md, then deletes this line. -->

## In one paragraph

## Key points

## Takeaways I can use

## Try next

- [ ] 

## Terms, tools and links mentioned

| Name | What it is | Where |
|---|---|---|

## Questions and things to check

## Recorded in the Brain

<!-- The [id] of each learning sent with \`wp-brain add learning\`. -->
`

/** Saves url under root; returns { folder, title, words, problems }. Throws, writing nothing, when the page has no readable text. */
export async function learn(url, root) {
	const { html, type } = await fetchPage(url)
	const page = type === 'text/plain' ? { title: url, by: '', published: '', text: html.trim(), words: countWords(html) } : readable(html, url)
	if (page.words < MIN_WORDS) throw new Error("couldn't read this page (login or JavaScript?)")
	const id = urlHash(url)
	const by = page.by || new URL(url).hostname
	mkdirSync(root, { recursive: true })
	const existing = readdirSync(root).find((d) => d.endsWith(`_${id}`))
	const today = new Date().toISOString().slice(0, 10)
	const folder = join(root, existing ?? `${today}_${slugify(page.title)}_${id}`)
	mkdirSync(folder, { recursive: true })
	const metaPath = join(folder, 'meta.json')
	const savedAt = existing && existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')).saved_at || today : today
	const head = [`# ${page.title}`, '', `Source: ${url}`, ...(page.by ? [`By: ${page.by}`] : []), ...(page.published ? [`Published: ${page.published}`] : []), '']
	writeFileSync(join(folder, 'article.md'), `${head.join('\n')}\n${page.text}\n`)
	writeFileSync(metaPath, JSON.stringify({ id, title: page.title, channel: by, webpage_url: url, source_type: 'site', published: page.published || undefined, saved_at: savedAt, subtitles: { kind: 'none' }, video: null, words: page.words }, null, 2) + '\n')
	const notes = join(folder, 'notes.md')
	if (!existsSync(notes)) writeFileSync(notes, NOTES_TEMPLATE(page.title, today, url, by, page.words))
	return { folder, title: page.title, words: page.words, problems: [] }
}

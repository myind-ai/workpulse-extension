// Just enough Markdown for a working note: headings, lists, checkboxes, quotes,
// code, links, emphasis. Parsed to data rather than to HTML, so the renderer can
// build elements and a pasted note can never smuggle markup into the page.

export type Span =
	| { kind: 'text' | 'code' | 'bold' | 'italic' | 'strike'; text: string }
	| { kind: 'link'; text: string; href: string }

export interface ListItem {
	spans: Span[]
	/** Present only for `- [ ]` / `- [x]` lines. */
	done?: boolean
}

export type Block =
	| { kind: 'heading'; level: 1 | 2 | 3; spans: Span[] }
	| { kind: 'para' | 'quote'; spans: Span[] }
	| { kind: 'code'; text: string }
	| { kind: 'rule' }
	| { kind: 'list'; ordered: boolean; items: ListItem[] }

/** Only addresses a browser should follow: no javascript:, no data:. */
export function safeHref(href: string): string | null {
	const h = href.trim()
	return /^https?:\/\/\S+$/i.test(h) ? h : null
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(~~[^~]+~~)|(\*[^*]+\*)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+)/

export function inline(text: string): Span[] {
	const out: Span[] = []
	let rest = text
	while (rest) {
		const m = rest.match(INLINE)
		if (!m || m.index == null) break
		if (m.index > 0) out.push({ kind: 'text', text: rest.slice(0, m.index) })
		const tok = m[0]
		if (tok.startsWith('`')) out.push({ kind: 'code', text: tok.slice(1, -1) })
		else if (tok.startsWith('**')) out.push({ kind: 'bold', text: tok.slice(2, -2) })
		else if (tok.startsWith('~~')) out.push({ kind: 'strike', text: tok.slice(2, -2) })
		else if (tok.startsWith('*')) out.push({ kind: 'italic', text: tok.slice(1, -1) })
		else if (tok.startsWith('[')) {
			const [, label, href] = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/) ?? []
			const safe = safeHref(href ?? '')
			// A link to nowhere safe stays as the text someone typed.
			out.push(safe ? { kind: 'link', text: label, href: safe } : { kind: 'text', text: tok })
		} else out.push({ kind: 'link', text: tok, href: tok })
		rest = rest.slice(m.index + tok.length)
	}
	if (rest) out.push({ kind: 'text', text: rest })
	return out.length ? out : [{ kind: 'text', text }]
}

export function parse(src: string): Block[] {
	const lines = (src ?? '').replace(/\r\n?/g, '\n').split('\n')
	const out: Block[] = []
	let para: string[] = []

	const flush = () => {
		if (para.length) out.push({ kind: 'para', spans: inline(para.join(' ')) })
		para = []
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		const t = line.trim()

		if (!t) {
			flush()
			continue
		}

		if (t.startsWith('```')) {
			flush()
			const body: string[] = []
			while (++i < lines.length && !lines[i].trim().startsWith('```')) body.push(lines[i])
			out.push({ kind: 'code', text: body.join('\n') })
			continue
		}

		if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
			flush()
			out.push({ kind: 'rule' })
			continue
		}

		const head = t.match(/^(#{1,3})\s+(.*)$/)
		if (head) {
			flush()
			out.push({ kind: 'heading', level: head[1].length as 1 | 2 | 3, spans: inline(head[2]) })
			continue
		}

		if (t.startsWith('> ') || t === '>') {
			flush()
			const body = [t.replace(/^>\s?/, '')]
			while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1].trim())) body.push(lines[++i].trim().replace(/^>\s?/, ''))
			out.push({ kind: 'quote', spans: inline(body.join(' ')) })
			continue
		}

		const bullet = t.match(/^[-*+]\s+(.*)$/)
		const number = t.match(/^\d+[.)]\s+(.*)$/)
		if (bullet || number) {
			flush()
			const ordered = !!number
			const items: ListItem[] = []
			let cur: string | undefined = (bullet ?? number)![1]
			for (;;) {
				const box = cur!.match(/^\[([ xX])\]\s*(.*)$/)
				items.push(box ? { spans: inline(box[2]), done: box[1].toLowerCase() === 'x' } : { spans: inline(cur!) })
				const next = lines[i + 1]?.trim() ?? ''
				const m = ordered ? next.match(/^\d+[.)]\s+(.*)$/) : next.match(/^[-*+]\s+(.*)$/)
				if (!m) break
				i++
				cur = m[1]
			}
			out.push({ kind: 'list', ordered, items })
			continue
		}

		para.push(t)
	}
	flush()
	return out
}

/** The first line, for a one-line preview of a collapsed note. */
export function firstLine(src: string, max = 90): string {
	const line = (src ?? '')
		.split('\n')
		.map((l) =>
			l
				.trim()
				.replace(/^(#{1,3}|>|[-*+]|\d+[.)])\s+/, '')
				.replace(/^\[[ xX]\]\s*/, '')
				.trim(),
		)
		.find(Boolean)
	const clean = (line ?? '').replace(/[*`~]/g, '')
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/**
 * Ticks or unticks the nth checkbox in a note, counted the way the renderer
 * counts them, and returns the new text. A box in a note is a real one.
 */
export function toggleBox(src: string, index: number): string {
	let seen = -1
	return (src ?? '').replace(/^(\s*[-*+]\s*)\[([ xX])\]/gm, (whole, lead: string, mark: string) =>
		++seen === index ? `${lead}[${mark.toLowerCase() === 'x' ? ' ' : 'x'}]` : whole,
	)
}

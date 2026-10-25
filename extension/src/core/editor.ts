// The rules behind the note editor: what a block is, what Enter does inside a
// list, and what the toolbar buttons change. Pure, because caret arithmetic is
// where editors go wrong and a test is cheaper than finding out in the UI.
//
// Markdown stays the stored format. The editor only decides which block you are
// typing in; every other block is rendered, which is why one line of text and
// one fenced code block both count as one block.

/** Source split into editable blocks, with fenced code kept whole. */
export function blocks(src: string): string[] {
	const lines = (src ?? '').replace(/\r\n?/g, '\n').split('\n')
	const out: string[] = []
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i].trim().startsWith('```')) {
			out.push(lines[i])
			continue
		}
		const fence = [lines[i]]
		while (++i < lines.length) {
			fence.push(lines[i])
			if (lines[i].trim().startsWith('```')) break
		}
		out.push(fence.join('\n'))
	}
	return out.length ? out : ['']
}

export const join = (list: string[]) => list.join('\n')

const MARKER = /^(\s*)(?:([-*+])\s+(\[[ xX]\]\s*)?|(\d+)([.)])\s+|(>)\s*)/

/**
 * The marker a new line should start with to continue this one: a bullet, an
 * unticked box, the next number, a quote. `''` means the line is an empty item,
 * so Enter should end the list instead of adding to it.
 */
export function listPrefix(line: string): string | null {
	const m = line.match(MARKER)
	if (!m) return null
	const [all, indent, bullet, box, num, dot, quote] = m
	const empty = !line.slice(all.length).trim()
	if (empty) return ''
	if (bullet) return `${indent}${bullet} ${box ? '[ ] ' : ''}`
	if (num) return `${indent}${Number(num) + 1}${dot} `
	return `${indent}${quote} `
}

/**
 * Enter inside a block: the text before the caret stays, the text after moves
 * to a new block below it, which inherits the list marker.
 */
export function enterAt(line: string, caret: number): { line: string; next: string } {
	const prefix = listPrefix(line)
	if (prefix === '') return { line: '', next: '' } // an empty item ends the list
	const at = Math.max(0, Math.min(caret, line.length))
	// The marker brings its own space, so the carried text loses its leading one.
	const rest = prefix ? line.slice(at).replace(/^\s+/, '') : line.slice(at)
	return { line: line.slice(0, at), next: `${prefix ?? ''}${rest}` }
}

/** Wraps the selection in `**`, `*`, `` ` `` or `~~`, or unwraps it if already so. */
export function wrap(text: string, start: number, end: number, mark: string): { text: string; start: number; end: number } {
	const sel = text.slice(start, end)
	const outside = text.slice(Math.max(0, start - mark.length), start) === mark && text.slice(end, end + mark.length) === mark
	if (outside) {
		const before = text.slice(0, start - mark.length)
		return { text: `${before}${sel}${text.slice(end + mark.length)}`, start: before.length, end: before.length + sel.length }
	}
	if (sel.startsWith(mark) && sel.endsWith(mark) && sel.length > 2 * mark.length) {
		const inner = sel.slice(mark.length, -mark.length)
		return { text: `${text.slice(0, start)}${inner}${text.slice(end)}`, start, end: start + inner.length }
	}
	// Nothing selected: leave the caret between the marks, ready to type.
	return { text: `${text.slice(0, start)}${mark}${sel}${mark}${text.slice(end)}`, start: start + mark.length, end: end + mark.length }
}

/** Adds a block marker (`## `, `- `, `- [ ] `, `> `), or removes it if it is already there. */
export function togglePrefix(line: string, prefix: string): string {
	const head = line.match(/^(\s*)(#{1,3}\s+|[-*+]\s+(\[[ xX]\]\s*)?|\d+[.)]\s+|>\s*)?/)
	const [all, indent = '', current] = head ?? ['', '', undefined]
	const body = line.slice(all.length)
	if (current && current.trimEnd() === prefix.trimEnd()) return `${indent}${body}`
	return `${indent}${prefix}${body}`
}

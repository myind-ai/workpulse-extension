// The house style, enforced rather than written down.
//
// "A link goes somewhere, a button does something" is in DESIGN.md, and it was
// still broken the week after it was written — by the person who wrote it. A
// rule that lives only in a document is a rule that holds until someone is
// concentrating on something else, which is exactly when it matters.
//
// So it is a test. It reads the source the way a reviewer would, and fails with
// the file, the line and the offending tag.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

function tsxFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name)
		if (statSync(path).isDirectory()) return tsxFiles(path)
		return name.endsWith('.tsx') ? [path] : []
	})
}

/** Every opening tag of `kind`, with where it is. Brace-aware, so `className={…}` survives. */
function openingTags(source: string, kind: string): { tag: string; line: number }[] {
	const out: { tag: string; line: number }[] = []
	const re = new RegExp(`<${kind}\\b`, 'g')
	let m: RegExpExecArray | null
	while ((m = re.exec(source))) {
		let i = m.index
		let depth = 0
		while (i < source.length) {
			const c = source[i]
			if (c === '{') depth += 1
			else if (c === '}') depth -= 1
			else if (c === '>' && depth === 0) break
			i += 1
		}
		out.push({ tag: source.slice(m.index, i + 1), line: source.slice(0, m.index).split('\n').length })
	}
	return out
}

const files = tsxFiles('src')

describe('a link goes somewhere, a button does something', () => {
	it('should never dress a button as a link', () => {
		// Underlined blue means one thing to everyone who has ever used a browser.
		// A <button> that takes it is making a promise it does not keep.
		const wrong = files.flatMap((file) =>
			openingTags(readFileSync(file, 'utf8'), 'button')
				.filter((t) => /['"\s]wp-link[\s'"]/.test(t.tag) || /['"]wp-link['"]/.test(t.tag))
				.map((t) => `${file}:${t.line} — use wp-action, not wp-link:\n    ${t.tag.split('\n')[0].slice(0, 100)}`),
		)
		expect(wrong).toEqual([])
	})

	it('should never dress a link as a button’s text action', () => {
		// The reverse is just as confusing: a thing that navigates should look
		// like it navigates.
		const wrong = files.flatMap((file) =>
			openingTags(readFileSync(file, 'utf8'), 'a')
				.filter((t) => /wp-action/.test(t.tag))
				.map((t) => `${file}:${t.line} — an <a> is a link: use wp-link`),
		)
		expect(wrong).toEqual([])
	})

	it('should give every icon-only button something to say on hover', () => {
		// An icon with no title is a guess, and the tooltip is the only label it
		// will ever have.
		const wrong = files.flatMap((file) =>
			openingTags(readFileSync(file, 'utf8'), 'button')
				.filter((t) => /wp-icon-btn/.test(t.tag) && !/\stitle[=\s]/.test(t.tag))
				.map((t) => `${file}:${t.line} — an icon button needs a title`),
		)
		expect(wrong).toEqual([])
	})

	it('should find the files it is supposed to be reading', () => {
		// A guard that quietly scans nothing passes for ever.
		expect(files.length).toBeGreaterThan(20)
	})
})

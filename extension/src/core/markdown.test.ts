import { describe, expect, it } from 'vitest'

import { firstLine, inline, parse, safeHref, toggleBox } from './markdown'

const text = (s: string) => parse(s)

describe('blocks', () => {
	it('should read headings, paragraphs and rules', () => {
		expect(text('# Day one\n\nShipped the thing.\n\n---').map((b) => b.kind)).toEqual(['heading', 'para', 'rule'])
	})

	it('should join wrapped lines into one paragraph', () => {
		const [b] = text('a long note\nthat wrapped')
		expect(b).toEqual({ kind: 'para', spans: [{ kind: 'text', text: 'a long note that wrapped' }] })
	})

	it('should read a bullet list as one block', () => {
		const [b] = text('- one\n- two\n- three')
		expect(b.kind === 'list' && b.items).toHaveLength(3)
		expect(b.kind === 'list' && b.ordered).toBe(false)
	})

	it('should read checkboxes, ticked and not', () => {
		const [b] = text('- [x] merged on dev\n- [ ] verify on stage')
		expect(b.kind === 'list' && b.items.map((i) => i.done)).toEqual([true, false])
	})

	it('should keep a numbered list numbered', () => {
		const [b] = text('1. first\n2. second')
		expect(b.kind === 'list' && b.ordered).toBe(true)
	})

	it('should keep code fences verbatim, markdown and all', () => {
		const [b] = text('```\n# not a heading\n  indented\n```')
		expect(b).toEqual({ kind: 'code', text: '# not a heading\n  indented' })
	})

	it('should read a quote across its lines', () => {
		const [b] = text('> waiting on the LD flag\n> per the standup')
		expect(b.kind === 'quote' && b.spans[0].text).toBe('waiting on the LD flag per the standup')
	})

	it('should return nothing for an empty note', () => {
		expect(text('   \n\n')).toEqual([])
	})
})

describe('inline', () => {
	it('should read code, bold, italic and strike', () => {
		expect(inline('`x` **b** *i* ~~s~~').filter((s) => s.kind !== 'text').map((s) => [s.kind, s.text])).toEqual([
			['code', 'x'],
			['bold', 'b'],
			['italic', 'i'],
			['strike', 's'],
		])
	})

	it('should read a markdown link and a bare address', () => {
		expect(inline('[PR](https://github.com/a/b/pull/1)')).toEqual([{ kind: 'link', text: 'PR', href: 'https://github.com/a/b/pull/1' }])
		expect(inline('see https://leap.atlassian.net/browse/PAY-2398 for the rest')[1]).toEqual({
			kind: 'link',
			text: 'https://leap.atlassian.net/browse/PAY-2398',
			href: 'https://leap.atlassian.net/browse/PAY-2398',
		})
	})

	it('should refuse an address a browser should not follow', () => {
		expect(safeHref('javascript:alert(1)')).toBeNull()
		expect(safeHref('data:text/html,<script>')).toBeNull()
		expect(inline('[click](javascript:alert(1))').some((s) => s.kind === 'link')).toBe(false)
	})

	it('should leave markup as the characters someone typed', () => {
		expect(inline('<script>alert(1)</script>')).toEqual([{ kind: 'text', text: '<script>alert(1)</script>' }])
	})
})

describe('one-line preview', () => {
	it('should show the first real line without its markup', () => {
		expect(firstLine('# PAY-2398\n\n- [ ] **check** the stage deploy')).toBe('PAY-2398')
		expect(firstLine('- [x] merged on dev')).toBe('merged on dev')
	})

	it('should cut a long line rather than wrap the list', () => {
		expect(firstLine('x'.repeat(200), 20)).toHaveLength(20)
	})
})

describe('ticking a box in a note', () => {
	const note = '- [ ] verify on stage\n- [x] merged on dev\n\nsee [1] and [x] in prose'

	it('should tick the box you clicked and leave the others', () => {
		expect(toggleBox(note, 0)).toContain('- [x] verify on stage')
		expect(toggleBox(note, 0)).toContain('- [x] merged on dev')
	})

	it('should untick a ticked one', () => {
		expect(toggleBox(note, 1)).toContain('- [ ] merged on dev')
	})

	it('should not touch brackets that are prose, not boxes', () => {
		expect(toggleBox(note, 0)).toContain('see [1] and [x] in prose')
	})

	it('should leave the note alone when the index is past the end', () => {
		expect(toggleBox(note, 9)).toBe(note)
	})
})

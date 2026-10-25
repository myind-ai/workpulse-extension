import { describe, expect, it } from 'vitest'

import { blocks, enterAt, join, listPrefix, togglePrefix, wrap } from './editor'

describe('splitting a note into blocks', () => {
	it('should make a block of each line', () => {
		expect(blocks('# Day one\n\n- a\n- b')).toEqual(['# Day one', '', '- a', '- b'])
	})

	it('should keep a fenced code block whole', () => {
		expect(blocks('before\n```\nnpm run check\n# not a heading\n```\nafter')).toEqual(['before', '```\nnpm run check\n# not a heading\n```', 'after'])
	})

	it('should round-trip exactly', () => {
		const src = '## Decided\n\n- [x] merged\n```\nx\n```\nend'
		expect(join(blocks(src))).toBe(src)
	})

	it('should give an empty note one empty block to type in', () => {
		expect(blocks('')).toEqual([''])
	})
})

describe('what Enter continues', () => {
	it('should carry on a bullet, a box, a quote and the next number', () => {
		expect(listPrefix('- one')).toBe('- ')
		expect(listPrefix('- [x] merged')).toBe('- [ ] ')
		expect(listPrefix('> because')).toBe('> ')
		expect(listPrefix('3. third')).toBe('4. ')
		expect(listPrefix('  - nested')).toBe('  - ')
	})

	it('should end the list when the item is empty', () => {
		expect(listPrefix('- ')).toBe('')
		expect(listPrefix('- [ ] ')).toBe('')
	})

	it('should not start a list out of a paragraph', () => {
		expect(listPrefix('just text')).toBeNull()
	})

	it('should split at the caret and carry the marker over', () => {
		expect(enterAt('- one two', 5)).toEqual({ line: '- one', next: '- two' })
		expect(enterAt('plain', 5)).toEqual({ line: 'plain', next: '' })
	})

	it('should clear an empty item rather than add another', () => {
		expect(enterAt('- ', 2)).toEqual({ line: '', next: '' })
	})
})

describe('the toolbar', () => {
	it('should wrap the selection and keep it selected', () => {
		expect(wrap('merged on dev', 0, 6, '**')).toEqual({ text: '**merged** on dev', start: 2, end: 8 })
	})

	it('should unwrap when the marks are already there', () => {
		expect(wrap('**merged** on dev', 2, 8, '**')).toEqual({ text: 'merged on dev', start: 0, end: 6 })
		expect(wrap('`code`', 0, 6, '`')).toEqual({ text: 'code', start: 0, end: 4 })
	})

	it('should leave the caret between the marks when nothing is selected', () => {
		expect(wrap('x', 1, 1, '**')).toEqual({ text: 'x****', start: 3, end: 3 })
	})

	it('should add a block marker, swap one, and take it off again', () => {
		expect(togglePrefix('Decided', '## ')).toBe('## Decided')
		expect(togglePrefix('## Decided', '## ')).toBe('Decided')
		expect(togglePrefix('## Decided', '- ')).toBe('- Decided')
		expect(togglePrefix('- [ ] verify', '- ')).toBe('- verify')
		expect(togglePrefix('  - nested', '> ')).toBe('  > nested')
	})
})

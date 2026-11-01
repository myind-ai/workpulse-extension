import { describe, expect, it } from 'vitest'

import { applyMeta, libraryFromTree, readingOrder, titleFromFolder } from './library'

const t = (path: string, sha = 's') => ({ path, sha })

describe('libraryFromTree', () => {
	it('groups a folder, keeps the allowed files, ignores .owner, other trees and shallow paths', () => {
		const items = libraryFromTree([
			t('bridge/library/youtube/a/notes.md', 'n1'),
			t('bridge/library/youtube/a/meta.json', 'm1'),
			t('bridge/library/youtube/a/.owner', 'o1'),
			t('bridge/library/youtube/a/video.mp4', 'v1'),
			t('bridge/library/site/b/article.md', 'a1'),
			t('bridge/entries/2026-10/x.jsonl'),
			t('bridge/library/youtube/notes.md'),
			t('bridge/library/youtube/a/deep/notes.md'),
			t('elsewhere/library/youtube/a/notes.md'),
		])
		expect(items.map((i) => [i.path, i.type, i.folder])).toEqual([
			['bridge/library/site/b', 'site', 'b'],
			['bridge/library/youtube/a', 'youtube', 'a'],
		])
		expect(items[1].files).toEqual([
			{ name: 'meta.json', sha: 'm1' },
			{ name: 'notes.md', sha: 'n1' },
		])
	})

	it('keeps parsed meta while the meta sha is unchanged and drops it when the sha moved', () => {
		const first = libraryFromTree([t('bridge/library/youtube/a/meta.json', 'm1')])
		const parsed = applyMeta(first[0], JSON.stringify({ title: 'Hello', channel: 'Ch', words: 12 }), 'm1')
		expect(libraryFromTree([t('bridge/library/youtube/a/meta.json', 'm1')], [parsed])[0]).toMatchObject({ title: 'Hello', by: 'Ch', words: 12, metaSha: 'm1' })
		const moved = libraryFromTree([t('bridge/library/youtube/a/meta.json', 'm2')], [parsed])[0]
		expect(moved.title).toBeUndefined()
		expect(moved.metaSha).toBeUndefined()
	})
})

describe('applyMeta', () => {
	const base = libraryFromTree([t('bridge/library/youtube/2026-10-29_Some-title_abc123/meta.json', 'm')])[0]

	it('reads title, channel then uploader, link, saved_at and words', () => {
		const a = applyMeta(base, JSON.stringify({ title: 'T', uploader: 'U', webpage_url: 'https://youtu.be/x', saved_at: '2026-10-29', words: 5 }), 'm')
		expect(a).toMatchObject({ title: 'T', by: 'U', url: 'https://youtu.be/x', savedAt: '2026-10-29', words: 5, metaSha: 'm' })
		expect(applyMeta(base, JSON.stringify({ channel: 'C', uploader: 'U' }), 'm').by).toBe('C')
	})

	it('falls back to the folder title on bad JSON and keeps the sha', () => {
		const a = applyMeta(base, '{nope', 'm')
		expect(a.title).toBe('Some title')
		expect(a.metaSha).toBe('m')
	})

	it('drops a link that is not http(s)', () => {
		expect(applyMeta(base, JSON.stringify({ title: 'T', webpage_url: 'javascript:alert(1)' }), 'm').url).toBeUndefined()
	})
})

describe('titleFromFolder and readingOrder', () => {
	it('makes a readable title', () => {
		expect(titleFromFolder('2026-10-29_Some-title_abc123')).toBe('Some title')
		expect(titleFromFolder('a')).toBe('a')
	})
	it('orders files for reading and never lists meta.json or .owner', () => {
		const names = ['meta.json', 'description.md', '.owner', 'transcript.txt', 'notes.md', 'transcript.md', 'article.md']
		expect(readingOrder(names.map((name) => ({ name })))).toEqual(['notes.md', 'article.md', 'transcript.md', 'transcript.txt', 'description.md'])
	})
})

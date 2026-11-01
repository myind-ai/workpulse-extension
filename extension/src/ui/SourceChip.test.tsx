import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { urlHost } from '@/core/bridge'

import { SourceChip, SourceFilter } from './SourceChip'

describe('SourceChip', () => {
	it('links out, safely, when the source has an http(s) URL', () => {
		const html = renderToStaticMarkup(<SourceChip source={{ type: 'youtube', url: 'https://www.youtube.com/watch?v=abc', title: 'Idempotency', by: 'Someone' }} />)
		expect(html).toContain('<a ')
		expect(html).toContain('target="_blank"')
		expect(html).toContain('rel="noreferrer"')
		expect(html).toContain('YouTube')
		expect(html).toContain('Idempotency')
	})
	it('is a plain chip when the URL is not a safe link', () => {
		const html = renderToStaticMarkup(<SourceChip source={{ type: 'site', url: 'javascript:alert(1)' }} />)
		expect(html).not.toContain('<a')
		expect(html).not.toContain('javascript:')
		expect(html).toContain('Site')
	})
	it('renders nothing without a source', () => {
		expect(renderToStaticMarkup(<SourceChip />)).toBe('')
	})
})

describe('SourceFilter', () => {
	it('hides types with a count of 0 and marks the chosen one', () => {
		const html = renderToStaticMarkup(<SourceFilter value="youtube" counts={{ youtube: 2, instagram: 0, site: 0, workpulse: 1, session: 0, manual: 0, none: 3 }} onChange={() => undefined} />)
		expect(html).toContain('YouTube')
		expect(html).toContain('No source')
		expect(html).not.toContain('Instagram')
		expect(html).toMatch(/aria-pressed="true"[^>]*>[^<]*YouTube|YouTube[^]*aria-pressed="true"/)
	})
})

describe('urlHost', () => {
	it('gives the hostname, or the text itself, without throwing', () => {
		expect(urlHost('https://example.com/a')).toBe('example.com')
		expect(urlHost('not a url')).toBe('not a url')
	})
})

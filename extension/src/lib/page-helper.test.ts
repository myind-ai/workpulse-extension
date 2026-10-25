import { beforeEach, describe, expect, it } from 'vitest'

import { clientFormValues } from '@/core/setup'

import { fillForm, findField, scanClientId } from './page-helper'

const REDIRECT = 'https://abc.chromiumapp.org/'

beforeEach(() => {
	document.body.innerHTML = `
	<form>
		<div class="row"><span>Client Name</span><div><input id="n" /></div></div>
		<div class="row"><label for="h">Homepage URL</label><input id="h" /></div>
		<div class="row"><div>Authorized Redirect URIs</div><input id="r" placeholder="https://" /><button type="button">+</button></div>
		<div class="row"><input id="j" aria-label="JavaScript Domain" /></div>
	</form>`
})

describe('setup helper on Zoho pages', () => {
	it('finds each field by its label, label-for, or aria-label', () => {
		expect(findField(/client\s*name/i)?.id).toBe('n')
		expect(findField(/home\s*page\s*url/i)?.id).toBe('h')
		expect(findField(/redirect\s*ur[il]/i)?.id).toBe('r')
		expect(findField(/java\s*script\s*domain/i)?.id).toBe('j')
	})

	it('fills the whole client form and fires input events', () => {
		let inputs = 0
		document.body.addEventListener('input', () => inputs++)
		const res = fillForm(clientFormValues(REDIRECT, 'in'))
		expect(res.missing).toEqual([])
		expect((document.getElementById('r') as HTMLInputElement).value).toBe(REDIRECT)
		expect((document.getElementById('j') as HTMLInputElement).value).toBe('https://abc.chromiumapp.org')
		expect(inputs).toBe(4)
	})

	it('reports fields it could not find instead of guessing', () => {
		document.body.innerHTML = '<div>Client Name</div><input id="only" />'
		const res = fillForm(clientFormValues(REDIRECT, 'in'))
		expect(res.filled).toEqual(['Client Name'])
		expect(res.missing).toHaveLength(3)
	})

	it('spots the Client ID in text or in a read-only input', () => {
		expect(scanClientId()).toBeNull()
		document.body.innerHTML = '<div>Client ID</div><div>1000.AB12CD34EF56GH78IJ90KL12MN34OP</div>'
		expect(scanClientId()).toBe('1000.AB12CD34EF56GH78IJ90KL12MN34OP')
		document.body.innerHTML = '<input readonly value="1000.ZZ12CD34EF56GH78IJ90KL12MN34OP" />'
		expect(scanClientId()).toBe('1000.ZZ12CD34EF56GH78IJ90KL12MN34OP')
	})
})

import { describe, expect, it } from 'vitest'

import { parseCurl } from './curl'

// Shaped exactly like Chrome's "Copy as cURL (bash)".
const REAL = `curl --url 'https://people.zoho.in/logiciel/AttendanceAction.zp' \\
  -H 'Accept: */*' \\
  -H 'Content-Type: application/x-www-form-urlencoded; charset=UTF-8' \\
  -b '_iamadt=SECRET; CSRF_TOKEN=abc123' \\
  -H 'Origin: https://people.zoho.in' \\
  -H 'X-Requested-With: XMLHttpRequest' \\
  --data-raw 'mode=getStatus&conreqcsr=abc123'`

describe('pasting a copied curl', () => {
	it('should read the url, method, body and content type', () => {
		const c = parseCurl(REAL)!
		expect(c.url).toBe('https://people.zoho.in/logiciel/AttendanceAction.zp')
		expect(c.method).toBe('POST')
		expect(c.body).toBe('mode=getStatus&conreqcsr=abc123')
		expect(c.contentType).toBe('application/x-www-form-urlencoded; charset=UTF-8')
		expect(c.headers['X-Requested-With']).toBe('XMLHttpRequest')
	})

	it('should never keep the session cookies or the headers the browser sets itself', () => {
		const c = parseCurl(REAL)!
		const blob = JSON.stringify(c)
		expect(blob).not.toContain('_iamadt')
		expect(blob).not.toContain('SECRET')
		expect(Object.keys(c.headers)).not.toContain('Origin')
	})

	it('should handle the bash $\'…\' form multipart punches are copied as', () => {
		const c = parseCurl(`curl --url 'https://people.zoho.in/x?mode=punchIn' -H 'Accept: */*' --data-raw $'------Boundary\\r\\nname="a"\\r\\n'`)!
		expect(c.url).toBe('https://people.zoho.in/x?mode=punchIn')
		expect(c.body).toContain('Boundary')
	})

	it('should take a bare url and default to GET', () => {
		const c = parseCurl(`curl 'https://people.zoho.in/people/api/attendance'`)!
		expect(c.method).toBe('GET')
		expect(c.body).toBeUndefined()
	})

	it('should refuse what is not a curl', () => {
		expect(parseCurl('https://people.zoho.in/x')).toBeNull()
		expect(parseCurl('')).toBeNull()
		expect(parseCurl('curl -H "Accept: */*"')).toBeNull() // no url
	})
})

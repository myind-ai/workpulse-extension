// Turns a "Copy as cURL" command into a request WorkPulse can replay. Pasting
// one is the quickest way to tell it which of Zoho's own calls to use, and it
// works whether or not the in-app recorder ever ran.
//
// Cookies are dropped on the floor, deliberately: a copied curl carries the
// whole session, and WorkPulse never needs it — the reader runs on your own
// Zoho tab, where the browser attaches your session itself.

export interface ParsedCurl {
	method: string
	url: string
	body?: string
	contentType?: string
	headers: Record<string, string>
}

const DROP_HEADER = /^(cookie|authorization|set-cookie|user-agent|referer|origin|sec-|accept-encoding|connection|content-length)/i

/** Splits a shell command, honouring '…', "…" and $'…'. */
function tokenize(text: string): string[] {
	const out: string[] = []
	let cur = ''
	let quote: "'" | '"' | null = null
	let had = false
	for (let i = 0; i < text.length; i++) {
		const c = text[i]
		if (quote) {
			if (c === '\\' && quote === '"' && i + 1 < text.length) {
				cur += text[++i]
				continue
			}
			if (c === quote) {
				quote = null
				continue
			}
			cur += c
			continue
		}
		if (c === "'" || c === '"') {
			// $'…' is bash's escaped form; the $ is not part of the value.
			if (c === "'" && cur.endsWith('$')) cur = cur.slice(0, -1)
			quote = c
			had = true
			continue
		}
		if (c === '\\' && text[i + 1] === '\n') {
			i++
			continue
		}
		if (/\s/.test(c)) {
			if (cur || had) out.push(cur)
			cur = ''
			had = false
			continue
		}
		cur += c
	}
	if (cur || had) out.push(cur)
	return out
}

/** Null when the text is not a curl command we can replay. */
export function parseCurl(text: string): ParsedCurl | null {
	const tokens = tokenize(text.trim())
	if (!tokens.length || !/curl$/.test(tokens[0])) return null
	const headers: Record<string, string> = {}
	let url = ''
	let body: string | undefined
	let method = ''
	for (let i = 1; i < tokens.length; i++) {
		const t = tokens[i]
		if (t === '-X' || t === '--request') method = tokens[++i] ?? ''
		else if (t === '-H' || t === '--header') {
			const h = tokens[++i] ?? ''
			const at = h.indexOf(':')
			if (at > 0) {
				const name = h.slice(0, at).trim()
				if (!DROP_HEADER.test(name)) headers[name] = h.slice(at + 1).trim()
			}
		} else if (t === '-b' || t === '--cookie') i++ // never kept
		else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary' || t === '--data-urlencode') body = tokens[++i] ?? ''
		else if (t === '--url') url = tokens[++i] ?? ''
		else if (!t.startsWith('-') && /^https?:\/\//.test(t)) url = t
	}
	if (!url) return null
	const contentType = Object.entries(headers).find(([k]) => /^content-type$/i.test(k))?.[1]
	return { method: method || (body != null ? 'POST' : 'GET'), url, body, contentType, headers }
}

/** Anything that looks like a session secret, so a pasted curl cannot store one. */
export const SECRET_IN_CURL = /(^|[;&\s])(_iamadt|_iambdt|__Secure-iamsdt|wms-tkp-token|_zpsid)=/i

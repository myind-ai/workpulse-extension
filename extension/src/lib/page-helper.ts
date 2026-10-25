// DOM helpers for the setup helper on Zoho's own pages. Zoho's markup is not
// ours, so everything is best-effort: fields are found by their visible label
// (then placeholder/aria-label/name), and the Client ID by its 1000.XXXX shape.

import { findClientId, type FormValue } from '@/core/setup'

type Field = HTMLInputElement | HTMLTextAreaElement

const FIELD_SELECTOR = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea'

function visible(el: Element): boolean {
	const s = getComputedStyle(el)
	return !(el as HTMLElement).hidden && s.display !== 'none' && s.visibility !== 'hidden'
}

const follows = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

/** The input/textarea that belongs to the label matching `match`, or null. */
export function findField(match: RegExp, root: ParentNode = document): Field | null {
	const labels = [...root.querySelectorAll('label, span, div, p, td, th, dt, h4, h5, h6')].filter((el) => {
		const t = (el.textContent ?? '').trim()
		return t.length > 0 && t.length <= 60 && el.querySelectorAll('*').length <= 4 && match.test(t)
	})
	for (const label of labels) {
		if (label instanceof HTMLLabelElement && label.htmlFor) {
			const f = document.getElementById(label.htmlFor)
			if (f instanceof HTMLInputElement || f instanceof HTMLTextAreaElement) return f
		}
		let node: Element | null = label
		for (let depth = 0; depth < 4 && node; depth++) {
			const next = [...node.querySelectorAll<Field>(FIELD_SELECTOR)].find((f) => (f === label || follows(label, f)) && visible(f))
			if (next) return next
			node = node.parentElement
		}
	}
	for (const f of root.querySelectorAll<Field>(FIELD_SELECTOR)) {
		const hint = [f.getAttribute('placeholder'), f.getAttribute('aria-label'), f.getAttribute('name'), f.id].join(' ')
		if (match.test(hint)) return f
	}
	return null
}

/** Sets a value so framework-controlled inputs (React, Lyte, …) notice it. */
export function setFieldValue(f: Field, value: string): void {
	const proto = f instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
	Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(f, value)
	for (const type of ['input', 'change', 'blur']) f.dispatchEvent(new Event(type, { bubbles: true }))
}

export function fillForm(values: FormValue[], root: ParentNode = document): { filled: string[]; missing: string[] } {
	const filled: string[] = []
	const missing: string[] = []
	const used = new Set<Field>()
	for (const v of values) {
		const f = findField(v.match, root)
		if (f && !used.has(f)) {
			setFieldValue(f, v.value)
			used.add(f)
			filled.push(v.label)
		} else {
			missing.push(v.label)
		}
	}
	return { filled, missing }
}

/** Looks for a Zoho Client ID in the visible text and in read-only inputs. */
export function scanClientId(root: Document = document): string | null {
	const text = (root.body as HTMLElement | null)?.innerText || root.body?.textContent || ''
	const fromText = findClientId(text)
	if (fromText) return fromText
	for (const f of root.querySelectorAll<HTMLInputElement>('input')) {
		const id = findClientId(f.value)
		if (id) return id
	}
	return null
}

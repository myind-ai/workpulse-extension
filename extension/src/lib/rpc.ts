// Typed calls from extension pages and the content script to the background.

import type { Commands } from '@/background/bridge-commands'

type Fn = (...args: any[]) => any
type Methods = { [K in keyof Commands as Commands[K] extends Fn ? K : never]: Commands[K] }
export type Method = keyof Methods

export interface CallMessage {
	wp: 'call'
	method: string
	args: unknown[]
}

/**
 * The extension was reloaded or updated while this page or content script kept
 * running. Nothing it does can reach the background any more — the only honest
 * response is for the surface to take itself away.
 */
export class Orphaned extends Error {
	constructor() {
		super('WorkPulse was updated. This card is out of date — it will disappear.')
		this.name = 'Orphaned'
	}
}

/**
 * The running service worker is older than the page asking it for something.
 *
 * Chrome re-reads an extension page from disk every time you open it, but keeps
 * the worker it already registered until the extension is reloaded — so after a
 * rebuild the dashboard can ask for a command the worker has never heard of.
 * The honest fix is a reload, and the extension can do that to itself.
 */
export const stale = (e: unknown) => /needs reloading|Unknown command/i.test(String((e as Error)?.message ?? e))

/**
 * Once per page, a stale worker is reloaded rather than reported. Only once:
 * if the name is wrong for some other reason, reloading will not make it right
 * and a loop of reloads is worse than an error message.
 */
let healed = false

export const orphaned = (e: unknown) => e instanceof Orphaned || /Extension context invalidated|message port closed|receiving end does not exist/i.test(String((e as Error)?.message ?? e))

export async function call<K extends Method>(method: K, ...args: Parameters<Methods[K]>): Promise<Awaited<ReturnType<Methods[K]>>> {
	// `chrome.runtime.id` is undefined once the context is invalidated, which is
	// cheaper and more reliable than waiting for sendMessage to throw.
	if (!chrome.runtime?.id) throw new Orphaned()
	const send = () =>
		chrome.runtime.sendMessage({ wp: 'call', method, args } satisfies CallMessage).catch((e: unknown) => {
			if (orphaned(e)) throw new Orphaned()
			throw e
		})

	// A sleeping service worker answers nothing to the message that wakes it.
	// Asking again is cheaper than making you press the button again.
	//
	// The wait climbs rather than sitting at a flat quarter-second. Chrome
	// usually has the worker up in well under that, and every surface in the
	// extension asks several questions at once the moment it opens — so a flat
	// 250ms was 250ms added to opening the widget, every time, whether or not
	// the worker needed it.
	let res = await send()
	for (const wait of [30, 90, 250]) {
		if (res) break
		await new Promise((r) => setTimeout(r, wait))
		res = await send()
	}
	if (!res) throw new Error('WorkPulse is still starting up. Try again in a moment.')
	if (!res.ok) {
		if (stale(res.error) && !healed) {
			healed = true
			// Same storage, new worker — then say so, rather than leaving the
			// unanswerable "Unknown command" as the whole explanation.
			chrome.runtime.reload()
			throw new Error('WorkPulse was out of date and has reloaded itself. Try that again.')
		}
		throw new Error(res.error)
	}
	return res.result
}

/** Runs `fn` whenever the background says state changed. Returns an unsubscribe. */
export function onChanged(fn: () => void): () => void {
	const listener = (msg: unknown) => {
		if ((msg as { wp?: string })?.wp === 'changed') fn()
	}
	chrome.runtime.onMessage.addListener(listener)
	return () => chrome.runtime.onMessage.removeListener(listener)
}

// Makes forced UI visible. First choice: the overlay content script on the
// active tab. Fallback: a focused popup window that reopens if closed while
// an answer is still owed. When Chrome is not the focused app, blocking
// reminders also open/focus the window so they reach you from other apps.

import { overlayExempt } from '@/core/setup'
import type { Pending } from '@/core/types'
import type { Store } from '@/lib/store'

const OVERLAY_FILE = 'content-scripts/overlay.js'

export function injectable(url: string | undefined): boolean {
	if (!url || !/^https?:\/\//.test(url)) return false
	return !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/.test(url)
}

/** How big the window needs to be for each card. */
const SIZE: Partial<Record<Pending['kind'], { width: number; height: number }>> = {
	prompt: { width: 580, height: 720 },
	health: { width: 440, height: 520 },
	meeting: { width: 460, height: 560 },
	remind: { width: 480, height: 460 },
	checkin: { width: 520, height: 560 },
	closeout: { width: 520, height: 560 },
}

export class Presenter {
	/** What the window is currently showing, so it can be sized for it. */
	private kind?: Pending['kind']

	constructor(private store: Store) {}

	/** Asks the overlay in `tabId` to refresh itself; injects it once if missing. */
	async poke(tabId: number, url?: string): Promise<boolean> {
		if (!injectable(url)) return false
		const ping = () => chrome.tabs.sendMessage(tabId, { wp: 'overlay' }).then((r) => r === true, () => false)
		if (await ping()) return true
		try {
			await chrome.scripting.executeScript({ target: { tabId }, files: [OVERLAY_FILE] })
		} catch {
			return false
		}
		await new Promise((r) => setTimeout(r, 150))
		return ping()
	}

	/**
	 * One surface at a time. Showing the overlay *and* the window — which the old
	 * order could do when Chrome was in the background — reads as two reminders
	 * for one slot, and answering one left the other standing.
	 */
	async show(p: Pending): Promise<void> {
		// You are already looking at the window: leave it alone.
		if (await this.windowFocused()) return
		this.kind = p.kind

		const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null)
		// Chrome is not the app in front, so an overlay on a hidden tab would not
		// reach you: the window is the only thing that will.
		if (!win?.focused || win.id == null) return void (await this.openWindow())

		const [tab] = await chrome.tabs.query({ active: true, windowId: win.id })
		// You are looking at WorkPulse itself: the dashboard shows the same state
		// and lets you act on it. A window on top of it is the reminder arguing
		// with the page you opened because of the reminder.
		if (tab?.url?.startsWith(chrome.runtime.getURL(''))) return
		// On a Zoho page you are already doing the thing (signing in, checking in,
		// filling the timesheet): leave that page usable and don't pop a window over it.
		if (tab?.id != null && overlayExempt(tab.url, p.kind)) return
		if (tab?.id != null && (await this.poke(tab.id, tab.url))) {
			await this.closeWindow() // the page owns the answer now
			// An overlay injected into a tab stays mounted while something is owed,
			// so switching tabs used to leave one behind on each. Exactly one card,
			// on the tab you are looking at.
			await this.hideOthers(tab.id)
			return
		}
		await this.openWindow()
	}

	/** Asks every tab but this one to take its overlay down. */
	private async hideOthers(keep: number): Promise<void> {
		const tabs = await chrome.tabs.query({})
		await Promise.all(
			tabs
				.filter((t) => t.id != null && t.id !== keep && injectable(t.url))
				.map((t) => chrome.tabs.sendMessage(t.id!, { wp: 'overlay', hide: true }).catch(() => undefined)),
		)
	}

	async hide(): Promise<void> {
		const tabs = await chrome.tabs.query({})
		await Promise.all(tabs.filter((t) => t.id != null && injectable(t.url)).map((t) => chrome.tabs.sendMessage(t.id!, { wp: 'overlay' }).catch(() => undefined)))
		await this.closeWindow()
	}

	private async windowFocused(): Promise<boolean> {
		const id = (await this.store.runtime()).promptWindowId
		if (id == null) return false
		const w = await chrome.windows.get(id).catch(() => null)
		return !!w?.focused
	}

	async openWindow(): Promise<void> {
		// A break card is five lines and a button: in a window sized for the log
		// form it is a sheet of empty space with a sentence at the top.
		const { width, height } = SIZE[this.kind ?? 'prompt'] ?? SIZE.prompt!
		const id = (await this.store.runtime()).promptWindowId
		if (id != null) {
			const existing = await chrome.windows.get(id).catch(() => null)
			if (existing) {
				await chrome.windows.update(id, { focused: true, drawAttention: true, width, height })
				return
			}
		}
		const anchor = await chrome.windows.getLastFocused().catch(() => null)
		const left = anchor?.left != null && anchor.width ? Math.round(anchor.left + (anchor.width - width) / 2) : undefined
		const top = anchor?.top != null && anchor.height ? Math.max(0, Math.round(anchor.top + (anchor.height - height) / 3)) : undefined
		const w = await chrome.windows.create({ url: chrome.runtime.getURL('/prompt.html'), type: 'popup', width, height, left, top, focused: true })
		await this.store.updateRuntime((r) => void (r.promptWindowId = w?.id))
		// `focused: true` on create is not always honoured, and a window you can
		// see but cannot type into is worse than no window: insist on it.
		if (w?.id != null) await chrome.windows.update(w.id, { focused: true, drawAttention: true }).catch(() => undefined)
	}

	async closeWindow(): Promise<void> {
		const rt = await this.store.runtime()
		if (rt.promptWindowId == null) return
		await this.store.updateRuntime((r) => void (r.promptWindowId = undefined))
		await chrome.windows.remove(rt.promptWindowId).catch(() => undefined)
	}

	/**
	 * The user closed the prompt window. It comes back only if the answer is
	 * still owed — asked against what has been logged, so closing it after
	 * logging the hour elsewhere does not reopen it.
	 */
	async onWindowRemoved(windowId: number, owed: (p: Pending) => Promise<boolean>): Promise<void> {
		const rt = await this.store.runtime()
		if (rt.promptWindowId !== windowId) return
		await this.store.updateRuntime((r) => void (r.promptWindowId = undefined))
		const p = rt.pending
		if (!p?.blocking) return
		if (!(await owed(p).catch(() => true))) return
		setTimeout(() => void this.openWindow(), 400)
	}
}

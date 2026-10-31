// Wires Chrome events to the engine, the presenter and the command router.

import { Engine, errText, type Ui } from '@/background/engine'
import { BITS_PER_SECOND } from '@/core/clip'
import { blobIds, getBlob, sweepBlobs, toDataUrl } from '@/lib/blobs'
import { keysIn, menuAction, menuDo } from '@/core/links'
import { parkable } from '@/core/context'
import { API_ENABLED } from '@/core/features'
import { Presenter } from '@/background/presenter'
import { Commands } from '@/background/bridge-commands'
import type { CallMessage } from '@/lib/rpc'
import { chromeKV, Store } from '@/lib/store'
import { ZohoClient } from '@/lib/zoho'

const TICK = 'workpulse-tick'
const HELPER_FILE = 'content-scripts/zoho-helper.js'
const READER_FILE = 'content-scripts/zoho-read.js'
const PUNCH_FILE = 'content-scripts/zoho-punch.js'
const LOG_FILE = 'content-scripts/zoho-log.js'
const ZOHO_SETUP_HOST = /^(api-console|people)\.zoho\.(in|com|eu|com\.au)$/
const ZOHO_URLS = ['https://*.zoho.in/*', 'https://*.zoho.com/*', 'https://*.zoho.eu/*', 'https://*.zoho.com.au/*']
/** Never record these: they carry the session itself. */
const SECRET_HEADER = /^(cookie|authorization|set-cookie)$/i

function setupHost(url: string | undefined): 'client' | 'attendance' | null {
	let host = ''
	try {
		host = new URL(url ?? '').hostname
	} catch {
		return null
	}
	if (!ZOHO_SETUP_HOST.test(host)) return null
	return host.startsWith('api-console.') ? 'client' : 'attendance'
}

/** chrome.idle reports states, not seconds; map them onto the engine's thresholds. */
async function idleSecs(): Promise<number> {
	if ((await chrome.idle.queryState(600)) !== 'active') return 601
	return (await chrome.idle.queryState(120)) === 'active' ? 0 : 121
}

export default defineBackground(() => {
	// Recording lives in the worker, not storage: if Chrome stops the worker the
	// recorder stops with it rather than quietly logging your browsing later.
	// It also stops itself, because every recorded call is a storage write and
	// Zoho's own app chatters constantly.
	let recording = false
	let recordingStop: ReturnType<typeof setTimeout> | undefined
	const RECORD_FOR = 10 * 60_000
	const store = new Store(chromeKV)
	const presenter = new Presenter(store)
	const zoho = new ZohoClient({
		store,
		fetch: (input, init) => fetch(input, init),
		now: () => Date.now(),
		// Without the API there is no sign-in, and no `identity` permission to call.
		authFlow: API_ENABLED
			? async (url, interactive) => {
					const back = await chrome.identity.launchWebAuthFlow({ url, interactive })
					if (!back) throw new Error('Zoho sign-in was cancelled.')
					return back
				}
			: undefined,
		redirectUrl: API_ENABLED ? () => chrome.identity.getRedirectURL() : undefined,
	})

	/** Each write has its own script, so neither can be reached by the reader. */
	const injectOnPeopleTab = async (file: string) => {
		const tabs = await chrome.tabs.query({ url: ZOHO_URLS })
		const tab = tabs.find((t) => t.id != null && /^https:\/\/people\.zoho\./.test(t.url ?? ''))
		if (tab?.id == null) return false
		return chrome.scripting
			.executeScript({ target: { tabId: tab.id }, files: [file] })
			.then(() => true)
			.catch(() => false)
	}

	const ui: Ui = {
		show: (p) => presenter.show(p),
		hide: () => presenter.hide(),
		notify(id, title, message, sticky) {
			chrome.notifications.create(`wp-${id}`, {
				type: 'basic',
				iconUrl: chrome.runtime.getURL('/icon/128.png'),
				title,
				message,
				priority: 2,
				requireInteraction: sticky,
			})
		},
		async openUrl(url) {
			// Reuse a tab that is already on this exact page; never navigate a tab
			// away from something else (e.g. a half-filled Zoho form). Match
			// patterns cannot carry a port, so query by host name, then compare.
			const { hostname } = new URL(url)
			const tabs = await chrome.tabs.query({ url: `*://${hostname}/*` })
			const tab = tabs.find((t) => t.url?.startsWith(url))
			if (tab?.id != null) {
				await chrome.tabs.update(tab.id, { active: true })
				if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true })
			} else {
				await chrome.tabs.create({ url, active: true })
			}
		},
		pushBackup: () => commands.pushBackup(),
		openPalette: () => openPalette(),
		shareTeam: () => commands.pushTeam(),
		pollTeam: () => commands.pollTeam(),
		// Review's “Sync Claude logs” is an intentional refresh, so preserve its
		// force flag instead of accidentally serving the cached bridge tree.
		pollBridge: (force = false) => commands.pollBridge(force),
		capturePage: (of) => capturePage(of),
		startClip: (seconds, id, mic) => startClip(seconds, id, mic),
		async readBlob(id) {
			const blob = await getBlob(id)
			return blob ? toDataUrl(blob) : null
		},
		async rawBlob(id) {
			return (await getBlob(id)) ?? null
		},
		async sweepBlobs(keep) {
			await sweepBlobs(keep)
		},
		// Answers whether there was anything to stop. If the offscreen document
		// has gone, the recording went with it and the chip would otherwise sit
		// there counting up for ever with no way out.
		async stopClip() {
			if (!(await chrome.offscreen?.hasDocument?.().catch(() => false))) return false
			await chrome.runtime.sendMessage({ wp: 'clip-stop' }).catch(() => undefined)
			return true
		},
		async flashShot() {
			const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [])
			if (active?.id != null) await flashShot(active.id)
		},
		async currentPage() {
			// The active tab is WorkPulse itself whenever the dashboard or the
			// widget is asking, so the answer is the most recently used page that
			// is not ours. `lastAccessed` is what Chrome orders them by.
			const tabs = await chrome.tabs.query({}).catch(() => [])
			const mine = chrome.runtime.getURL('')
			const page = tabs
				.filter((t) => t.url && /^https?:/.test(t.url) && !t.url.startsWith(mine))
				.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0]
			return page?.url ? { title: page.title ?? page.url, url: page.url } : null
		},
		async visits(from, to) {
			// Only ever reachable with the optional history permission granted, and
			// only ever for the window the prompt is asking about.
			if (!chrome.history?.search) return []
			const items = await chrome.history.search({ text: '', startTime: from, endTime: to, maxResults: 500 }).catch(() => [])
			const out: { url: string; title: string; at: number }[] = []
			for (const item of items) {
				if (!item.url) continue
				// `lastVisitTime` is the most recent visit anywhere; the visit list is
				// what actually happened inside this hour.
				const visits = await chrome.history.getVisits({ url: item.url }).catch(() => [])
				for (const v of visits) {
					if (v.visitTime != null && v.visitTime >= from && v.visitTime < to) out.push({ url: item.url, title: item.title ?? '', at: v.visitTime })
				}
			}
			return out
		},
		async hasZohoTab() {
			const tabs = await chrome.tabs.query({ url: ['https://*.zoho.in/*', 'https://*.zoho.com/*', 'https://*.zoho.eu/*', 'https://*.zoho.com.au/*'] }).catch(() => [])
			return tabs.some((t) => /^https:\/\/(people|www)\.zoho\./.test(t.url ?? ''))
		},
		pageUrl(view) {
			return `${chrome.runtime.getURL('/dashboard.html')}#/${view}`
		},
		async openDashboard(view) {
			const base = chrome.runtime.getURL('/dashboard.html')
			const url = `${base}#/${view}`
			const [tab] = await chrome.tabs.query({ url: `${base}*` })
			if (tab?.id != null) {
				await chrome.tabs.update(tab.id, { active: true, url })
				if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true })
			} else {
				await chrome.tabs.create({ url, active: true })
			}
		},
		badge(text, color) {
			void chrome.action.setBadgeText({ text })
			void chrome.action.setBadgeBackgroundColor({ color })
			void chrome.action.setBadgeTextColor?.({ color: '#FFFFFF' })
		},
		changed() {
			chrome.runtime.sendMessage({ wp: 'changed' }).catch(() => undefined)
		},
		chime() {
			void playChime()
		},
		// An alarm rings until it is answered. Starting one twice does not start
		// two, and stopping one that is not playing costs nothing.
		alarm(on) {
			void playSound(on ? 'alarm' : 'alarm-stop')
		},
		clearNote(id) {
			chrome.notifications.clear(`wp-${id}`)
		},
		/**
		 * Everything open in this window, minus WorkPulse's own pages and
		 * anything a browser cannot reopen. A group that restores a `chrome://`
		 * tab is a group that fails halfway through restoring.
		 */
		/**
		 * The one place a model is ever called. Kept to a dumb pipe on purpose:
		 * what is sent and what is understood is decided in core/llm.ts, where
		 * it is testable, and nothing about the request is invented here.
		 */
		/**
		 * Is this a moment to cover somebody's screen?
		 *
		 * Fullscreen is the signal that matters: a demo, a presentation, a
		 * shared screen. Chrome reports it on the window, which is the only
		 * place it can be known without reading the page.
		 */
		async moment() {
			const win = await chrome.windows.getLastFocused().catch(() => null)
			const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => [])
			return { fullscreen: win?.state === 'fullscreen', activeUrl: active?.url }
		},
		async parkableTabs() {
			const tabs = await chrome.tabs.query({ currentWindow: true }).catch(() => [])
			const mine = chrome.runtime.getURL('')
			return parkable(
				tabs.map((t) => ({ id: t.id ?? -1, title: t.title ?? '', url: t.url ?? '', pinned: !!t.pinned })),
				mine,
			).map((t) => t.id)
		},
		async grantedPermissions() {
			const got = await chrome.permissions.getAll().catch(() => ({ permissions: [] as string[] }))
			return got.permissions ?? []
		},
		async blobCount() {
			return (await blobIds().catch(() => [])).length
		},
		/**
		 * Everything, gone. Both stores, not one: records live in
		 * chrome.storage.local and the pictures and recordings live in
		 * IndexedDB, and a delete that forgets the second leaves the heaviest
		 * and most personal half on disk.
		 */
		async wipeAll() {
			await sweepBlobs([]).catch(() => 0)
			await chrome.storage.local.clear().catch(() => undefined)
		},
		async askLlm(url, headers, body) {
			try {
				const res = await fetch(url, { method: 'POST', headers, body })
				return { ok: res.ok, status: res.status, text: await res.text() }
			} catch (e) {
				// A refused localhost, a blocked host, a dropped connection — all
				// arrive here, and none of them has a status worth reporting.
				return { ok: false, status: 0, text: errText(e) }
			}
		},
		async windowTabs() {
			const tabs = await chrome.tabs.query({ currentWindow: true }).catch(() => [])
			const mine = chrome.runtime.getURL('')
			return tabs
				.filter((t) => t.url && /^https?:/.test(t.url) && !t.url.startsWith(mine))
				.map((t) => ({ title: t.title ?? t.url!, url: t.url! }))
		},
		async closeTabs(ids) {
			await chrome.tabs.remove(ids).catch(() => undefined)
		},
		async openTabs(urls, groupName) {
			// A window of its own: restoring work should not bury what you are on.
			const [first, ...rest] = urls
			if (!first) return
			const win = await chrome.windows.create({ url: first, focused: true }).catch(() => null)
			const ids = win?.tabs?.[0]?.id != null ? [win.tabs[0].id] : []
			for (const url of rest) {
				const tab = await chrome.tabs.create({ url, windowId: win?.id, active: false }).catch(() => null)
				if (tab?.id != null) ids.push(tab.id)
			}
			// Four links for one ticket, in one labelled group: next time it is one
			// thing to open, not four to find. Grouping works with the tabs access
			// we already have; naming the group needs the optional permission, and
			// an unnamed group is still a group, so this never blocks the open.
			if (!groupName || ids.length < 2) return
			const groupId = await chrome.tabs.group({ tabIds: ids }).catch(() => null)
			if (groupId != null && chrome.tabGroups) await chrome.tabGroups.update(groupId, { title: groupName.slice(0, 40), collapsed: false }).catch(() => undefined)
		},
		async injectSetupHelper() {
			const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
			const step = setupHost(tab?.url)
			if (tab?.id == null || !step) return
			const flags = await store.setupFlags()
			if (!flags[step]) return
			await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [HELPER_FILE] }).catch(() => undefined)
		},
		async readZohoPage() {
			// Any Zoho People tab will do: the reader's fetch is same-origin there,
			// so your session is attached by the browser and CORS never applies.
			const tabs = await chrome.tabs.query({ url: ZOHO_URLS })
			const tab = tabs.find((t) => t.id != null && /^https:\/\/people\.zoho\./.test(t.url ?? ''))
			if (tab?.id == null) return false
			const done = await chrome.scripting
				.executeScript({ target: { tabId: tab.id }, files: [READER_FILE] })
				.then(() => true)
				.catch(() => false)
			return done
		},
		async punchZohoPage() {
			return injectOnPeopleTab(PUNCH_FILE)
		},
		async writeZohoPage() {
			return injectOnPeopleTab(LOG_FILE)
		},
		record(on) {
			recording = on
			clearTimeout(recordingStop)
			if (on) recordingStop = setTimeout(() => void (recording = false), RECORD_FOR)
		},
		recording() {
			return recording
		},
	}

	/**
	 * A worker cannot play audio, so the chime lives in an offscreen document —
	 * created on first use and left open, since creating one per reminder races
	 * with itself.
	 */
	/**
	 * A picture of the tab, small enough to keep.
	 *
	 * `captureVisibleTab` hands back a full-resolution PNG: one to three
	 * megabytes, which is not a thing to put in storage forty times. A service
	 * worker has `OffscreenCanvas` and `createImageBitmap`, so it is scaled to
	 * something a person can read and re-encoded as JPEG — about a fiftieth of
	 * the size, and still obviously the page it came from.
	 */
	const capturePage = async (of?: string): Promise<string | null> => {
		// `captureVisibleTab` photographs whatever tab is in front, which from the
		// dashboard is the dashboard. Asked for a picture of a particular page, it
		// only answers when that page is actually the one on screen — a picture of
		// the wrong thing is worse than no picture, and silently so.
		if (of) {
			const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [])
			// Compared without the fragment: a content script reports
			// `location.href`, Chrome reports `tab.url`, and the two differ by a
			// `#` often enough that an exact match silently refused to take a
			// picture of the very page that asked for one.
			const same = (a?: string, b?: string) => !!a && !!b && a.replace(/#.*$/, '') === b.replace(/#.*$/, '')
			if (!same(active?.url, of)) return null
		}
		const png = await chrome.tabs.captureVisibleTab({ format: 'png' }).catch(() => null)
		if (!png) return null
		try {
			const bitmap = await createImageBitmap(await (await fetch(png)).blob())
			// A screenshot is read, not admired: the text in it has to be legible or
			// the picture is worth nothing. On a Retina screen the capture comes
			// back at twice the CSS size, so squeezing it to 1000px — which is what
			// this did first — turned every line of text into grey mush.
			//
			// So the width is kept generous and the *quality* gives way instead,
			// step by step, until the file is a reasonable size. Text survives a
			// lower JPEG quality far better than it survives being shrunk.
			const tries: [number, number][] = [
				[1800, 0.86],
				[1600, 0.78],
				[1280, 0.7],
			]
			const BUDGET = 600_000
			let last = png
			for (const [width, quality] of tries) {
				const scale = Math.min(1, width / bitmap.width)
				const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
				const ctx = canvas.getContext('2d')
				if (!ctx) break
				// Smoothing on, at the highest setting: a downscale without it is
				// aliased, which reads as "blurry" even when it is sharp.
				ctx.imageSmoothingEnabled = true
				ctx.imageSmoothingQuality = 'high'
				ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
				const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
				const buf = new Uint8Array(await blob.arrayBuffer())
				let binary = ''
				for (const byte of buf) binary += String.fromCharCode(byte)
				last = `data:image/jpeg;base64,${btoa(binary)}`
				if (buf.byteLength <= BUDGET) break
			}
			bitmap.close()
			return last
		} catch {
			// No canvas, or a page that refuses to be read: the full-size one is
			// better than nothing, and the count cap still applies.
			return png
		}
	}

	/**
	 * The same pulse the box draws, for the paths that have no box.
	 *
	 * The right-click menu takes a picture and then opens a different tab; the
	 * widget takes one and closes. Without this, a screenshot is taken silently
	 * and the person has to take the app's word for what it caught.
	 */
	const flashShot = async (tabId: number) => {
		await chrome.scripting
			.executeScript({
				target: { tabId },
				func: () => {
					const frame = document.createElement('div')
					frame.style.cssText =
						'position:fixed;inset:0;z-index:2147483647;pointer-events:none;border:3px solid #4f46e5;box-shadow:inset 0 0 0 100vmax rgba(79,70,229,.14);transition:opacity .45s ease-out;opacity:1'
					document.body.append(frame)
					setTimeout(() => {
						frame.style.opacity = '0'
						frame.style.boxShadow = 'inset 0 0 0 0 rgba(79,70,229,0)'
					}, 120)
					setTimeout(() => frame.remove(), 700)
				},
			})
			.catch(() => undefined)
	}

	/**
	 * A recording of whatever you point it at.
	 *
	 * `desktopCapture` rather than `tabCapture`: half of what makes a bug video
	 * worth watching happens outside the tab — the other window you compared it
	 * against, the terminal, the dialog Chrome drew over everything. Its picker
	 * offers the whole screen, any application window, or any tab, and it is the
	 * same picker people already know from every screen-sharing tool.
	 *
	 * The stream id it hands back is only usable by this extension, and only by
	 * a document that can hold a MediaStream — which is the offscreen one, not
	 * this worker.
	 *
	 * The permission itself is asked for by whichever surface was clicked, not
	 * here: Chrome only grants an optional permission during a user gesture on
	 * an extension page, and a service worker has neither. Asking from here
	 * always failed, which is what "permission was not given" used to mean.
	 */
	const startClip = async (seconds: number, id: string, mic: boolean): Promise<{ ok: boolean; why?: string }> => {
		const allowed = await chrome.permissions.contains({ permissions: ['desktopCapture'] }).catch(() => false)
		if (!allowed) return { ok: false, why: 'Chrome needs permission to record the screen. Press Record again and allow it.' }
		// Granted, but this worker was started before the grant and so never got
		// the API. A worker that reloads itself picks it up; the next press works.
		if (!chrome.desktopCapture?.chooseDesktopMedia) {
			setTimeout(() => chrome.runtime.reload(), 200)
			return { ok: false, why: 'Recording has just been allowed. Press Record once more.' }
		}
		const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
		// `audio` in the list is what puts the "Also share audio" checkbox in the
		// picker. Whether it is ticked is the recorder's problem, not ours.
		const picked = await new Promise<{ streamId: string; audio: boolean } | null>((resolve) =>
			chrome.desktopCapture.chooseDesktopMedia(['screen', 'window', 'tab', 'audio'], tab, (streamId, options) =>
				resolve(streamId ? { streamId, audio: !!options?.canRequestAudioTrack } : null),
			),
		)
		// Cancelling the picker is a decision, not a failure: nothing to say.
		if (!picked) return { ok: false, why: '' }
		await ensureOffscreen()
		await chrome.runtime
			.sendMessage({ wp: 'clip-start', id, streamId: picked.streamId, system: picked.audio, mic, seconds, bitrate: BITS_PER_SECOND })
			.catch(() => undefined)
		return { ok: true }
	}

	const ensureOffscreen = async () => {
		if (await chrome.offscreen?.hasDocument?.()) return
		await chrome.offscreen.createDocument({
			url: 'offscreen.html',
			reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.AUDIO_PLAYBACK],
			justification: 'Record the screen, window or tab you chose, with your narration, and play reminder sounds.',
		})
	}

	// The finished recording comes back here, from the offscreen document.
	chrome.runtime.onMessage.addListener((msg: { wp?: string; id?: string; ms?: number; bytes?: number; type?: string }) => {
		if (msg?.wp !== 'clip-done' || !msg.id) return false
		void commands.clipRecorded({ id: msg.id, ms: msg.ms ?? 0, bytes: msg.bytes ?? 0, type: msg.type ?? 'video/webm' })
		return false
	})

	const playSound = async (what: 'chime' | 'alarm' | 'alarm-stop') => {
		try {
			const existing = await chrome.offscreen?.hasDocument?.()
			if (!existing) {
				if (what === 'alarm-stop') return // nothing is playing
				await chrome.offscreen.createDocument({
					url: 'offscreen.html',
					reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
					justification: 'Play a chime or an alarm with a reminder you asked for.',
				})
			}
			await chrome.runtime.sendMessage({ wp: what })
		} catch {
			// No offscreen API, or the document is already closing: a silent
			// reminder is still a reminder.
		}
	}
	const playChime = () => playSound('chime')

	const engine = new Engine({ store, zoho, now: () => Date.now(), idleSecs, ui })
	const commands = new Commands(engine, zoho)

	const tick = () => engine.tick().catch((e) => console.warn('[WorkPulse] tick failed', e))
	const ensureAlarm = async () => {
		if (!(await chrome.alarms.get(TICK))) await chrome.alarms.create(TICK, { periodInMinutes: 1, delayInMinutes: 0.1 })
	}

	// The right-click menu is rebuilt for whatever tab you are on, so the ticket
	// a page belongs to is already in it before you click. Chrome needs the items
	// to exist ahead of the click, which is why this follows the active tab
	// rather than being built once.
	const TZ_MENU = 'wp-convert-time'
	const NOTE_MENU = 'wp-note-page'
	let menuFor = ''

	const buildMenu = async (tab?: chrome.tabs.Tab) => {
		const page: { title: string; url: string; keys?: string[] } = { title: tab?.title ?? '', url: tab?.url ?? '' }
		const stamp = `${page.url}|${page.title}`
		if (stamp === menuFor) return
		menuFor = stamp
		const usable = /^https?:/.test(page.url)
		// A Confluence page, a PR description, a chat thread: the ticket is often
		// named in the body and nowhere else. The page is only read when the title
		// and the address came up with nothing, and only for its keys.
		if (usable && tab?.id != null && !keysIn(`${page.title} ${page.url}`, await commands.prefixes()).length) {
			const pattern = await commands.keyPattern()
			const found = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scanKeys, args: [pattern] }).catch(() => null)
			page.keys = found?.[0]?.result ?? []
		}
		const items = usable ? await commands.pageMenuFor(page).catch(() => []) : []
		await new Promise<void>((done) => chrome.contextMenus.removeAll(() => done()))
		const make = (o: chrome.contextMenus.CreateProperties) => new Promise<void>((done) => chrome.contextMenus.create(o, () => (chrome.runtime.lastError, done())))
		for (const item of items) {
			await make({ id: item.id, title: item.title, parentId: item.parentId, contexts: ['page', 'link', 'image', 'selection'] })
		}
		await make({ id: TZ_MENU, title: 'WorkPulse: “%s” in my time', contexts: ['selection'] })
		// For everyone, team or not: a note on a page is worth keeping whether or
		// not anybody else ever reads it.
		await make({ id: NOTE_MENU, title: 'WorkPulse: note this page…', contexts: ['page', 'selection', 'image'] })
	}

	const refreshMenu = () =>
		void chrome.tabs
			.query({ active: true, lastFocusedWindow: true })
			.then(([tab]) => buildMenu(tab))
			.catch(() => undefined)

	chrome.tabs.onActivated.addListener(refreshMenu)
	chrome.tabs.onUpdated.addListener((_id, change, tab) => {
		if (tab.active && (change.title || change.url)) void buildMenu(tab)
	})
	chrome.windows.onFocusChanged.addListener(refreshMenu)

	/**
	 * The box, on whatever page you are on.
	 *
	 * The script is put there when the keystroke arrives rather than injected
	 * into every tab at load — the same arrangement the reminder overlay uses,
	 * for the same reason: a content script in every tab for something used
	 * twice an hour is a cost paid all day.
	 */
	const PALETTE_FILE = 'content-scripts/palette.js'
	/**
	 * Both ways in can land at once.
	 *
	 * Chrome's command fires, and so does the in-page listener that exists
	 * because the command might not have. Each one opens; the second open
	 * toggles the box straight back shut, which looks exactly like the
	 * shortcut being broken. So a second request inside this window is the
	 * same press and is dropped.
	 */
	let lastPalette = 0
	const openPalette = async () => {
		const now = Date.now()
		if (now - lastPalette < 400) return
		lastPalette = now
		const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
		if (tab?.id == null) return
		const poke = () => chrome.tabs.sendMessage(tab.id!, { wp: 'palette' }).then(() => true, () => false)
		if (await poke()) return
		// A page that refuses injection — the Web Store, a PDF — still gets the
		// dashboard, which is the same box with more room.
		const put = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [PALETTE_FILE] }).then(() => true, () => false)
		if (!put) return ui.openDashboard('today')
		await new Promise((r) => setTimeout(r, 120))
		await poke()
	}

	// The in-page listener, for when Chrome refused the command. Its own
	// listener rather than a branch inside the RPC one, which is typed for calls.
	chrome.runtime.onMessage.addListener((msg: { wp?: string }) => {
		if (msg?.wp === 'palette-key') void openPalette()
		return false
	})

	chrome.commands?.onCommand.addListener(async (command) => {
		if (command === 'open-palette') return void openPalette()
		if (command === 'log-now') return void commands.logNow()
	})

	chrome.contextMenus.onClicked.addListener(async (info, tab) => {
		// Something wrong with the page you are on. The screenshot is taken here,
		// while the page is still in front of you — by the time a form is open it
		// is a picture of the form.
		if (info.menuItemId === NOTE_MENU) {
			const url = tab?.url ?? info.pageUrl
			if (!url) return
			const shot = (await capturePage()) ?? undefined
			await commands.draftPageNote({ url, title: tab?.title, where: info.selectionText?.slice(0, 200), shot })
			await ui.openDashboard('notes')
			return
		}
		// A time someone else wrote, in your clock.
		if (info.menuItemId === TZ_MENU && info.selectionText) {
			const c = await commands.convertTime(info.selectionText).catch(() => null)
			if (!c) {
				ui.notify('tz', 'No time in that selection', 'Select something like “3pm PST” or “Oct 12, 17:44 GMT+5:30”.', false)
				return
			}
			const lines = c.rows.map((r) => `${r.time} · ${r.day} — ${r.label}${r.mine ? ' (you)' : ''}`)
			const title = `${c.read} ${c.assumedZone ? '· no zone given, read as yours' : `· ${c.from.split('/').pop()!.replace(/_/g, ' ')}`}`
			if (tab?.id != null && (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: showBubble, args: [title, lines] }).catch(() => null))) return
			// A page that refuses injection — a PDF, the Web Store — still answers.
			ui.notify('tz', title, lines.join('\n'), false)
			return
		}

		// The one-click things. Each takes whatever is under the cursor — the
		// selected sentence, or the page — and does one thing with it, without
		// leaving the page to do it.
		const did = menuDo(String(info.menuItemId))
		if (did) {
			const url = info.linkUrl || tab?.url || info.pageUrl || ''
			const picked = (info.selectionText ?? '').trim()
			const title = tab?.title ?? url
			try {
				if (did === 'note') {
					const shot = (await capturePage()) ?? undefined
					if (shot && tab?.id != null) await flashShot(tab.id)
					await commands.draftPageNote({ url, title, where: picked.slice(0, 200), shot })
					await ui.openDashboard('notes')
				} else if (did === 'todo') {
					await commands.capture({ text: picked || title, url })
					ui.notify('filed', 'Added to your tasks', picked || title, false)
				} else if (did === 'remind') {
					// Tomorrow morning, with the page attached — the shape of nearly
					// every "I must look at this again" there is.
					const when = `${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T09:30`
					await commands.capture({ text: picked || title, url, when })
					ui.notify('filed', 'You will hear about this tomorrow', `${picked || title} · 09:30`, false)
				} else if (did === 'learn') {
					if (!picked) return ui.notify('filed', 'Select the line first', 'Highlight what is worth remembering, then right-click it.', false)
					await commands.saveLearning({ text: picked })
					ui.notify('filed', 'Saved to your learnings', picked.slice(0, 120), false)
				} else if (did === 'log') {
					const ctx = await commands.promptContext(true)
					await commands.saveEntry({ slotStart: ctx.slotStart, slotEnd: ctx.slotEnd, text: picked || title, jobId: ctx.defaultJobId || undefined, minutes: ctx.minutes })
					ui.notify('filed', `Logged ${ctx.label}`, picked || title, false)
				} else if (did === 'focus') {
					await commands.startFocus(50, undefined, picked || title)
					ui.notify('filed', '50 minutes', `On “${(picked || title).slice(0, 80)}”. Nothing will interrupt.`, false)
				}
			} catch (e) {
				ui.notify('filed', 'Could not do that', errText(e), false)
			}
			return
		}

		// Filing the page under a ticket. The link under the cursor wins over the
		// page itself: right-clicking a PR link should save the PR.
		const action = menuAction(String(info.menuItemId))
		if (!action) return
		const url = info.linkUrl || tab?.url || info.pageUrl
		if (!url) return
		const page = { title: (info.linkUrl ? info.selectionText || info.linkUrl : tab?.title) || url, url }
		try {
			if (action.kind === 'new') {
				// A selected key beats no key: right-clicking "PAY-2433" in a sentence
				// names the ticket after it.
				const prefixes = await commands.prefixes()
				const key = action.key || keysIn(info.selectionText ?? '', prefixes)[0] || ''
				const w = await commands.ticketFromKey(key, page)
				ui.notify('filed', `Started ${w.name}`, 'This page is its first link.', false)
			} else {
				await commands.addToWorkspace(action.ticketId, [page])
				const w = (await commands.workspaces()).find((x) => x.id === action.ticketId)
				ui.notify('filed', `Added to ${w?.name ?? 'the ticket'}`, `${page.title}`.slice(0, 120), false)
			}
			menuFor = '' // the menu has changed: rebuild it on the next look
			void refreshMenu()
		} catch (e) {
			ui.notify('filed', 'Could not file that', errText(e), false)
		}
	})

	// The one moment it is fair to ask why: on the way out, where it costs the
	// person nothing and is the only feedback an extension with no telemetry
	// will ever get.
	chrome.runtime.setUninstallURL?.('https://github.com/myind-ai/workpulse-extension/discussions/new?category=feedback')

	chrome.runtime.onInstalled.addListener(async (details) => {
		await ensureAlarm()
		refreshMenu()
		if (details.reason === 'install') await ui.openDashboard('connect')
		void tick()
	})
	chrome.runtime.onStartup.addListener(async () => {
		await ensureAlarm()
		refreshMenu()
		// The browser has just started, so you have just sat down. "Take a break"
		// as the first thing it says is the clock being right and the app being
		// wrong.
		await engine.arrived()
		void tick()
	})
	void ensureAlarm()

	chrome.alarms.onAlarm.addListener((a) => {
		if (a.name !== TICK) return
		void tick()
		// Once a day, and only for a zip install; it returns at once otherwise.
		void commands.checkForUpdate().catch(() => undefined)
	})
	// The version that ran first is the one "updated to …" is measured from.
	void store.runtime().then((rt) => (rt.update?.seen ? undefined : commands.seenVersion())).catch(() => undefined)
	chrome.idle.onStateChanged.addListener(() => void tick())

	chrome.runtime.onMessage.addListener((msg: CallMessage, _sender, sendResponse) => {
		if (msg?.wp !== 'call') return false
		const fn = (commands as unknown as Record<string, unknown>)[msg.method]
		if (typeof fn !== 'function' || msg.method === 'constructor') {
			// Almost always a page from a newer build talking to a worker from an
			// older one: say that, rather than leaving the name as the whole answer.
			sendResponse({ ok: false, error: `WorkPulse needs reloading — this page asked for “${msg.method}”, which the running extension does not have. Open chrome://extensions and press Reload.` })
			return false
		}
		Promise.resolve()
			.then(() => (fn as (...a: unknown[]) => unknown).apply(commands, msg.args ?? []))
			.then((result) => sendResponse({ ok: true, result }))
			.catch((e) => sendResponse({ ok: false, error: errText(e) }))
		return true
	})

	/**
	 * A page the team has said something about wears a badge on the toolbar, so
	 * you know before you click rather than after. Per tab, so it does not fight
	 * the day's own badge on every other page.
	 */
	/**
	 * You opened something mid-block that you had said was not the work.
	 *
	 * One line, in the page, for a few seconds. Nothing is blocked and nothing
	 * is scolded: the only thing needed by someone who has just caught
	 * themselves is for the decision to be conscious.
	 */
	const markStray = async (tabId: number, url?: string) => {
		if (!url || !/^https?:/.test(url)) return
		const said = await commands.noteStray(url).catch(() => null)
		if (!said) return
		await chrome.scripting.executeScript({ target: { tabId }, func: showBubble, args: ['Focus', [said.line, 'Nothing is blocked — this is just a nudge.']] }).catch(() => undefined)
	}

	/**
	 * Arriving on a page you have written on.
	 *
	 * The badge alone was too quiet: a note you cannot see is a note you did not
	 * write. So the first time a tab lands on a page with something open on it,
	 * the note itself appears in the corner — once per tab per page, because the
	 * second time you have already read it.
	 */
	const toldOn = new Map<number, string>()
	const markNotes = async (tabId: number, url?: string) => {
		if (!url || !/^https?:/.test(url)) return
		const n = await commands.noteCount(url).catch(() => ({ open: 0, closed: 0 }))
		await chrome.action.setBadgeText({ tabId, text: n.open ? String(n.open) : '' }).catch(() => undefined)
		if (!n.open) return
		await chrome.action.setBadgeBackgroundColor({ tabId, color: '#7c3aed' }).catch(() => undefined)

		const key = `${tabId}:${url}`
		if (toldOn.get(tabId) === key) return
		toldOn.set(tabId, key)
		const got = await commands.notesOnPage(url).catch(() => null)
		const open = (got?.notes ?? []).filter((x) => x.state !== 'closed').slice(0, 2)
		if (!open.length) return
		const title = open.length === 1 ? 'You noted this page' : `${n.open} notes on this page`
		const lines = open.map((x) => `${x.source === 'team' ? `${x.author}: ` : ''}${x.text.slice(0, 160)}`)
		await chrome.scripting.executeScript({ target: { tabId }, func: showBubble, args: [title, lines, true] }).catch(() => undefined)
	}
	chrome.tabs.onRemoved.addListener((tabId) => toldOn.delete(tabId))

	/**
	 * Arriving on a ticket, a pull request, staging or localhost the Brain knows.
	 *
	 * What you or Claude Code wrote last time — the next action, the root cause —
	 * is worth most at the moment you are back on the thing. Once per tab per
	 * page, and never over a page note, which is the more specific of the two.
	 */
	const toldBrain = new Map<number, string>()
	const markRelated = async (tabId: number, url?: string, title?: string) => {
		if (!url || !/^https?:/.test(url)) return
		const where = `${url.split('#')[0]}`
		if (toldBrain.get(tabId) === where) return
		if (!(await store.settings()).brainOnPages) return
		const r = await commands.relatedContext(url, title).catch(() => null)
		if (!r?.total) return
		if ((await commands.noteCount(url).catch(() => ({ open: 0 }))).open) return
		toldBrain.set(tabId, where)
		const about = r.keys[0] ?? r.repo ?? 'this page'
		const next = r.entries.find((e) => e.next?.some(Boolean))
		const cause = r.entries.find((e) => e.rootCause)
		const lines = [
			next && `Next: ${next.next!.filter(Boolean)[0]}`,
			cause && `Root cause before: ${cause.rootCause}`,
			...r.entries.filter((e) => e !== next && e !== cause).slice(0, next || cause ? 1 : 3).map((e) => `${e.kind}: ${e.title}`),
			r.total > 3 && `${r.total} in all — Alt+Shift+K → This page`,
		].filter((x): x is string => !!x).map((x) => x.slice(0, 180))
		await chrome.scripting.executeScript({ target: { tabId }, func: showBubble, args: [`Brain: ${r.total} record${r.total === 1 ? '' : 's'} for ${about}`, lines, true] }).catch(() => undefined)
	}
	chrome.tabs.onRemoved.addListener((tabId) => toldBrain.delete(tabId))

	// Forced UI follows you: every tab you switch to shows it until you answer.
	chrome.tabs.onActivated.addListener(async ({ tabId }) => {
		const tab = await chrome.tabs.get(tabId).catch(() => null)
		void markNotes(tabId, tab?.url)
		void markRelated(tabId, tab?.url, tab?.title)
		void markStray(tabId, tab?.url)
		if (!(await store.runtime()).pending) return
		await presenter.poke(tabId, tab?.url)
	})
	chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
		if (info.status !== 'complete' || !tab.active) return
		void markNotes(tabId, tab.url)
		void markRelated(tabId, tab.url, tab.title)
		void markStray(tabId, tab.url)
		if ((await store.runtime()).pending) await presenter.poke(tabId, tab.url)
	})
	chrome.windows.onRemoved.addListener((id) => void presenter.onWindowRemoved(id, (p) => engine.owed(p)))

	// Guided setup: inject the helper on Zoho's console / People pages only while
	// that setup step is running.
	chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
		if (info.status !== 'complete') return
		// Opening Zoho People is the moment its data is freshest and the tab is
		// there to read: sync then, instead of waiting for the next minute's tick.
		if (/^https:\/\/people\.zoho\./.test(tab.url ?? '')) void commands.syncOnZohoTab()
		const step = setupHost(tab.url)
		if (!step) return
		if ((await store.setupFlags())[step]) await chrome.scripting.executeScript({ target: { tabId }, files: [HELPER_FILE] }).catch(() => undefined)
	})

	// Endpoint discovery for the no-API path: while recording, note the XHRs
	// Zoho's own web app makes. Observation only — nothing is blocked or changed.
	// The permission is optional and granted from the setup button, so the
	// listeners are attached when it arrives as well as at startup.
	// Zoho's reads are POSTs whose mode rides in the body, so the body is needed
	// to replay them; it arrives on a different event than the headers, hence
	// the short-lived join on requestId.
	const bodies = new Map<string, string>()

	const onBody = (d: chrome.webRequest.WebRequestBodyDetails) => {
		if (!recording || !d.requestBody) return
		const { formData, raw } = d.requestBody
		if (formData) bodies.set(d.requestId, new URLSearchParams(Object.entries(formData).flatMap(([k, vs]) => (vs ?? []).map((v) => [k, String(v)]))).toString())
		else if (raw?.[0]?.bytes) bodies.set(d.requestId, new TextDecoder().decode(raw[0].bytes).slice(0, 2000))
		if (bodies.size > 200) bodies.delete(bodies.keys().next().value!)
	}

	const onHeaders = (d: chrome.webRequest.WebRequestHeadersDetails) => {
		if (!recording) return
		const headers: Record<string, string> = {}
		for (const h of d.requestHeaders ?? []) {
			if (!SECRET_HEADER.test(h.name) && /^(content-type$|x-|.*csrf)/i.test(h.name) && h.value) headers[h.name] = h.value
		}
		const body = bodies.get(d.requestId)
		bodies.delete(d.requestId)
		const contentType = Object.entries(headers).find(([k]) => /^content-type$/i.test(k))?.[1]
		void commands.noteRequest({ at: Date.now(), method: d.method, url: d.url, body, contentType, headers })
	}

	/**
	 * Attached only once the optional permission exists — at startup if it was
	 * granted before, and the moment the setup button is allowed.
	 */
	const watchZoho = () => {
		if (!chrome.webRequest?.onBeforeRequest || chrome.webRequest.onBeforeRequest.hasListener(onBody)) return
		chrome.webRequest.onBeforeRequest.addListener(onBody, { urls: ZOHO_URLS, types: ['xmlhttprequest'] }, ['requestBody'])
		chrome.webRequest.onBeforeSendHeaders.addListener(onHeaders, { urls: ZOHO_URLS, types: ['xmlhttprequest'] }, ['requestHeaders'])
	}
	void chrome.permissions.contains({ permissions: ['webRequest'] }).then((has) => has && watchZoho())
	chrome.permissions.onAdded.addListener((p) => {
		if (p.permissions?.includes('webRequest')) watchZoho()
	})

	chrome.notifications.onClicked.addListener(async (id) => {
		chrome.notifications.clear(id)
		if (id === 'wp-taskdue') {
			const { reminderUrl } = await store.runtime()
			return reminderUrl ? ui.openUrl(reminderUrl) : ui.openDashboard('tasks')
		}
		if (id === 'wp-issues') return ui.openDashboard('issues')
		if (id === 'wp-weekreview') return ui.openDashboard('record')
		// Clicking a booked block starts it, which is the whole of what it is for.
		if (id === 'wp-block') return void commands.startBookedBlock()
		if (id === 'wp-learn' || id === 'wp-loop') return ui.openDashboard('journal')
		if (id === 'wp-filed') return ui.openDashboard('links')
		if (id === 'wp-catchup' || id === 'wp-wrapup') return ui.openDashboard('review')
		const p = (await store.runtime()).pending
		if (p) await presenter.show({ ...p, blocking: true })
		else await ui.openDashboard('today')
	})
})

/**
 * Runs in the page, not here: a small box by the corner with the converted
 * times. Its own shadow root, so the page's CSS cannot touch it and it cannot
 * touch the page's. Closes on Escape, a click, or after ten seconds.
 */
/**
 * The one thing WorkPulse says in a page it does not own.
 *
 * Deliberately plain DOM in a closed shadow root: it runs in whatever page you
 * are on, so it cannot import anything, cannot inherit the page's CSS, and must
 * not survive longer than it is wanted. `stay` is for things worth reading
 * twice — a note somebody left on this page — rather than a passing conversion.
 */
function showBubble(title: string, lines: string[], stay = false) {
	document.getElementById('wp-tz-bubble')?.remove()
	const host = document.createElement('div')
	host.id = 'wp-tz-bubble'
	host.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;'
	const root = host.attachShadow({ mode: 'closed' })
	const box = document.createElement('div')
	box.style.cssText = [
		'font:13px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,system-ui,sans-serif',
		'background:#0f172a',
		'color:#f8fafc',
		'padding:10px 14px',
		'border-radius:10px',
		'box-shadow:0 18px 48px rgba(0,0,0,.35)',
		'max-width:320px',
	].join(';')
	const head = document.createElement('div')
	head.textContent = title
	head.style.cssText = 'font-weight:600;margin-bottom:6px'
	box.append(head)
	for (const line of lines) {
		const row = document.createElement('div')
		row.textContent = line
		// A note someone wrote is a sentence, not a time: let it wrap.
		row.style.cssText = stay ? 'opacity:.92;margin-top:4px' : 'white-space:nowrap;opacity:.92'
		box.append(row)
	}
	if (stay) {
		const hint = document.createElement('div')
		hint.textContent = 'Click to dismiss · the widget has the rest'
		hint.style.cssText = 'margin-top:8px;font-size:11px;opacity:.6'
		box.append(hint)
	}
	root.append(box)
	document.body.append(host)
	// One teardown, so the page is left exactly as it was found. `{ once: true }`
	// on the Escape handler only removes it if Escape is actually pressed — a
	// bubble that times out quietly used to leave its listener, and its closure,
	// in the page for as long as the tab lived.
	const esc = (e: KeyboardEvent) => e.key === 'Escape' && off()
	const timer = setTimeout(() => off(), stay ? 20_000 : 10_000)
	function off() {
		clearTimeout(timer)
		removeEventListener('keydown', esc)
		host.remove()
	}
	host.addEventListener('click', off)
	addEventListener('keydown', esc)
}

/**
 * Runs in the page: every ticket key its text mentions, most frequent first.
 * Nothing can be imported in here, so the pattern is handed in — see
 * `core/links.keyPattern`. `textContent` rather than `innerText` on purpose:
 * `innerText` forces a layout pass, and this runs on pages you are only looking
 * at. Bounded, because some pages are enormous.
 */
function scanKeys(pattern: string): string[] {
	const LIMIT = 120_000
	const text = `${document.title} ${(document.body?.textContent ?? '').slice(0, LIMIT)}`.toUpperCase()
	const counts = new Map<string, number>()
	for (const m of text.matchAll(new RegExp(pattern, 'g'))) {
		const key = `${m[1]}-${m[2]}`
		counts.set(key, (counts.get(key) ?? 0) + 1)
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([key]) => key)
}

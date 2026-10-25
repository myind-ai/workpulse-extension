import { putBlob } from '@/lib/blobs'

// MV3 service workers cannot play audio, and a page's autoplay policy can mute
// an injected one. An offscreen document is the one place a chime reliably
// plays, so the reminder is heard and not only seen.
//
// Two short notes from the Web Audio API rather than a bundled file: nothing to
// ship, nothing to decode, and it cannot fail to load.

function chime(pitch = 1, volume = 0.25) {
	const ctx = new AudioContext()
	const at = ctx.currentTime
	for (const [i, freq] of [880 * pitch, 1174.7 * pitch].entries()) {
		const osc = ctx.createOscillator()
		const gain = ctx.createGain()
		osc.type = 'sine'
		osc.frequency.value = freq
		const start = at + i * 0.18
		gain.gain.setValueAtTime(0.0001, start)
		gain.gain.exponentialRampToValueAtTime(volume, start + 0.02)
		gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22)
		osc.connect(gain).connect(ctx.destination)
		osc.start(start)
		osc.stop(start + 0.24)
	}
	setTimeout(() => void ctx.close(), 800)
}

/**
 * An alarm, as opposed to a chime.
 *
 * A meeting starts without you: a single note you happened to miss is the same
 * as no note at all. So this keeps going — a two-note phrase every two seconds,
 * rising slightly each time so it does not fade into the room — until it is
 * answered or until it has rung long enough to have been heard.
 */
let ringing: ReturnType<typeof setInterval> | null = null
let rang = 0

function stopAlarm() {
	if (ringing) clearInterval(ringing)
	ringing = null
	rang = 0
}

function alarm() {
	if (ringing) return // already going; a second request is not a second alarm
	const ring = () => {
		// Rising, but only to a point: an alarm that climbs for ever is a siren.
		chime(1 + Math.min(rang, 4) * 0.06, 0.3)
		rang += 1
		// Five minutes of ringing is an alarm clock nobody can find.
		if (rang > 150) stopAlarm()
	}
	ring()
	ringing = setInterval(ring, 2000)
}

// ── recording ───────────────────────────────────────────────────────────────
//
// A service worker cannot hold a MediaStream, and a content script cannot be
// given one. The offscreen document can do both, which is the only reason it
// exists for anything other than the chime.

let recorder: MediaRecorder | null = null
let chunks: Blob[] = []
let startedAt = 0
/** Everything to shut down when the recording ends, in one place. */
let closers: (() => void)[] = []

/** The desktop picker's stream id, in the shape `getUserMedia` wants for it. */
const desktop = (streamId: string) => ({ mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: streamId } })

/**
 * The microphone, if it was asked for and is allowed.
 *
 * Never fatal. A recording with no narration is worth having; losing the
 * recording because a headset was unplugged is not. The permission itself is
 * granted on the extension's origin from the widget, which is the only place
 * there is a user gesture and a window to show a prompt in.
 */
async function micTrack(): Promise<MediaStreamTrack | null> {
	try {
		const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
		return s.getAudioTracks()[0] ?? null
	} catch {
		return null
	}
}

/**
 * One audio track out of two.
 *
 * MediaRecorder writes a single audio track, so the page's sound and your voice
 * have to be mixed before they reach it rather than attached as two tracks —
 * the second one would simply be dropped.
 */
function mix(tracks: MediaStreamTrack[]): MediaStreamTrack | null {
	if (!tracks.length) return null
	if (tracks.length === 1) return tracks[0]
	const ctx = new AudioContext()
	const out = ctx.createMediaStreamDestination()
	for (const t of tracks) ctx.createMediaStreamSource(new MediaStream([t])).connect(out)
	closers.push(() => void ctx.close().catch(() => undefined))
	return out.stream.getAudioTracks()[0] ?? null
}

async function startClip(id: string, streamId: string, opts: { system: boolean; mic: boolean; seconds: number; bitrate: number }): Promise<void> {
	stopClip()
	closers = []

	// Video and system audio come from the same picked source, so they are asked
	// for together — a second getUserMedia on the same stream id is refused.
	const screen = await navigator.mediaDevices.getUserMedia({
		audio: opts.system ? desktop(streamId) : false,
		video: desktop(streamId),
	} as unknown as MediaStreamConstraints)
	const video = screen.getVideoTracks()[0]
	const heard = [...screen.getAudioTracks()]
	const voice = opts.mic ? await micTrack() : null
	if (voice) heard.push(voice)

	const audio = mix(heard)
	const stream = new MediaStream(audio ? [video, audio] : [video])
	closers.push(() => {
		for (const t of [...screen.getTracks(), ...(voice ? [voice] : []), ...stream.getTracks()]) t.stop()
	})

	// vp9 with opus: the combination every browser and every player agrees on.
	const type =
		['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t)) ?? 'video/webm'
	chunks = []
	startedAt = Date.now()
	recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: opts.bitrate, audioBitsPerSecond: 128_000 })
	recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
	recorder.onerror = () => stopClip()
	recorder.onstop = async () => {
		for (const close of closers) close()
		closers = []
		const blob = new Blob(chunks, { type })
		const ms = Date.now() - startedAt
		chunks = []
		recorder = null
		// Stored from here rather than sent to the worker. A message carries a
		// string, so handing over a recording meant base64 — a third larger
		// again, built in memory, and past Chrome's message limit long before an
		// hour of video. IndexedDB is the same origin from both sides, so the
		// worker only needs to be told where it landed.
		const bytes = await putBlob(id, blob)
			.then(() => blob.size)
			.catch(() => 0)
		void chrome.runtime.sendMessage({ wp: 'clip-done', id, ms, bytes, type, audio: !!audio }).catch(() => undefined)
	}
	// A timeslice keeps each chunk small, so a long recording is a list of
	// manageable blobs rather than one that has to be grown in place.
	recorder.start(2000)
	// Chrome's own "Stop sharing" bar, or the window being closed: stop here too,
	// so what was recorded up to that point is kept instead of lost.
	video.addEventListener('ended', () => stopClip())
	// It also stops itself eventually: a recording left running for ever is the
	// one thing worse than no recording.
	const timer = setTimeout(() => stopClip(), opts.seconds * 1000)
	closers.push(() => clearTimeout(timer))
}

function stopClip(): void {
	if (recorder && recorder.state !== 'inactive') recorder.stop()
	else recorder = null
}

chrome.runtime.onMessage.addListener(
	(msg: { wp?: string; id?: string; streamId?: string; system?: boolean; mic?: boolean; seconds?: number; bitrate?: number }) => {
		if (msg?.wp === 'chime') chime()
		if (msg?.wp === 'alarm') alarm()
		if (msg?.wp === 'alarm-stop') stopAlarm()
		if (msg?.wp === 'clip-start' && msg.streamId && msg.id)
			void startClip(msg.id, msg.streamId, {
				system: !!msg.system,
				mic: !!msg.mic,
				seconds: msg.seconds ?? 7200,
				bitrate: msg.bitrate ?? 1_800_000,
			})
		if (msg?.wp === 'clip-stop') stopClip()
	},
)

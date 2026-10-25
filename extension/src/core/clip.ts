// A short recording of the tab, for the things a picture cannot show.
//
// "It only happens on the second click", "the spinner never stops", "watch what
// the total does" — none of those survive a screenshot, and all of them are
// what a bug report is actually about. The alternative people use today is a
// screen recorder, a file on the desktop, and a drag into a chat window.
//
// A recording runs until you stop it. The ceiling below is a safety net for a
// recording nobody came back to stop, not a feature limit — the thing people
// actually need to film is the ten-minute repro, not the ten-second one.
//
// Size is still arithmetic: a minute at this bitrate is about fourteen
// megabytes. That is fine on disk, and deliberately not fine in a git backup,
// which is why the backup has its own much smaller ceiling.

/** A recording nobody stopped. Two hours, then it stops itself. */
export const MAX_SECONDS = 7200

/** Roughly a megabyte every four seconds at this bitrate. */
export const BITS_PER_SECOND = 1_800_000

/** Anything above this is dropped rather than stored: something went wrong. */
export const MAX_BYTES = 2_000_000_000

/**
 * Git keeps every version of every file for ever, and a repository nobody can
 * clone is a backup nobody has. Long recordings stay on this machine.
 */
export const BACKUP_MAX_BYTES = 12_000_000

export interface Clip {
	/** The key it is stored under, in the blob store. */
	id: string
	/** How long it runs. */
	ms: number
	bytes: number
	at: number
	/** `video/webm;codecs=vp9,opus` or whatever the browser agreed to. */
	type: string
	/** Where it was uploaded to, once somebody chose to put it somewhere. */
	url?: string
}

/** "0:18" — the only format a clip length is ever read in. */
export function clipLength(ms: number): string {
	const total = Math.round(ms / 1000)
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * What the file is called once it leaves here.
 *
 * `workpulse-2026-10-16-0918-a1b2.webm`. A folder of `recording (3).webm` tells
 * nobody anything six months later, and six months later is the only time
 * anybody opens it.
 */
export function clipName(c: { id: string; at: number }): string {
	const d = new Date(c.at)
	const pad = (n: number) => String(n).padStart(2, '0')
	const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
	return `workpulse-${stamp}-${c.id.slice(0, 4)}`
}

/**
 * The one release everything is attached to.
 *
 * One release rather than one per recording: a repository's release list is
 * something people read, and fifty entries called "recording" is not a list.
 */
export const CLIP_RELEASE_TAG = 'workpulse-recordings'

export function clipSize(bytes: number): string {
	const mb = bytes / 1_000_000
	return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1000)} KB`
}

/** Is this worth keeping, or did the recorder hand back something broken? */
export function clipUsable(c: { ms: number; bytes: number }): boolean {
	return c.ms >= 500 && c.bytes > 1000 && c.bytes <= MAX_BYTES
}

/**
 * Which clips to keep locally.
 *
 * Far fewer than screenshots, because each one is twenty times the size. The
 * newest few, and anything attached to a note that has been shared — somebody
 * else is relying on that one.
 */
export const KEEP_CLIPS = 8

export function clipsToKeep<T extends { clip?: { id: string }; shared?: unknown; at: number }>(notes: T[]): string[] {
	const withClips = notes.filter((n) => n.clip).sort((a, b) => b.at - a.at)
	const keep = new Set<string>()
	for (const n of withClips.filter((n) => n.shared)) keep.add(n.clip!.id)
	for (const n of withClips) {
		if (keep.size >= KEEP_CLIPS) break
		keep.add(n.clip!.id)
	}
	return [...keep]
}

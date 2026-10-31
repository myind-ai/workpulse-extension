#!/usr/bin/env node
// UserPromptSubmit hook: when a message contains a video link, tell Claude to use the
// youtube-learning skill, so sharing a link is enough. Prints nothing for any other message.
// Never blocks the prompt: any error exits 0 silently.

const YT = /https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?[^\s)>\]]*v=|shorts\/|live\/|playlist\?[^\s)>\]]*list=)|youtu\.be\/)[^\s)>\]]+/gi

// Only links to one video or post; profile and channel pages are not a request to save.
const OTHER = /https?:\/\/(?:[a-z]+\.)?(?:instagram\.com\/(?:[\w.]+\/|share\/)?(?:reels?|p|tv)\/|tiktok\.com\/(?:@[\w.-]+\/video\/|t\/)|(?:vm|vt)\.tiktok\.com\/|vimeo\.com\/\d|(?:x|twitter)\.com\/\w+\/status\/|facebook\.com\/(?:reel\/|watch|share\/[vr]\/|[\w.]+\/videos\/)|fb\.watch\/|linkedin\.com\/(?:posts\/|feed\/update\/)|loom\.com\/share\/|dailymotion\.com\/video\/)[^\s)>\]]*/gi

export function videoLinks(text) {
	const s = String(text ?? '')
	return [...new Set([...(s.match(YT) ?? []), ...(s.match(OTHER) ?? [])])]
}

export function nudge(prompt) {
	const links = videoLinks(prompt)
	if (!links.length) return null
	return {
		hookSpecificOutput: {
			hookEventName: 'UserPromptSubmit',
			additionalContext:
				`The user shared ${links.length === 1 ? 'a video link' : `${links.length} video links`}: ${links.join(' ')}. ` +
				'If it holds a video, and unless they clearly asked for something else about it, use the youtube-learning skill: ' +
				'fetch it (video, subtitles, transcript, metadata), write notes.md from the transcript, ' +
				'and record the takeaways in the Brain.',
		},
	}
}

async function main() {
	let raw = ''
	for await (const chunk of process.stdin) raw += chunk
	const out = nudge(JSON.parse(raw || '{}').prompt)
	if (out) process.stdout.write(JSON.stringify(out))
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(() => process.exit(0))

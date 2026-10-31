// node --test plugins/youtube-learning/scripts/yt-nudge.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { videoLinks, nudge } from './yt-nudge.mjs'

const HOOK = fileURLToPath(new URL('./yt-nudge.mjs', import.meta.url))

test('finds every kind of YouTube link, once each', () => {
	const text = `see https://www.youtube.com/watch?v=x7X9w_GIm1s&t=30s and (https://youtu.be/abc123)
		https://youtube.com/shorts/s1 https://m.youtube.com/watch?feature=share&v=m1
		https://www.youtube.com/playlist?list=PL1 https://youtu.be/abc123`
	assert.deepEqual(videoLinks(text), [
		'https://www.youtube.com/watch?v=x7X9w_GIm1s&t=30s',
		'https://youtu.be/abc123',
		'https://youtube.com/shorts/s1',
		'https://m.youtube.com/watch?feature=share&v=m1',
		'https://www.youtube.com/playlist?list=PL1',
	])
})

test('finds single videos on other platforms', () => {
	const links = [
		'https://www.instagram.com/reel/CDUMkliABpa/',
		'https://www.instagram.com/reels/CDUMkliABpa/?igsh=abc',
		'https://www.instagram.com/p/BQ0eAlwhDrw/',
		'https://www.instagram.com/someone/reel/CDUMkliABpa/',
		'https://www.instagram.com/share/reel/BAabc/',
		'https://www.tiktok.com/@a.b/video/674',
		'https://vm.tiktok.com/ZM123/',
		'https://vimeo.com/76979871',
		'https://x.com/a/status/158',
		'https://www.facebook.com/reel/123',
		'https://fb.watch/abc/',
		'https://www.linkedin.com/posts/a-b_c-activity-1',
		'https://www.loom.com/share/43d05',
		'https://www.dailymotion.com/video/x5k',
	]
	assert.deepEqual(videoLinks(links.join(' ')), links)
})

test('ignores other links, channel and profile pages', () => {
	assert.equal(nudge('read https://github.com/x and https://www.youtube.com/@fireship'), null)
	assert.equal(nudge('https://www.instagram.com/someone/ https://www.tiktok.com/@someone https://x.com/someone https://vimeo.com/channels/x'), null)
	assert.equal(nudge(undefined), null)
})

test('the hook prints context for a link and nothing otherwise', () => {
	const run = (prompt) => execFileSync('node', [HOOK], { input: JSON.stringify({ prompt }) }).toString()
	const out = JSON.parse(run('learn this https://youtu.be/abc123'))
	assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
	assert.match(out.hookSpecificOutput.additionalContext, /youtube-learning skill/)
	assert.equal(run('no links here'), '')
	assert.equal(execFileSync('node', [HOOK], { input: 'not json' }).toString(), '')
})

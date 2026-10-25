// node --test cli/setup.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { placeHook, placeRule, removeHook, ruleText } from './setup.mjs'

test('a hook is added beside the others, and replaced rather than doubled on a re-run', () => {
	const s = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook' }] }], Stop: [{ hooks: [{ type: 'command', command: 'other-stop' }] }] } }
	placeHook(s, 'Stop', 'node /a/wp-brain.mjs stop-check', 'wp-brain.mjs stop-check')
	placeHook(s, 'Stop', 'node /b/wp-brain.mjs stop-check', 'wp-brain.mjs stop-check')
	const stops = s.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command))
	assert.deepEqual(stops, ['other-stop', 'node /b/wp-brain.mjs stop-check'])
	assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'rtk hook')
})

test('answering no removes only our hook, and the event when nothing is left', () => {
	const s = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node x/wp-brain.mjs hook' }] }] } }
	removeHook(s, 'SessionStart', 'wp-brain.mjs hook')
	assert.equal(s.hooks.SessionStart, undefined)
})

test('the rule replaces its marked block, or a hand-written section of the same name, and is never doubled', () => {
	const rule = ruleText({ repo: 'me/notes', branch: 'brain', cli: '/x/wp-brain.mjs' })
	assert.match(rule, /branch \*\*`brain`\*\* of the private repo \*\*`me\/notes`\*\*/)
	const hand = '# Rules\n\n## A\nkeep\n\n## WorkPulse Brain — old\nold text\n\n## Z\nkeep z\n'
	const once = placeRule(hand, rule)
	assert.ok(once.includes('keep\n') && once.includes('## Z\nkeep z'))
	assert.ok(!once.includes('old text'))
	const twice = placeRule(once, ruleText({ repo: 'me/notes', branch: '', cli: '/x/wp-brain.mjs' }))
	assert.equal(twice.split('workpulse-brain:start').length - 1, 1)
	assert.match(twice, /the private repo \*\*`me\/notes`\*\*/)
	assert.match(placeRule('# Only\n', rule), /# Only\n\n<!-- workpulse-brain:start -->/)
})

// node --test cli/graph.test.mjs
// `wp-brain graph` against a temp repo and a temp config. Never the real Brain.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { brainSandbox } from './sandbox.mjs'

function sandbox() {
	const s = brainSandbox()
	const add = (...a) => {
		const r = s.run('add', ...a, '--no-push')
		assert.equal(r.status, 0, r.err)
		return r.out.match(/\[([a-z0-9]{8})\]/i)?.[1]
	}
	const a = add('learning', 'Webhook retry needs a fresh idempotency key', '--ticket', 'PAY-1', '--tags', 'retry,webhook', '--project', 'payments', '--body', 'zebra-secret-body-text')
	const b = add('mistake', 'Retry loop ignored the backoff', '--ticket', 'PAY-1', '--tags', 'retry')
	const c = add('learning', 'Cache headers on the CDN', '--tags', 'retry', '--source-type', 'youtube', '--source-url', 'https://www.youtube.com/watch?v=abc&t=5s')
	return { ...s, a, b, c }
}

test('graph #retry lists its lessons with [shortId]', () => {
	const s = sandbox()
	const r = s.run('graph', '#retry')
	assert.equal(r.status, 0, r.err)
	for (const id of [s.a, s.b, s.c]) assert.match(r.out, new RegExp(`\\[${id}\\]`))
	assert.match(r.out, /tag: retry/)
})

test('graph PAY-1 finds the ticket and its lessons', () => {
	const s = sandbox()
	const r = s.run('graph', 'PAY-1')
	assert.equal(r.status, 0, r.err)
	assert.match(r.out, /ticket: PAY-1/)
	assert.match(r.out, new RegExp(`\\[${s.a}\\]`))
	assert.doesNotMatch(r.out, new RegExp(`\\[${s.c}\\]`))
})

test('graph <shortId> lists hubs grouped by kind', () => {
	const s = sandbox()
	const r = s.run('graph', s.a)
	assert.equal(r.status, 0, r.err)
	assert.match(r.out, /project \(1\):\n {2}project: payments/)
	assert.match(r.out, /ticket \(1\):\n {2}ticket: PAY-1/)
	assert.match(r.out, /tag \(2\):/)
})

test('graph "webhook retry" falls back to search and names the lesson it took', () => {
	const s = sandbox()
	const r = s.run('graph', 'webhook retry')
	assert.equal(r.status, 0, r.err)
	assert.match(r.out, /took the closest lesson/)
	assert.match(r.out, new RegExp(`\\[${s.a}\\]`))
})

test('a name matching several nodes lists the choices; none exits non-zero with a hint', () => {
	const s = sandbox()
	s.run('add', 'learning', 'Payments notes', '--ticket', 'payments', '--no-push')
	const many = s.run('graph', 'payments')
	assert.equal(many.status, 0, many.err)
	assert.match(many.out, /matches 2 nodes; ask for one/)
	const none = s.run('graph', 'zzzzqqqq')
	assert.notEqual(none.status, 0)
	assert.match(none.err, /Nothing in the graph matches/)
})

test('--limit 2 prints "… and N more"', () => {
	const s = sandbox()
	const r = s.run('graph', '#retry', '--limit', '2')
	assert.match(r.out, /… and 1 more/)
})

test('--json parses and has no body text', () => {
	const s = sandbox()
	const r = s.run('graph', 'PAY-1', '--json')
	assert.equal(r.status, 0, r.err)
	const j = JSON.parse(r.out)
	assert.equal(j.node.id, 'ticket:PAY-1')
	assert.equal(j.graph.version, 3)
	assert.doesNotMatch(r.out, /zebra-secret-body-text/)
	assert.doesNotMatch(s.run('graph', '--json').out, /zebra-secret-body-text/)
})

test('no argument prints counts per node type and the most connected hubs', () => {
	const s = sandbox()
	const r = s.run('graph')
	assert.equal(r.status, 0, r.err)
	assert.match(r.out, /3 lessons, 1 source, 1 project, 1 ticket, 2 tags/)
	assert.match(r.out, /Most connected:\n {2}tag: retry {2}\(3 lessons\)/)
})

test('--type narrows what is shown', () => {
	const s = sandbox()
	const r = s.run('graph', s.a, '--type', 'ticket')
	assert.doesNotMatch(r.out, /tag \(/)
	assert.match(r.out, /ticket \(1\)/)
})

test('index writes graph.json version 3 beside the clone', () => {
	const s = sandbox()
	const r = s.run('index', '--no-push')
	assert.equal(r.status, 0, r.err)
	const g = JSON.parse(readFileSync(join(`${s.clone}-index`, 'graph.json'), 'utf8'))
	assert.equal(g.version, 3)
	assert.ok(g.nodes.some((n) => n.id === 'tag:retry'))
})

test('--type filters what is shown, not the walk', () => {
	const s = sandbox()
	const lessons = s.run('graph', 'PAY-1', '--type', 'lesson')
	assert.equal(lessons.status, 0, lessons.err)
	assert.match(lessons.out, /ticket: PAY-1 {2}- 2 connections/)
	assert.match(lessons.out, new RegExp(`\\[${s.a}\\]`))
	assert.match(lessons.out, new RegExp(`\\[${s.b}\\]`))

	const tags = s.run('graph', 'PAY-1', '--depth', '2', '--type', 'tag')
	assert.equal(tags.status, 0, tags.err)
	assert.doesNotMatch(tags.out, /- 0 connections/)
	assert.match(tags.out, /Two steps away \(2\):/)
	assert.match(tags.out, /tag: retry/)
	assert.match(tags.out, /tag: webhook/)
	assert.doesNotMatch(tags.out, new RegExp(`\\[${s.a}\\]`), 'lessons were walked through, not shown')
	assert.doesNotMatch(tags.out, /project: /)

	const json = JSON.parse(s.run('graph', 'PAY-1', '--depth', '2', '--type', 'tag', '--json').out)
	assert.deepEqual(json.graph.nodes.map((n) => n.id).sort(), ['tag:retry', 'tag:webhook', 'ticket:PAY-1'])
	assert.equal(json.distance['tag:retry'], 2)
})

test('--type with nothing of that type near says 0, and --depth 2 counts what it lists', () => {
	const s = sandbox()
	assert.match(s.run('graph', 'PAY-1', '--type', 'source').out, /ticket: PAY-1 {2}- 0 connections/)
	assert.match(s.run('graph', 'PAY-1', '--depth', '2').out, /ticket: PAY-1 {2}- [3-9] connections/)
})

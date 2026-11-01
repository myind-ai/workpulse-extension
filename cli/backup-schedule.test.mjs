// node --test cli/backup-schedule.test.mjs
// A stub launchctl and a temp LaunchAgents folder. The real launchctl is never reached: launchctl() refuses without the seam, and a test proves it.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { LABEL, plistText } from './backup-schedule.mjs'
import { brainSandbox } from './sandbox.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'wp-brain.mjs')

/** A sandbox with a stub launchctl that notes its arguments and exits with `code`. */
function box(t, { code = 0 } = {}) {
	const sb = brainSandbox()
	t.after(() => rmSync(sb.root, { recursive: true, force: true }))
	const calls = join(sb.root, 'launchctl-calls')
	const stub = join(sb.root, 'launchctl-stub')
	const codeFile = join(sb.root, 'launchctl-code')
	writeFileSync(codeFile, String(code))
	writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${calls}"\nexit $(cat "${codeFile}")\n`)
	chmodSync(stub, 0o755)
	const agents = join(sb.root, 'agents')
	const env = { WP_LAUNCH_AGENTS_DIR: agents, WP_LAUNCHCTL: stub, WP_BACKUP_STATUS: join(sb.root, 'state', 'backup-status.json') }
	const plist = join(agents, `${LABEL}.plist`)
	const seen = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [])
	return { sb, env, calls, plist, seen, codeFile, run: (...a) => sb.runWith(env, ...a) }
}

test('schedule on writes a low-priority daily plist with the node and CLI paths, through the seam only', (t) => {
	const b = box(t)
	const r = b.run('backup', 'schedule', 'on')
	assert.equal(r.status, 0, r.err)
	const text = readFileSync(b.plist, 'utf8')
	assert.ok(text.includes(`<string>${process.execPath}</string>`))
	assert.ok(text.includes(`<string>${CLI}</string>`))
	assert.ok(text.includes('<string>backup-all</string>'))
	assert.ok(text.includes('<string>--scheduled</string>'), 'its log holds numbers only')
	assert.match(text, /<key>StartCalendarInterval<\/key>/)
	assert.doesNotMatch(text, /StartInterval|RunAtLoad|KeepAlive|WatchPaths/)
	assert.match(text, /<key>ProcessType<\/key>\s*<string>Background<\/string>/)
	assert.match(text, /<key>Nice<\/key>\s*<integer>10<\/integer>/)
	assert.match(text, /<key>PATH<\/key>\s*<string>[^<]*\/opt\/homebrew\/bin/)
	const uid = process.getuid()
	assert.deepEqual(b.seen(), [`bootout gui/${uid}/${LABEL}`, `bootstrap gui/${uid} ${b.plist}`])
	const log = join(b.sb.root, 'state', 'backup-all.log')
	assert.equal(statSync(log).mode & 0o777, 0o600)
	assert.ok(JSON.parse(readFileSync(b.env.WP_BACKUP_STATUS, 'utf8')).scheduleOnAt > 0)
})

test('schedule off removes it; off again is fine; the backup record stays', (t) => {
	const b = box(t)
	b.run('backup', 'schedule', 'on')
	writeFileSync(b.calls, '')
	const off = b.run('backup', 'schedule', 'off')
	assert.equal(off.status, 0, off.err)
	assert.equal(existsSync(b.plist), false)
	assert.deepEqual(b.seen(), [`bootout gui/${process.getuid()}/${LABEL}`])
	assert.equal(JSON.parse(readFileSync(b.env.WP_BACKUP_STATUS, 'utf8')).scheduleOnAt, undefined)
	writeFileSync(b.calls, '')
	writeFileSync(b.codeFile, '113') // launchctl's "could not find service"
	const again = b.run('backup', 'schedule', 'off')
	assert.equal(again.status, 0)
	assert.match(again.out, /was not on/)
})

test('schedule off unloads a job whose plist was deleted by hand, and says when launchctl fails', (t) => {
	const b = box(t)
	b.run('backup', 'schedule', 'on')
	rmSync(b.plist)
	const off = b.run('backup', 'schedule', 'off')
	assert.equal(off.status, 0, off.err)
	assert.match(off.out, /Daily backup off/, 'it was still loaded')
	assert.ok(b.seen().at(-1).startsWith('bootout '))

	b.run('backup', 'schedule', 'on')
	writeFileSync(b.codeFile, '5')
	const bad = b.run('backup', 'schedule', 'off')
	assert.equal(bad.status, 1)
	assert.match(bad.err, /could not unload/)
	assert.equal(existsSync(b.plist), false)
})

test('without the launchctl seam the real one is refused while the folder is a test\'s', (t) => {
	const b = box(t)
	const r = b.sb.runWith({ ...b.env, WP_LAUNCHCTL: '' }, 'backup', 'schedule', 'on')
	assert.equal(r.status, 1)
	assert.match(r.err, /real launchctl was not called/)
	assert.deepEqual(b.seen(), [])
})

test('a launchctl that refuses leaves no plist', (t) => {
	const b = box(t, { code: 3 })
	const r = b.run('backup', 'schedule', 'on')
	assert.equal(r.status, 1)
	assert.match(r.err, /stays off/)
	assert.equal(existsSync(b.plist), false)
})

test('backup schedule refuses anything else', (t) => {
	const b = box(t)
	assert.equal(b.run('backup', 'schedule').status, 1)
	assert.equal(b.run('backup', 'nonsense').status, 1)
})

test('plist text: paths are escaped, and the tool path finds what launchd\'s bare one would not', () => {
	const text = plistText({ node: '/a&b/node', cli: '/c<d>/wp-brain.mjs', log: '/l.log', env: { PATH: '/x:/y' } })
	assert.ok(text.includes('<string>/a&amp;b/node</string>'))
	assert.ok(text.includes('<string>/c&lt;d&gt;/wp-brain.mjs</string>'))
})

test('doctor and backup status show the schedule, and a moved CLI or node', (t) => {
	const b = box(t)
	assert.match(b.run('backup', 'status').out, /Schedule: off/)
	assert.match(b.run('doctor').out, /Backup schedule +off/)
	b.run('backup', 'schedule', 'on')
	assert.match(b.run('backup', 'status').out, /Schedule: on, daily/)
	assert.match(b.run('doctor').out, /✓ Backup schedule +on, daily/)
	writeFileSync(b.plist, readFileSync(b.plist, 'utf8').replace(`<string>${CLI}</string>`, '<string>/gone/wp-brain.mjs</string>'))
	const doctor = b.run('doctor').out
	assert.match(doctor, /! Backup schedule +on, but it points at \/gone\/wp-brain\.mjs, which does not exist/)
	assert.match(b.run('backup', 'status').out, /Schedule: on, but it points/)
	mkdirSync(join(b.sb.root, 'other'))
	writeFileSync(join(b.sb.root, 'other', 'wp-brain.mjs'), '')
	writeFileSync(b.plist, readFileSync(b.plist, 'utf8').replace('/gone/wp-brain.mjs', join(b.sb.root, 'other', 'wp-brain.mjs')))
	assert.match(b.run('doctor').out, /! Backup schedule +on, but it points at another copy/)
})

test('setup: default no installs nothing and calls nothing; yes installs; a re-run keeps it; no removes it', (t) => {
	const b = box(t)
	const args = ['--repo', 'test/brain', '--no-push', '--clone', b.sb.clone]
	const off = b.run('setup', '--defaults', ...args)
	assert.equal(off.status, 0, off.err)
	assert.equal(existsSync(b.plist), false)
	assert.deepEqual(b.seen(), [])
	assert.match(off.out, /Daily backup: off/)
	const on = b.run('setup', '--defaults', '--schedule', 'yes', ...args)
	assert.equal(on.status, 0, on.err)
	assert.ok(existsSync(b.plist))
	assert.match(on.out, /Daily backup: on/)
	assert.equal(b.run('setup', '--defaults', ...args).status, 0)
	assert.ok(existsSync(b.plist), 'a re-run with the defaults keeps it')
	assert.equal(b.run('setup', '--defaults', '--schedule', 'no', ...args).status, 0)
	assert.equal(existsSync(b.plist), false)
})

test('setup: a launchctl that refuses is said and does not stop setup', (t) => {
	const b = box(t, { code: 3 })
	const r = b.run('setup', '--defaults', '--schedule', 'yes', '--repo', 'test/brain', '--no-push', '--clone', b.sb.clone)
	assert.equal(r.status, 0, r.err)
	assert.match(r.out, /stays off/)
	assert.match(r.out, /Claude Code is linked/)
})

// node --test cli/rules.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { instructionFiles } from './budget.mjs'
import { configFilesIn } from './library.mjs'
import { claudeFixture, linkedSkill, skillText } from './fixtures.mjs'
import { applyRules, inflect, loadDocs, matchDocs, pointersFor, rollbackRules, sectionsOf, splitRules, verifyReport, verifyRules, writeTestPass } from './rules.mjs'
import { brainSandbox, CLI } from './sandbox.mjs'
import { placeRuleIn, ruleState } from './setup.mjs'

const sha = (t) => createHash('sha256').update(t).digest('hex')

/** A fixture CLAUDE.md with fences, a longer fence holding a shorter one, ### parts and a heading with no rule. */
const FIX = [
	'# Title',
	'',
	'Intro line.',
	'',
	'## Alpha rule',
	'alpha 1',
	'```md',
	'# not a heading',
	'## nor this',
	'```',
	'',
	'### Alpha part one',
	'a1',
	'',
	'### Alpha part two',
	'a2',
	'',
	'## Beta rule',
	'b1',
	'````md',
	'```',
	'# still inside the long fence',
	'```',
	'## and this',
	'````',
	'b2',
	'',
	'## Gamma rule',
	'g1',
	'g1',
	'',
	'## Delta rule',
	'd1',
	'',
].join('\n')

const MAP = {
	rules: [
		{ slug: 'core-bits', from: ['Title'], load: 'always', triggers: [] },
		{ slug: 'alpha', from: ['Alpha rule > Alpha part one', 'Alpha rule'], load: 'file', triggers: ['alpha words'], title: 'Alpha' },
		{ slug: 'alpha-two', from: ['Alpha rule > Alpha part two'], load: 'file', triggers: ['two'], title: 'Alpha two' },
		{ slug: 'beta', from: ['Beta rule'], load: 'path', paths: ['**/*.dart', 'pubspec.yaml'], triggers: ['flutter'], title: 'Beta' },
		{ slug: 'gamma', from: ['Gamma rule'], load: 'file', triggers: ['gamma'], title: 'Gamma' },
		{ slug: 'delta', from: ['Delta rule'], load: 'always', triggers: [] },
	],
}

function setup(text = FIX, map = MAP) {
	const root = mkdtempSync(join(tmpdir(), 'wp-rules-'))
	const claude = join(root, '.claude')
	mkdirSync(claude)
	writeFileSync(join(claude, 'CLAUDE.md'), text)
	const mapPath = join(root, 'map.json')
	writeFileSync(mapPath, JSON.stringify(map))
	return { root, claude, mapPath, dir: join(claude, 'rule-split') }
}

function staged(text, map) {
	const s = setup(text, map)
	const out = splitRules({ claude: s.claude, mapPath: s.mapPath, out: s.dir })
	return { ...s, out }
}

test('sectionsOf starts no section inside a fence, a longer fence holding a shorter one, or at ### and deeper', () => {
	const top = sectionsOf(FIX)
	assert.deepEqual(top.map((s) => [s.level, s.heading]), [[1, 'Title'], [2, 'Alpha rule'], [2, 'Beta rule'], [2, 'Gamma rule'], [2, 'Delta rule']])
	assert.equal(top.map((s) => s.text).join(''), FIX)
	assert.deepEqual(top[1].sub.map((s) => s.heading), ['Alpha part one', 'Alpha part two'])
	assert.ok(top[1].text.includes('# not a heading') && top[2].text.includes('## and this'))
	assert.equal(top[2].sub.length, 0)
	assert.equal(top[1].sub.map((s) => s.text).join(''), top[1].text.slice(top[1].text.indexOf('### Alpha part one')))
})

test('sectionsOf keeps a preamble, tilde fences and a missing final newline byte for byte', () => {
	const odd = 'before\n\n~~~\n# in tilde\n~~~\n## Real\nx\r\n### Sub\r\ny'
	const s = sectionsOf(odd)
	assert.deepEqual(s.map((x) => x.heading), ['', 'Real'])
	assert.equal(s.map((x) => x.text).join(''), odd)
	assert.equal(sectionsOf('').length, 0)
})

test('split stops on a section the map does not name, and names it', () => {
	const s = setup(FIX + '\n## Brand new\nnew line\n')
	assert.throws(() => splitRules({ claude: s.claude, mapPath: s.mapPath, out: s.dir }), /Brand new/)
	assert.ok(!existsSync(s.dir), 'nothing is staged')
})

test('split stops when a heading is mapped twice, when the map names a heading that is not there, and on duplicate headings in the file', () => {
	const twice = { rules: [...MAP.rules, { slug: 'again', from: ['Gamma rule'], load: 'file', triggers: ['g'], title: 'G' }] }
	const a = setup(FIX, twice)
	assert.throws(() => splitRules({ claude: a.claude, mapPath: a.mapPath, out: a.dir }), /Gamma rule.*gamma.*again|Gamma rule.*twice/s)
	const ghost = { rules: [...MAP.rules, { slug: 'ghost', from: ['No such heading'], load: 'file', triggers: ['g'], title: 'G' }] }
	const b = setup(FIX, ghost)
	assert.throws(() => splitRules({ claude: b.claude, mapPath: b.mapPath, out: b.dir }), /No such heading/)
	const c = setup(FIX + '\n## Gamma rule\nsecond\n')
	assert.throws(() => splitRules({ claude: c.claude, mapPath: c.mapPath, out: c.dir }), /Gamma rule.*(twice|2 times)/s)
	const sub = { rules: MAP.rules.filter((r) => r.slug !== 'alpha-two') } // a sub-part left out once parts are named
	const d = setup(FIX, sub)
	assert.throws(() => splitRules({ claude: d.claude, mapPath: d.mapPath, out: d.dir }), /Alpha part two/)
})

test('a bad map stops split: unknown load, a path rule with no paths, a duplicate slug, a slug that backup would skip', () => {
	const bad = (rule, re) => {
		const s = setup(FIX, { rules: [...MAP.rules.filter((r) => r.slug !== 'gamma'), rule] })
		assert.throws(() => splitRules({ claude: s.claude, mapPath: s.mapPath, out: s.dir }), re)
	}
	bad({ slug: 'gamma', from: ['Gamma rule'], load: 'sometimes', triggers: ['g'], title: 'G' }, /load/)
	bad({ slug: 'gamma', from: ['Gamma rule'], load: 'path', triggers: ['g'], title: 'G' }, /paths/)
	bad({ slug: 'alpha', from: ['Gamma rule'], load: 'file', triggers: ['g'], title: 'G' }, /alpha.*(twice|more than once|duplicate)/i)
	bad({ slug: 'secret-rule', from: ['Gamma rule'], load: 'file', triggers: ['g'], title: 'G' }, /secret-rule.*(backup|skip)/i)
	bad({ slug: '../up', from: ['Gamma rule'], load: 'file', triggers: ['g'], title: 'G' }, /slug/)
})

test('load: file bodies are byte-identical to the source, in the order of from', () => {
	const t = staged()
	const top = sectionsOf(FIX)
	const alpha = top[1]
	const body = readFileSync(join(t.dir, 'rule-files', 'alpha.md'), 'utf8')
	assert.equal(body, alpha.sub[0].text + alpha.text.slice(0, alpha.text.indexOf('### Alpha part one')))
	assert.equal(readFileSync(join(t.dir, 'rule-files', 'gamma.md'), 'utf8'), top[3].text)
	assert.equal(readFileSync(join(t.dir, 'rule-files', 'alpha-two.md'), 'utf8'), alpha.sub[1].text)
	assert.equal(readFileSync(join(t.dir, 'old.md'), 'utf8'), FIX)
	assert.equal(readFileSync(join(t.dir, 'old-sha256'), 'utf8').trim(), sha(FIX))
})

test('load: always stays word for word in the core, in file order; file rules get one pointer line each', () => {
	const t = staged()
	const core = readFileSync(join(t.dir, 'CLAUDE.md'), 'utf8')
	const top = sectionsOf(FIX)
	assert.ok(core.startsWith(top[0].text + top[4].text))
	assert.match(core, /rule-files\/alpha\.md/)
	assert.match(core, /rule-files\/gamma\.md/)
	assert.ok(!core.includes('g1'), 'the moved text is not in the core')
})

test('verify passes on a fresh split and reports what was added to the core and the core tokens', () => {
	const t = staged()
	const v = verifyRules({ dir: t.dir })
	assert.equal(v.ok, true, JSON.stringify(v))
	assert.deepEqual(v.lost, [])
	assert.ok(v.added.length >= 3 && v.added.some((l) => l.includes('rule-files/alpha.md')))
	assert.ok(v.coreTokens > 0)
	assert.match(t.out.summary, /tokens/)
})

test('verify fails when one line in a rule file is changed or removed, or a count drops, or a file is gone', () => {
	const change = (rel, fn) => {
		const t = staged()
		const f = join(t.dir, rel)
		writeFileSync(f, fn(readFileSync(f, 'utf8')))
		return verifyRules({ dir: t.dir })
	}
	const changed = change('rule-files/gamma.md', (x) => x.replace('g1\n', 'G1\n'))
	assert.equal(changed.ok, false)
	assert.equal(changed.lost.length, 1) // one of the two "g1" lines is gone; the other is still there
	assert.equal(changed.lost[0].line, 'g1')
	const removed = change('rules/beta.md', (x) => x.replace('b1\n', ''))
	assert.equal(removed.ok, false)
	assert.deepEqual(removed.lost.map((l) => l.line), ['b1'])
	const core = change('CLAUDE.md', (x) => x.replace('d1\n', ''))
	assert.deepEqual(core.lost.map((l) => l.line), ['d1'])
	const t = staged()
	writeFileSync(join(t.dir, 'rule-files', 'gamma.md'), '')
	const gone = verifyRules({ dir: t.dir })
	assert.equal(gone.ok, false)
	assert.deepEqual(gone.lost.map((l) => l.line), ['## Gamma rule', 'g1'])
})

test('verify cannot be satisfied by frontmatter or pointer lines standing in for a lost line', () => {
	const t = staged()
	const f = join(t.dir, 'rules', 'beta.md')
	writeFileSync(f, readFileSync(f, 'utf8').replace('b2\n', '---\n'))
	const v = verifyRules({ dir: t.dir })
	assert.equal(v.ok, false)
	assert.deepEqual(v.lost.map((l) => l.line), ['b2'])
})

test('verify fails when the staged old copy does not match its hash, or the folder is not a split', () => {
	const t = staged()
	writeFileSync(join(t.dir, 'old.md'), FIX + 'x\n')
	assert.equal(verifyRules({ dir: t.dir }).ok, false)
	assert.throws(() => verifyRules({ dir: join(t.root, 'nothing') }), /rules split/)
})

test('load: path files start with paths frontmatter that parses, and budget does not count them', () => {
	const t = staged()
	const text = readFileSync(join(t.dir, 'rules', 'beta.md'), 'utf8')
	assert.ok(text.startsWith('---\npaths:\n  - "**/*.dart"\n  - "pubspec.yaml"\n---\n'))
	assert.equal(text.slice(text.indexOf('---\n', 4) + 4), sectionsOf(FIX)[2].text)
	const home = join(t.root, 'budget-home')
	mkdirSync(join(home, 'rules'), { recursive: true })
	writeFileSync(join(home, 'rules', 'beta.md'), text)
	writeFileSync(join(home, 'rules', 'plain.md'), 'always loaded\n')
	const loaded = instructionFiles(home, join(t.root, 'cwd')).filter((f) => f.why === 'unscoped rule')
	assert.deepEqual(loaded.map((f) => f.path.split('/').pop()), ['plain.md'])
	assert.ok(!loaded.some((f) => f.broken))
})

test('every planned slug passes configFilesIn, so config backup keeps them', () => {
	const slugs = 'local-first deliverables issues-todo workpulse-brain jira-updates skill-evolution skills-catalogue tauri-sidecar flutter-patterns working-habits nextjs-server git-safety worktree-workflow commit-hygiene commit-cadence ci-green env-hygiene mobile-env-public promote-default changelog manual-todo features-md codegraph land-then-branch worklog deployed-truth platform-debug'.split(' ')
	assert.equal(slugs.length, 27)
	const root = mkdtempSync(join(tmpdir(), 'wp-rules-slugs-'))
	for (const d of ['rules', 'rule-files']) {
		mkdirSync(join(root, d))
		for (const s of slugs) writeFileSync(join(root, d, `${s}.md`), 'x\n')
	}
	writeFileSync(join(root, 'rule-files', 'rule-map.json'), '{}')
	const { keep, skipped } = configFilesIn(root)
	assert.deepEqual(skipped, [])
	for (const s of slugs) {
		assert.ok(keep.some((k) => k.rel === `rules/${s}.md`) && keep.some((k) => k.rel === `rule-files/${s}.md`), s)
	}
	assert.ok(keep.some((k) => k.rel === 'rule-files/rule-map.json'))
})

test('apply refuses without a pass marker for this split, without --yes, or when verify fails', () => {
	const t = staged()
	assert.throws(() => applyRules({ claude: t.claude, dir: t.dir, yes: true }), /rules test/)
	writeTestPass(t.dir)
	assert.throws(() => applyRules({ claude: t.claude, dir: t.dir, yes: false }), /--yes/)
	// a marker for another old file is not a pass
	writeFileSync(join(t.dir, 'test-pass.json'), JSON.stringify({ hash: sha('other'), at: 1 }))
	assert.throws(() => applyRules({ claude: t.claude, dir: t.dir, yes: true }), /rules test/)
	// changing the staged files after the pass voids it
	writeTestPass(t.dir)
	const f = join(t.dir, 'rule-files', 'gamma.md')
	writeFileSync(f, readFileSync(f, 'utf8') + 'extra\n')
	assert.throws(() => applyRules({ claude: t.claude, dir: t.dir, yes: true }), /rules test/)
	// and a line lost fails verify first
	writeFileSync(f, '')
	writeTestPass(t.dir)
	assert.throws(() => applyRules({ claude: t.claude, dir: t.dir, yes: true }), /verify/)
	assert.equal(readFileSync(join(t.claude, 'CLAUDE.md'), 'utf8'), FIX)
	assert.deepEqual(readdirSync(t.claude).sort(), ['CLAUDE.md', 'rule-split'])
})

test('apply when the old file changed since the split: nothing is written and the message names the change', () => {
	const t = staged()
	writeTestPass(t.dir)
	const edited = FIX.replace('d1\n', 'd1 edited\n') + 'a new last line\n'
	writeFileSync(join(t.claude, 'CLAUDE.md'), edited)
	assert.throws(() => applyRules({ claude: t.claude, dir: t.dir, yes: true }), (e) => {
		assert.match(e.message, /changed since the split/)
		assert.match(e.message, /\+ d1 edited/)
		assert.match(e.message, /\+ a new last line/)
		assert.match(e.message, /- d1/)
		return true
	})
	assert.equal(readFileSync(join(t.claude, 'CLAUDE.md'), 'utf8'), edited)
	assert.deepEqual(readdirSync(t.claude).sort(), ['CLAUDE.md', 'rule-split'])
})

test('apply writes the rule files first and the core last, keeps the old file, and rollback restores it exactly', () => {
	const t = staged()
	writeTestPass(t.dir)
	const r = applyRules({ claude: t.claude, dir: t.dir, yes: true, now: new Date(2026, 9, 31) })
	assert.match(r.backup, /CLAUDE\.md\.pre-split-2026-10-31$/)
	assert.equal(readFileSync(r.backup, 'utf8'), FIX)
	assert.equal(readFileSync(join(t.claude, 'CLAUDE.md'), 'utf8'), readFileSync(join(t.dir, 'CLAUDE.md'), 'utf8'))
	assert.equal(readFileSync(join(t.claude, 'rule-files', 'gamma.md'), 'utf8'), sectionsOf(FIX)[3].text)
	assert.ok(existsSync(join(t.claude, 'rules', 'beta.md')) && existsSync(join(t.claude, 'rule-files', 'rule-map.json')))

	const back = rollbackRules({ claude: t.claude, now: new Date(2026, 9, 31) })
	assert.equal(readFileSync(join(t.claude, 'CLAUDE.md'), 'utf8'), FIX)
	assert.ok(back.removed.length >= 4)
	assert.ok(!existsSync(join(t.claude, 'rules', 'beta.md')) && !existsSync(join(t.claude, 'rule-files', 'gamma.md')))
	assert.ok(!existsSync(join(t.claude, 'rules')) && !existsSync(join(t.claude, 'rule-files')), 'folders apply made are gone')
	assert.throws(() => rollbackRules({ claude: t.claude }), /nothing to roll back/i)
})

test('rollback keeps a CLAUDE.md edited after apply, and a rule file edited after apply', () => {
	const t = staged()
	writeTestPass(t.dir)
	applyRules({ claude: t.claude, dir: t.dir, yes: true, now: new Date(2026, 9, 31) })
	writeFileSync(join(t.claude, 'CLAUDE.md'), 'edited after the split\n')
	writeFileSync(join(t.claude, 'rule-files', 'gamma.md'), 'my own gamma\n')
	const back = rollbackRules({ claude: t.claude, now: new Date(2026, 9, 31) })
	assert.equal(readFileSync(join(t.claude, 'CLAUDE.md'), 'utf8'), FIX)
	assert.equal(readFileSync(join(t.claude, 'CLAUDE.md.pre-rollback-2026-10-31'), 'utf8'), 'edited after the split\n')
	assert.equal(readFileSync(join(t.claude, 'rule-files', 'gamma.md'), 'utf8'), 'my own gamma\n')
	assert.ok(back.kept.some((k) => k.includes('gamma.md')))
})

test('apply that fails before the last write leaves CLAUDE.md unchanged and no files behind', () => {
	const t = staged()
	writeTestPass(t.dir)
	writeFileSync(join(t.claude, 'rules'), 'a file where the rules folder should be')
	assert.throws(() => applyRules({ claude: t.claude, dir: t.dir, yes: true }), /before CLAUDE\.md was changed/)
	assert.equal(readFileSync(join(t.claude, 'CLAUDE.md'), 'utf8'), FIX)
	assert.deepEqual(readdirSync(t.claude).sort(), ['CLAUDE.md', 'rule-split', 'rules'])
	assert.throws(() => rollbackRules({ claude: t.claude }), /nothing to roll back/i)
})

test('apply refuses to overwrite a different rule file that is already there', () => {
	const t = staged()
	writeTestPass(t.dir)
	mkdirSync(join(t.claude, 'rule-files'))
	writeFileSync(join(t.claude, 'rule-files', 'gamma.md'), 'mine\n')
	assert.throws(() => applyRules({ claude: t.claude, dir: t.dir, yes: true }), /gamma\.md.*already/s)
	assert.equal(readFileSync(join(t.claude, 'rule-files', 'gamma.md'), 'utf8'), 'mine\n')
	assert.equal(readFileSync(join(t.claude, 'CLAUDE.md'), 'utf8'), FIX)
})

test('the split can be re-run into the same staging folder, and refuses a folder that holds something else', () => {
	const t = staged()
	writeTestPass(t.dir)
	splitRules({ claude: t.claude, mapPath: t.mapPath, out: t.dir })
	assert.ok(!existsSync(join(t.dir, 'test-pass.json')), 'a new split voids the old pass')
	const other = join(t.root, 'other')
	mkdirSync(other)
	writeFileSync(join(other, 'precious.txt'), 'keep')
	assert.throws(() => splitRules({ claude: t.claude, mapPath: t.mapPath, out: other }), /not empty/)
	assert.equal(readFileSync(join(other, 'precious.txt'), 'utf8'), 'keep')
})

test('wp-brain rules: split, verify, apply and rollback through the CLI, on a temp CLAUDE_HOME', () => {
	const s = setup()
	const env = { ...process.env, HOME: s.root, CLAUDE_HOME: s.claude, WP_BRAIN_CONFIG: join(s.root, 'no-brain.json') }
	const wp = (...a) => {
		const r = spawnSync('node', [CLI, 'rules', ...a], { encoding: 'utf8', env })
		return { status: r.status, out: r.stdout, err: r.stderr }
	}
	assert.equal(wp('split').status, 1) // --map is needed
	const sp = wp('split', '--map', s.mapPath)
	assert.equal(sp.status, 0, sp.err)
	assert.match(sp.out, /Lines lost: 0/)
	assert.equal(wp('verify').status, 0)
	assert.equal(wp('apply', '--yes').status, 1) // no pass marker yet
	writeTestPass(s.dir)
	const ap = wp('apply', '--yes')
	assert.equal(ap.status, 0, ap.err)
	assert.match(ap.out, /pre-split-/)
	assert.notEqual(readFileSync(join(s.claude, 'CLAUDE.md'), 'utf8'), FIX)
	assert.equal(wp('rollback').status, 0)
	assert.equal(readFileSync(join(s.claude, 'CLAUDE.md'), 'utf8'), FIX)
	const real = spawnSync('node', [CLI, 'rules', 'bogus'], { encoding: 'utf8', env })
	assert.equal(real.status, 1)
})

test('config backup and restore round-trip rules/ and rule-files/', () => {
	const { run, root } = brainSandbox({ config: { library: true } })
	const home = join(root, 'home')
	const claude = join(home, '.claude')
	mkdirSync(join(claude, 'rules'), { recursive: true })
	mkdirSync(join(claude, 'rule-files'), { recursive: true })
	writeFileSync(join(claude, 'CLAUDE.md'), '# core\n')
	writeFileSync(join(claude, 'rules', 'beta.md'), '---\npaths:\n  - "x"\n---\nbeta\n')
	writeFileSync(join(claude, 'rule-files', 'gamma.md'), 'gamma\n')
	writeFileSync(join(claude, 'rule-files', 'rule-map.json'), '{"rules":[]}\n')
	const b = run('config', 'backup', '--home', home)
	assert.equal(b.status, 0, b.err)
	assert.match(b.out, /kept 4 files, skipped 0/)
	const fresh = join(root, 'fresh')
	mkdirSync(join(fresh, '.claude'), { recursive: true })
	const r = run('config', 'restore', '--home', fresh)
	assert.equal(r.status, 0, r.err)
	for (const rel of ['rules/beta.md', 'rule-files/gamma.md', 'rule-files/rule-map.json']) {
		assert.equal(readFileSync(join(fresh, '.claude', rel), 'utf8'), readFileSync(join(claude, rel), 'utf8'), rel)
	}
	writeFileSync(join(fresh, '.claude', 'rule-files', 'gamma.md'), 'mine\n')
	run('config', 'restore', '--home', fresh)
	assert.equal(readFileSync(join(fresh, '.claude', 'rule-files', 'gamma.md'), 'utf8'), 'mine\n', 'an existing file is kept')
})

const BLOCK = '<!-- workpulse-brain:start -->\nOLD BRAIN RULE\n<!-- workpulse-brain:end -->\n'

test('placeRuleIn updates the marked block in rule-files/workpulse-brain.md and adds nothing to the core', () => {
	const root = mkdtempSync(join(tmpdir(), 'wp-rule-place-'))
	mkdirSync(join(root, 'rule-files'))
	writeFileSync(join(root, 'CLAUDE.md'), '# core\n')
	writeFileSync(join(root, 'rule-files', 'workpulse-brain.md'), `## WorkPulse Brain\nintro\n${BLOCK}tail\n`)
	const rule = '<!-- workpulse-brain:start -->\nNEW BRAIN RULE\n<!-- workpulse-brain:end -->'
	const r = placeRuleIn(root, rule)
	assert.equal(r.path, join(root, 'rule-files', 'workpulse-brain.md'))
	assert.equal(r.changed, true)
	assert.equal(readFileSync(r.path, 'utf8'), `## WorkPulse Brain\nintro\n${rule}\ntail\n`)
	assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), '# core\n')
	assert.equal(placeRuleIn(root, rule).changed, false)
	assert.equal(ruleState(root).ok, true)
	assert.match(ruleState(root).detail, /rule-files\/workpulse-brain\.md/)
})

test('placeRuleIn without that file, or with a file lacking the markers, behaves as before: the core gets the rule', () => {
	const root = mkdtempSync(join(tmpdir(), 'wp-rule-place-'))
	writeFileSync(join(root, 'CLAUDE.md'), '# core\n')
	const rule = '<!-- workpulse-brain:start -->\nNEW\n<!-- workpulse-brain:end -->'
	assert.equal(placeRuleIn(root, rule).path, join(root, 'CLAUDE.md'))
	assert.match(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), /# core\n\n<!-- workpulse-brain:start -->\nNEW/)
	mkdirSync(join(root, 'rule-files'))
	writeFileSync(join(root, 'rule-files', 'workpulse-brain.md'), 'no markers here\n')
	assert.equal(placeRuleIn(root, rule).path, join(root, 'CLAUDE.md'))
	assert.equal(readFileSync(join(root, 'rule-files', 'workpulse-brain.md'), 'utf8'), 'no markers here\n')
	assert.equal(ruleState(join(root, 'nothing')).ok, false)
})

test('doctor reports the Global rule as installed when rule-files/workpulse-brain.md holds the block', () => {
	const sb = brainSandbox()
	const claude = join(sb.root, '.claude')
	mkdirSync(join(claude, 'rule-files'), { recursive: true })
	writeFileSync(join(claude, 'CLAUDE.md'), '# core with no brain rule\n')
	writeFileSync(join(claude, 'rule-files', 'workpulse-brain.md'), BLOCK)
	const r = sb.runWith({ CLAUDE_HOME: claude }, 'doctor')
	assert.match(r.out, /✓ Global rule\s+installed.*rule-files\/workpulse-brain\.md/)
	writeFileSync(join(claude, 'rule-files', 'workpulse-brain.md'), 'x\n')
	assert.match(sb.runWith({ CLAUDE_HOME: claude }, 'doctor').out, /! Global rule\s+not in CLAUDE\.md/)
})

test('rules.mjs reaches only Node built-ins through every import, and nothing awaits an import at the top level', () => {
	const seen = new Set()
	const walk = (url) => {
		if (seen.has(url.href)) return
		seen.add(url.href)
		const src = readFileSync(url, 'utf8')
		assert.ok(!/^[^\s/].*\bawait\s+import\s*\(/m.test(src) && !/^await\s+import/m.test(src), `${url.pathname} awaits an import at the top level`)
		for (const m of src.matchAll(/^(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|^import\s*['"]([^'"]+)['"]/gm)) {
			const spec = m[1] ?? m[2]
			if (spec.startsWith('node:')) continue
			assert.ok(spec.startsWith('./'), `${url.pathname} imports ${spec}`)
			walk(new URL(spec, url))
		}
	}
	walk(new URL('./rules.mjs', import.meta.url))
	assert.ok([...seen].some((u) => u.endsWith('/budget.mjs')) && [...seen].some((u) => u.endsWith('/sensitive.mjs')))
	assert.ok(![...seen].some((u) => u.endsWith('/library.mjs')))
})

/** CLAUDE.md as the real one is shaped: the Brain block's start marker sits directly above the heading, in the section before. */
const BRAIN_FIX = [
	'# Rules',
	'',
	'## Issues file',
	'issue text',
	'',
	'<!-- workpulse-brain:start -->',
	'## WorkPulse Brain — Record',
	'old brain text',
	'<!-- workpulse-brain:end -->',
	'## Jira updates',
	'jira text',
	'',
].join('\n')
const BRAIN_MAP = {
	rules: [
		{ slug: 'core', from: ['Rules', 'Jira updates'], load: 'always', triggers: [] },
		{ slug: 'issues-todo', from: ['Issues file'], load: 'file', triggers: ['bug'], title: 'Issues' },
		{ slug: 'workpulse-brain', from: ['WorkPulse Brain — Record'], load: 'file', triggers: ['ticket'], title: 'Brain' },
	],
}

test('a comment line directly above a heading starts that heading\'s section, and the text still round-trips', () => {
	const top = sectionsOf(BRAIN_FIX)
	assert.equal(top.map((x) => x.text).join(''), BRAIN_FIX)
	assert.ok(top[2].text.startsWith('<!-- workpulse-brain:start -->\n## WorkPulse Brain'))
	assert.ok(!top[1].text.includes('workpulse-brain:start'))
	const odd = '## A\nx\n<!-- note -->\n\ntext\n<!-- end -->\n'
	assert.equal(sectionsOf(odd).length, 1) // a comment not directly above a heading is just text
	assert.equal(sectionsOf('## A\n<!-- c -->\n### B\nb\n')[0].sub[0].text, '<!-- c -->\n### B\nb\n')
	assert.equal(sectionsOf('```\n<!-- c -->\n```\n## A\n').map((x) => x.text).join(''), '```\n<!-- c -->\n```\n## A\n')
})

test('the real shape of the Brain block: after split and apply, setup still updates it in rule-files and the core gets nothing', () => {
	const t = staged(BRAIN_FIX, BRAIN_MAP)
	const body = readFileSync(join(t.dir, 'rule-files', 'workpulse-brain.md'), 'utf8')
	assert.ok(body.includes('workpulse-brain:start') && body.includes('workpulse-brain:end'))
	assert.ok(!readFileSync(join(t.dir, 'rule-files', 'issues-todo.md'), 'utf8').includes('workpulse-brain'))
	writeTestPass(t.dir)
	applyRules({ claude: t.claude, dir: t.dir, yes: true })
	const core = readFileSync(join(t.claude, 'CLAUDE.md'), 'utf8')
	assert.equal(ruleState(t.claude).ok, true)
	assert.match(ruleState(t.claude).detail, /rule-files\/workpulse-brain\.md/)
	const rule = '<!-- workpulse-brain:start -->\n## WorkPulse Brain — new\nnew brain text\n<!-- workpulse-brain:end -->'
	const placed = placeRuleIn(t.claude, rule)
	assert.equal(placed.path, join(t.claude, 'rule-files', 'workpulse-brain.md'))
	assert.equal(readFileSync(join(t.claude, 'CLAUDE.md'), 'utf8'), core)
	assert.ok(readFileSync(placed.path, 'utf8').includes('new brain text') && !readFileSync(placed.path, 'utf8').includes('old brain text'))
})

test('apply works when the map already sits at rule-files/rule-map.json in any formatting', () => {
	const s = setup()
	mkdirSync(join(s.claude, 'rule-files'))
	const real = join(s.claude, 'rule-files', 'rule-map.json')
	writeFileSync(real, JSON.stringify(MAP, null, '\t') + '\n\n') // not how split would write it
	splitRules({ claude: s.claude, mapPath: real, out: s.dir })
	writeTestPass(s.dir)
	const r = applyRules({ claude: s.claude, dir: s.dir, yes: true })
	assert.ok(!r.written.includes('rule-files/rule-map.json'))
	assert.equal(readFileSync(real, 'utf8'), JSON.stringify(MAP, null, '\t') + '\n\n')
	assert.ok(existsSync(join(s.claude, 'rule-files', 'gamma.md')))
	rollbackRules({ claude: s.claude })
	assert.equal(readFileSync(join(s.claude, 'CLAUDE.md'), 'utf8'), FIX)
	assert.ok(existsSync(real), 'a map that was there before is not removed')
})

test('re-splitting keeps a hand-drafted staged core: a plain re-split refuses, --keep-core keeps it, --discard-core saves it as CLAUDE.md.prev', () => {
	const t = staged()
	const f = join(t.dir, 'CLAUDE.md')
	const drafted = readFileSync(f, 'utf8') + '\nSHORT FORM: never push without asking\n'
	writeFileSync(f, drafted)
	assert.throws(() => splitRules({ claude: t.claude, mapPath: t.mapPath, out: t.dir }), /--keep-core.*--discard-core/s)
	assert.equal(readFileSync(f, 'utf8'), drafted)
	assert.ok(existsSync(join(t.dir, 'rule-files', 'gamma.md')), 'a refused split changes nothing')
	// an unedited core is simply regenerated
	const clean = staged()
	splitRules({ claude: clean.claude, mapPath: clean.mapPath, out: clean.dir })

	// a rule moved to always: the drafted core is kept, and verify names the rule whose text is not in it
	const moved = { rules: MAP.rules.map((r) => (r.slug === 'gamma' ? { slug: 'gamma', from: r.from, load: 'always', triggers: [] } : r)) }
	writeFileSync(t.mapPath, JSON.stringify(moved))
	const kept = splitRules({ claude: t.claude, mapPath: t.mapPath, out: t.dir, keepCore: true })
	assert.match(kept.summary, /Kept the drafted CLAUDE\.md/)
	assert.equal(readFileSync(f, 'utf8'), drafted)
	assert.ok(!existsSync(join(t.dir, 'rule-files', 'gamma.md')))
	const v = verifyRules({ dir: t.dir })
	assert.equal(v.ok, false)
	assert.ok(v.problems.some((p) => /Rule "gamma" is load: always.*Gamma rule.*not in the core word for word/.test(p)), v.problems.join('|'))
	assert.ok(v.problems.some((p) => /points to rule-files\/gamma\.md/.test(p)))
	// putting the text into the core, word for word, and dropping the stale pointer, makes it pass
	const fixed = drafted.replace(/- Gamma: read[^\n]*\n/, '') + sectionsOf(FIX)[3].text
	writeFileSync(f, fixed)
	assert.equal(verifyRules({ dir: t.dir }).ok, true, verifyReport(verifyRules({ dir: t.dir })))

	const d = splitRules({ claude: t.claude, mapPath: t.mapPath, out: t.dir, discardCore: true })
	assert.match(d.summary, /Saved your drafted CLAUDE\.md as .*CLAUDE\.md\.prev/)
	assert.equal(readFileSync(join(t.dir, 'CLAUDE.md.prev'), 'utf8'), fixed)
	assert.ok(readFileSync(f, 'utf8').includes('g1'), 'a fresh core has the always text')
	assert.equal(verifyRules({ dir: t.dir }).ok, true)
})

test('the CLI re-split flags: refused without a flag, kept with --keep-core', () => {
	const s = setup()
	const env = { ...process.env, HOME: s.root, CLAUDE_HOME: s.claude, WP_BRAIN_CONFIG: join(s.root, 'no-brain.json') }
	const wp = (...a) => spawnSync('node', [CLI, 'rules', ...a], { encoding: 'utf8', env })
	assert.equal(wp('split', '--map', s.mapPath).status, 0)
	writeFileSync(join(s.dir, 'CLAUDE.md'), 'drafted\n')
	const plain = wp('split', '--map', s.mapPath)
	assert.equal(plain.status, 1)
	assert.match(plain.stderr, /--keep-core/)
	const keep = wp('split', '--map', s.mapPath, '--keep-core')
	assert.match(keep.stdout, /Kept the drafted/)
	assert.equal(readFileSync(join(s.dir, 'CLAUDE.md'), 'utf8'), 'drafted\n')
})

// ── recall: rules and skills ───────────────────────────────────────────────

const withIndex = (fx, fn) => {
	const was = process.env.WP_BRAIN_RULE_INDEX
	process.env.WP_BRAIN_RULE_INDEX = fx.index
	try {
		return fn()
	} finally {
		if (was === undefined) delete process.env.WP_BRAIN_RULE_INDEX
		else process.env.WP_BRAIN_RULE_INDEX = was
	}
}
const names = (r) => r.map((m) => m.doc.name)

test('loadDocs lists the rules that load on demand and the skills, follows a symlinked skill, and skips what is broken', () => {
	const fx = claudeFixture()
	linkedSkill(fx, 'linked-reel-voiceover', 'Voice over a reel with timed captions')
	mkdirSync(join(fx.claude, 'skills', 'no-frontmatter'))
	writeFileSync(join(fx.claude, 'skills', 'no-frontmatter', 'SKILL.md'), '# just a heading\n')
	mkdirSync(join(fx.claude, 'skills', 'empty-folder'))
	const docs = withIndex(fx, () => loadDocs(fx.claude))
	const rules = docs.filter((d) => d.kind === 'rule').map((d) => d.name)
	const skills = docs.filter((d) => d.kind === 'skill').map((d) => d.name)
	assert.deepEqual(rules, ['git-push-rule', 'commit-hygiene'], 'an always-loaded rule is already in the core')
	assert.ok(skills.includes('flutter-paywall-audit') && skills.includes('linked-reel-voiceover'))
	assert.ok(!skills.includes('no-frontmatter') && !skills.includes('empty-folder'))
	const rule = docs.find((d) => d.name === 'git-push-rule')
	assert.equal(rule.path, join(fx.claude, 'rule-files', 'git-push-rule.md'))
	assert.deepEqual(rule.not, ['push notification'])
})

test('loadDocs is silent about rules and skills when no map exists, even when skills do', () => {
	const fx = claudeFixture({ map: false })
	assert.deepEqual(withIndex(fx, () => loadDocs(fx.claude)), [])
	assert.equal(existsSync(fx.index), false, 'nothing is cached for an install that has not opted in')
})

test('loadDocs caches the skills at the override path, rereads a changed file, and survives an unwritable cache', () => {
	const fx = claudeFixture()
	withIndex(fx, () => loadDocs(fx.claude))
	assert.ok(existsSync(fx.index))
	const first = JSON.parse(readFileSync(fx.index, 'utf8'))
	assert.ok(JSON.stringify(first).includes('flutter-paywall-audit'))
	const file = join(fx.claude, 'skills', 'tailwindcss', 'SKILL.md')
	writeFileSync(file, skillText('tailwindcss', 'Utility-first styling with Tailwind classes and gradients'))
	const later = new Date(Date.now() + 5000)
	utimesSync(file, later, later)
	const docs = withIndex(fx, () => loadDocs(fx.claude))
	assert.ok(docs.find((d) => d.name === 'tailwindcss').triggers.includes('gradient'))
	rmSync(join(fx.claude, 'skills', 'asc-cli'), { recursive: true })
	assert.ok(!withIndex(fx, () => loadDocs(fx.claude)).some((d) => d.name === 'asc-cli'), 'a deleted skill folder is gone')
	// A cache path that cannot be written (its parent is a file) does not break loading.
	writeFileSync(join(fx.root, 'blocker'), 'x')
	const broken = { ...fx, index: join(fx.root, 'blocker', 'nested', 'rule-index.json') }
	assert.ok(withIndex(broken, () => loadDocs(fx.claude)).some((d) => d.name === 'flutter-paywall-audit'))
})

test('loadDocs never touches the real ~/.workpulse when the override is set', () => {
	const fx = claudeFixture()
	const home = join(fx.root, 'home')
	mkdirSync(home)
	const code = `const { loadDocs } = await import(${JSON.stringify(new URL('./rules.mjs', import.meta.url).href)}); loadDocs(${JSON.stringify(fx.claude)})`
	const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, HOME: home, WP_BRAIN_RULE_INDEX: fx.index } })
	assert.equal(r.status, 0, r.stderr)
	assert.ok(existsSync(fx.index))
	assert.ok(!existsSync(join(home, '.workpulse')))
	// Without the override the cache follows HOME.
	const plain = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, HOME: home, WP_BRAIN_RULE_INDEX: '' } })
	assert.equal(plain.status, 0, plain.stderr)
	assert.ok(existsSync(join(home, '.workpulse', 'rule-index.json')))
})

test('matchDocs: a rule fires on one trigger word, a not phrase cancels it, and slash commands match nothing', () => {
	const fx = claudeFixture()
	const docs = withIndex(fx, () => loadDocs(fx.claude))
	assert.deepEqual(names(matchDocs('push', docs)), ['git-push-rule'])
	assert.deepEqual(names(matchDocs('please PUSH this', docs)), ['git-push-rule'])
	assert.deepEqual(names(matchDocs('push notifications are late', docs)), [])
	assert.deepEqual(names(matchDocs('push notifications are late, then push the fix', docs)), ['git-push-rule'])
	assert.deepEqual(names(matchDocs('the pushover app', docs)), [], 'a trigger is a whole word')
	assert.deepEqual(names(matchDocs('write the commit message', docs)), ['commit-hygiene'])
	assert.deepEqual(matchDocs('/push the flutter paywall', docs), [])
	assert.match(matchDocs('push', docs)[0].why, /push/)
	assert.deepEqual(names(matchDocs('x'.repeat(700) + ' push', docs)), [], 'only the first 600 characters count')
})

test('matchDocs: a trigger also fires on its simple inflections, and not phrases cancel the same way', () => {
	const fx = claudeFixture()
	const docs = withIndex(fx, () => loadDocs(fx.claude))
	for (const p of ['pushing the fix', 'I pushed it', 'he pushes daily', 'pushes']) assert.deepEqual(names(matchDocs(p, docs)), ['git-push-rule'], p)
	for (const p of ['the committing message', 'the committed message', 'the commits messages']) assert.deepEqual(names(matchDocs(p, docs)), ['commit-hygiene'], p)
	assert.deepEqual(names(matchDocs('pushing notifications are late', docs)), [], 'a not phrase is inflected too')
	assert.deepEqual(names(matchDocs('pushed notifications are late', docs)), [])
	assert.deepEqual(names(matchDocs('pushy', docs)), [])
	assert.deepEqual(names(matchDocs('the pusher service', docs)), [])
	assert.deepEqual(names(matchDocs('pushover', docs)), [])
	assert.deepEqual(names(matchDocs('pushed notifications are late, then pushing the fix', docs)), ['git-push-rule'])
})

test('short and hyphenated triggers keep their plural, and a dropped-e word does not gain a d', () => {
	const re = (w) => new RegExp(`^(?:${inflect(w)})$`, 'u')
	for (const [w, f] of [['pr', 'prs'], ['pr', 'pr'], ['pre-commit', 'pre-commits'], ['pull-request', 'pull-requests'], ['pre-commit', 'pre-commit']]) assert.ok(re(w).test(f), `${w} -> ${f}`)
	for (const [w, f] of [['fine', 'find'], ['mine', 'mind'], ['core', 'cord'], ['care', 'card'], ['use', 'usd']]) assert.ok(!re(w).test(f), `${w} must not fire on ${f}`)
	const fx = claudeFixture()
	const docs = withIndex(fx, () => loadDocs(fx.claude))
	assert.deepEqual(names(matchDocs('please deploy', docs)), ['git-push-rule'])
})

test('inflect: s, es, ed, ing, a doubled final consonant and a dropped e', () => {
	const re = (w) => new RegExp(`^(?:${inflect(w)})$`, 'u')
	for (const w of ['pushes', 'pushed', 'pushing', 'push']) assert.ok(re('push').test(w), w)
	for (const w of ['committing', 'committed', 'commits', 'commit']) assert.ok(re('commit').test(w), w)
	for (const w of ['merging', 'merged', 'merges', 'merge']) assert.ok(re('merge').test(w), w)
	for (const w of ['deploying', 'deploys', 'deployed']) assert.ok(re('deploy').test(w), w)
	for (const w of ['pushy', 'pusher']) assert.ok(!re('push').test(w), w)
})

test('matchDocs: a skill needs its name or two description words, and an unrelated prompt matches nothing', () => {
	const fx = claudeFixture()
	const docs = withIndex(fx, () => loadDocs(fx.claude))
	assert.deepEqual(names(matchDocs('the flutter paywalls show the wrong price', docs)), ['flutter-paywall-audit'])
	assert.deepEqual(names(matchDocs('my flutter app crashes', docs)), [], 'one description word is not enough')
	assert.deepEqual(names(matchDocs('tailwindcss spacing', docs)), ['tailwindcss'], 'the whole name is enough')
	assert.deepEqual(matchDocs("what's for dinner", docs), [])
	assert.deepEqual(matchDocs('/flutter-paywall-audit now', docs), [])
	const crowd = matchDocs('push the flutter paywall subscription purchase', docs, 2)
	assert.deepEqual(names(crowd), ['git-push-rule', 'flutter-paywall-audit'], 'rules first, two in all')
})

test('pointersFor points at onCommand rules once, and is null for other commands', () => {
	const fx = claudeFixture()
	const seen = new Set()
	const text = pointersFor(['git', 'commit', '-m', 'x'], seen, fx.claude)
	assert.match(text, /commit-hygiene\.md/)
	assert.doesNotMatch(text, /RULEBODYTEXT/)
	assert.equal(pointersFor(['git', 'commit'], seen, fx.claude), null, 'not twice')
	assert.equal(pointersFor(['ls', '-la'], new Set(), fx.claude), null)
	assert.equal(pointersFor(['git', 'status'], new Set(), fx.claude), null)
	assert.match(pointersFor([['git', 'push'], ['gh', 'pr', 'create']], new Set(), fx.claude), /git-push-rule\.md[\s\S]*commit-hygiene\.md/)
	assert.equal(pointersFor(['git', 'push'], new Set(), claudeFixture({ map: false }).claude), null)
})

// ---- rules test (cli/rules-test.mjs) -------------------------------------------------------------------

import { chmodSync } from 'node:fs'
import { liveCommand, liveVerdict, rulesTestCommand } from './rules-test.mjs'

const ALL_TESTS = [
	{ rule: 'alpha', prompt: 'please change alpha words now' },
	{ rule: 'alpha-two', prompt: 'the number two matters' },
	{ rule: 'beta', prompt: 'a flutter question', file: 'lib/main.dart' },
	{ rule: 'gamma', prompt: 'about gamma' },
]

/** Runs `rules test` on a staged split with `tests`; returns { code, lines, text }. */
function runTests(t, tests, opt = {}) {
	const testsPath = join(t.root, 'rule-tests.json')
	writeFileSync(testsPath, JSON.stringify(tests))
	const lines = []
	const code = rulesTestCommand({ opt: { dir: t.dir, tests: testsPath, ...opt }, claude: t.claude, log: (l) => lines.push(l) })
	return { code, lines, text: lines.join('\n') }
}
const passMarker = (t) => existsSync(join(t.dir, 'test-pass.json'))

test('rules test: a moved rule with no test fails the run and names the rule; no pass marker is written', () => {
	const t = staged()
	const r = runTests(t, { tests: ALL_TESTS.filter((x) => x.rule !== 'gamma'), quiet: [] })
	assert.equal(r.code, 1)
	assert.match(r.text, /fail.*gamma.*no test/)
	assert.match(r.text, /keep always-loaded: gamma/)
	assert.equal(passMarker(t), false)
})

test('rules test: a full pass prints one line per test with the counts, writes the marker and unlocks apply', () => {
	const t = staged()
	assert.throws(() => applyRules({ claude: t.claude, dir: t.dir, yes: true }), /rules test/)
	const r = runTests(t, { tests: ALL_TESTS, quiet: ['nothing to see here'] })
	assert.equal(r.code, 0, r.text)
	assert.equal(r.lines.filter((l) => /^pass /.test(l)).length, 6, 'four prompts, one file, one quiet')
	assert.match(r.lines.at(-1), /^Result: 6 passed, 0 failed .*4 moved rules/)
	assert.match(r.text, /alpha: 1\/1/)
	assert.match(r.text, /beta: 2\/2/)
	assert.equal(passMarker(t), true)
	applyRules({ claude: t.claude, dir: t.dir, yes: true })
	assert.ok(existsSync(join(t.claude, 'rule-files', 'gamma.md')))
})

test('rules test: a prompt that does not bring up its rule fails with keep always-loaded, and an earlier pass marker is removed', () => {
	const t = staged()
	assert.equal(runTests(t, { tests: ALL_TESTS, quiet: [] }).code, 0)
	assert.equal(passMarker(t), true)
	const bad = ALL_TESTS.map((x) => (x.rule === 'gamma' ? { ...x, prompt: 'nothing relevant at all' } : x))
	const r = runTests(t, { tests: bad, quiet: [] })
	assert.equal(r.code, 1)
	assert.match(r.text, /fail.*gamma.*prompt/)
	assert.match(r.text, /keep always-loaded: gamma/)
	assert.doesNotMatch(r.text, /keep always-loaded: alpha\b/)
	assert.equal(passMarker(t), false)
	assert.throws(() => applyRules({ claude: t.claude, dir: t.dir, yes: true }), /rules test/)
})

test('rules test: a prompt must bring up its own rule, not just any pointer', () => {
	const t = staged()
	const r = runTests(t, { tests: ALL_TESTS.map((x) => (x.rule === 'gamma' ? { ...x, prompt: 'please change alpha words now' } : x)), quiet: [] })
	assert.equal(r.code, 1)
	assert.match(r.text, /fail.*gamma/)
})

test('rules test: a quiet prompt that brings up a rule fails and names it', () => {
	const t = staged()
	const r = runTests(t, { tests: ALL_TESTS, quiet: ['just talking about gamma'] })
	assert.equal(r.code, 1)
	assert.match(r.text, /fail.*quiet.*gamma/)
	assert.equal(passMarker(t), false)
})

test('rules test: a file test passes only when the rule paths glob matches it', () => {
	const t = staged()
	const only = (extra) => ({ tests: [...ALL_TESTS.filter((x) => x.rule !== 'beta'), { rule: 'beta', prompt: 'a flutter question' }, extra], quiet: [] })
	assert.equal(runTests(t, only({ rule: 'beta', file: 'pubspec.yaml' })).code, 0)
	assert.equal(runTests(t, only({ rule: 'beta', file: 'lib/deep/er/thing.dart' })).code, 0)
	const miss = runTests(t, only({ rule: 'beta', file: 'src/index.ts' }))
	assert.equal(miss.code, 1)
	assert.match(miss.text, /fail.*beta.*file.*src\/index\.ts/)
	const notPath = runTests(t, only({ rule: 'gamma', file: 'lib/main.dart' }))
	assert.equal(notPath.code, 1, 'gamma is load: file, it has no paths')
})

test('rules test: command tests go through pointersFor and gate tests through decide', () => {
	const map = { rules: MAP.rules.map((r) => (r.slug === 'gamma' ? { ...r, onCommand: ['git push'] } : r)) }
	const t = staged(FIX, map)
	const tests = (extra) => ({ tests: [...ALL_TESTS, ...extra], quiet: [] })
	const ok = runTests(t, tests([{ rule: 'gamma', command: 'git push origin main' }, { rule: 'gamma', gate: { command: 'git commit -m x -m "Co-Authored-By: Claude <noreply@anthropic.com>"', expect: 'deny' } }, { gate: { command: 'git push origin main', expect: 'ask' } }]))
	assert.equal(ok.code, 0, ok.text)
	const wrongCommand = runTests(t, tests([{ rule: 'gamma', command: 'ls -la' }]))
	assert.equal(wrongCommand.code, 1)
	assert.match(wrongCommand.text, /fail.*gamma.*command/)
	const wrongGate = runTests(t, tests([{ rule: 'gamma', gate: { command: 'ls -la', expect: 'ask' } }]))
	assert.equal(wrongGate.code, 1)
	assert.match(wrongGate.text, /fail.*gate/)
})

test('rules test: a test for a rule the map does not have, or a missing tests file, fails', () => {
	const t = staged()
	assert.equal(runTests(t, { tests: [...ALL_TESTS, { rule: 'ghost', prompt: 'x' }], quiet: [] }).code, 1)
	const lines = []
	const code = rulesTestCommand({ opt: { dir: t.dir, tests: join(t.root, 'nope.json') }, claude: t.claude, log: (l) => lines.push(l) })
	assert.equal(code, 1)
	assert.match(lines.join('\n'), /rule-tests\.json|nope\.json/)
})

test('rules test: --dir runs against the staged folder only, from the CLI, with no warning and a --json report', () => {
	const t = staged()
	const testsPath = join(t.root, 'rule-tests.json')
	writeFileSync(testsPath, JSON.stringify({ tests: ALL_TESTS, quiet: [] }))
	const sb = brainSandbox()
	const emptyHome = mkdtempSync(join(tmpdir(), 'wp-empty-claude-'))
	const r = sb.runWith({ CLAUDE_HOME: emptyHome }, 'rules', 'test', '--dir', t.dir, '--tests', testsPath, '--json')
	assert.equal(r.status, 0, r.out + r.err)
	assert.equal(r.err, '', 'no ExperimentalWarning or anything else on stderr')
	const j = JSON.parse(r.out)
	assert.equal(j.ok, true)
	assert.equal(j.failed, 0)
	assert.deepEqual(j.rules.beta, { passed: 2, total: 2 })
	assert.equal(passMarker(t), true)
	const text = sb.runWith({ CLAUDE_HOME: emptyHome }, 'rules', 'test', '--dir', t.dir, '--tests', testsPath)
	assert.equal(text.err, '')
	assert.match(text.out, /Result: 5 passed, 0 failed/)
})

test('rules test --live: builds the claude -p command, runs it in a temp git repo with an InstructionsLoaded hook, and reads the transcript', () => {
	const t = staged()
	const bin = mkdtempSync(join(tmpdir(), 'wp-fake-claude-'))
	const record = join(bin, 'argv.json')
	const fake = join(bin, 'claude')
	writeFileSync(
		fake,
		`#!/usr/bin/env node
const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), git: fs.existsSync('.git') }))
const prompt = process.argv[3]
const read = /gamma/.test(prompt) ? ${JSON.stringify(join(t.dir, 'rule-files', 'gamma.md'))} : '/elsewhere.md'
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: read } }] } }))
`,
	)
	chmodSync(fake, 0o755)
	const sb = brainSandbox()
	const testsPath = join(t.root, 'rule-tests.json')
	writeFileSync(testsPath, JSON.stringify({ tests: [{ rule: 'gamma', prompt: 'about gamma' }], quiet: [] }))
	const only = { ...JSON.parse(readFileSync(join(t.dir, 'rule-files', 'rule-map.json'), 'utf8')) }
	assert.ok(only.rules.length > 1)
	const r = sb.runWith({ CLAUDE_HOME: t.dir, PATH: `${bin}:${process.env.PATH}` }, 'rules', 'test', '--dir', t.dir, '--tests', testsPath, '--live')
	const argv = JSON.parse(readFileSync(record, 'utf8'))
	assert.equal(argv.argv[0], '-p')
	assert.match(argv.argv.join(' '), /--output-format stream-json/)
	assert.match(argv.argv.join(' '), /--settings/)
	assert.equal(argv.git, true, 'a temp git repo')
	assert.match(r.out, /live.*gamma/)
	assert.match(r.out, /fail.*live.*(alpha|alpha-two|beta)|no test/, 'rules with no test still fail the run')
	assert.equal(r.status, 1)
})

test('liveCommand shapes the claude call and liveVerdict reads a saved transcript or the InstructionsLoaded log', () => {
	const c = liveCommand({ prompt: 'hello gamma', settings: '/tmp/s.json' })
	assert.equal(c.cmd, 'claude')
	assert.deepEqual(c.args.slice(0, 2), ['-p', 'hello gamma'])
	assert.ok(c.args.includes('--settings') && c.args.includes('/tmp/s.json') && c.args.includes('stream-json'))
	const transcript = readFileSync(new URL('./fixtures/live-transcript.jsonl', import.meta.url), 'utf8')
	assert.equal(liveVerdict({ rulePath: '/home/x/.claude/rule-files/gamma.md', transcript, log: '' }).ok, true)
	assert.equal(liveVerdict({ rulePath: '/home/x/.claude/rule-files/other.md', transcript, log: '' }).ok, false)
	const log = JSON.stringify({ hook_event_name: 'InstructionsLoaded', file_path: '/home/x/.claude/rules/beta.md', load_reason: 'path_glob_match' })
	assert.equal(liveVerdict({ rulePath: '/home/x/.claude/rules/beta.md', transcript: '', log }).ok, true)
	assert.equal(liveVerdict({ rulePath: '/home/x/.claude/rules/beta.md', transcript: '', log: log.replace('path_glob_match', 'session_start') }).ok, false)
})

test('rules test: the marker records the tests file, and apply refuses, naming it, when that file changed or is gone', () => {
	const t = staged()
	assert.equal(runTests(t, { tests: ALL_TESTS, quiet: [] }).code, 0)
	const marker = JSON.parse(readFileSync(join(t.dir, 'test-pass.json'), 'utf8'))
	assert.equal(marker.tests.path, join(t.root, 'rule-tests.json'))
	assert.match(marker.tests.sha256, /^[0-9a-f]{64}$/)
	const file = marker.tests.path
	const was = readFileSync(file, 'utf8')
	writeFileSync(file, was + ' ')
	assert.throws(() => applyRules({ claude: t.claude, dir: t.dir, yes: true }), /rule-tests\.json.*changed/)
	rmSync(file)
	assert.throws(() => applyRules({ claude: t.claude, dir: t.dir, yes: true }), /rule-tests\.json.*missing/)
	writeFileSync(file, was)
	applyRules({ claude: t.claude, dir: t.dir, yes: true })
})

test('rules test: a run that throws leaves no marker, and a test entry that is not an object fails cleanly', () => {
	const t = staged()
	assert.equal(runTests(t, { tests: ALL_TESTS, quiet: [] }).code, 0)
	assert.equal(passMarker(t), true)
	const r = runTests(t, { tests: [...ALL_TESTS, null], quiet: [] })
	assert.equal(r.code, 1)
	assert.equal(passMarker(t), false)
	writeFileSync(join(t.root, 'rule-tests.json'), JSON.stringify({ tests: ALL_TESTS, quiet: [] }))
	assert.equal(runTests(t, { tests: ALL_TESTS, quiet: [] }).code, 0)
	assert.throws(() => rulesTestCommand({ opt: { dir: t.dir, tests: join(t.root, 'rule-tests.json') }, claude: t.claude, log: () => { throw new Error('boom') } }))
	assert.equal(passMarker(t), false, 'a throw in the middle of a run leaves none')
})

test('rules test: zero tests fails and writes no marker', () => {
	const t = staged('# Only\nx\n', { rules: [{ slug: 'only', from: ['Only'], load: 'always', triggers: [] }] })
	const r = runTests(t, { tests: [], quiet: [] })
	assert.equal(r.code, 1)
	assert.match(r.text, /fail.*no tests ran/)
	assert.equal(passMarker(t), false)
})

test('rules test: command tests normalise the command as the hook does (env prefix, git -C)', () => {
	const map = { rules: MAP.rules.map((r) => (r.slug === 'gamma' ? { ...r, onCommand: ['git push'] } : r)) }
	const t = staged(FIX, map)
	const r = runTests(t, { tests: [...ALL_TESTS, { rule: 'gamma', command: 'FOO=1 git -C /tmp push origin main' }], quiet: [] })
	assert.equal(r.code, 0, r.text)
})

test('a rule whose text already lives in its own file (load: existing) is staged for the test, not moved, and recall points at the file', () => {
	const f = claudeFixture({ rules: [], skills: {}, map: false })
	const claude = f.claude
	writeFileSync(join(claude, 'CLAUDE.md'), '# Title\n\n## Push\npush text\n')
	writeFileSync(join(claude, 'TOOL.md'), 'tool text\n')
	const rules = [
		{ slug: 'title', from: ['Title'], load: 'always' },
		{ slug: 'push', from: ['Push'], load: 'file', triggers: ['push'] },
		{ slug: 'tool', load: 'existing', file: 'TOOL.md', triggers: ['truncated'], title: 'Tool' },
	]
	const mapPath = join(claude, 'map.json')
	writeFileSync(mapPath, JSON.stringify({ rules }))
	const out = join(f.root, 'stage')
	splitRules({ claude, mapPath, out })
	assert.equal(readFileSync(join(out, 'TOOL.md'), 'utf8'), 'tool text\n')
	assert.equal(existsSync(join(out, 'rule-files', 'tool.md')), false)
	assert.equal(verifyRules({ dir: out }).ok, true)
	const stagedHit = matchDocs('why is this output truncated', loadDocs(out))
	assert.deepEqual(stagedHit.map((h) => h.doc.path), [join(out, 'TOOL.md')])

	writeTestPass(out)
	const applied = applyRules({ claude, dir: out, yes: true })
	assert.ok(!applied.written.includes('TOOL.md'))
	assert.equal(readFileSync(join(claude, 'TOOL.md'), 'utf8'), 'tool text\n')
	const hit = matchDocs('why is this output truncated', loadDocs(claude))
	assert.deepEqual(hit.map((h) => h.doc.path), [join(claude, 'TOOL.md')])
	rollbackRules({ claude })
	assert.equal(readFileSync(join(claude, 'TOOL.md'), 'utf8'), 'tool text\n')
})

test('load: existing needs a plain file name that is there, no from, and something that brings it up', () => {
	const f = claudeFixture({ rules: [], skills: {}, map: false })
	const claude = f.claude
	writeFileSync(join(claude, 'CLAUDE.md'), '# Title\n')
	const stop = (rule) => {
		const mapPath = join(claude, 'map.json')
		writeFileSync(mapPath, JSON.stringify({ rules: [{ slug: 'title', from: ['Title'], load: 'always' }, rule] }))
		return () => splitRules({ claude, mapPath, out: join(f.root, 'stage') })
	}
	assert.throws(stop({ slug: 'a', load: 'existing', file: 'GONE.md', triggers: ['x'] }), /GONE\.md/)
	assert.throws(stop({ slug: 'a', load: 'existing', file: '../other.md', triggers: ['x'] }), /plain file name/)
	assert.throws(stop({ slug: 'a', load: 'existing', triggers: ['x'] }), /plain file name/)
	writeFileSync(join(claude, 'TOOL.md'), 'x\n')
	assert.throws(stop({ slug: 'a', load: 'existing', file: 'TOOL.md' }), /triggers/)
	assert.throws(stop({ slug: 'a', load: 'existing', file: 'TOOL.md', triggers: ['x'], from: ['Title'] }), /no from/)
})

// ── final review ────────────────────────────────────────────────────────────

test('final review 1: config restore on a machine whose backup has a split core keeps the Brain rule out of the core', () => {
	const { run, root } = brainSandbox({ config: { library: true } })
	const home = join(root, 'home')
	const claude = join(home, '.claude')
	mkdirSync(join(claude, 'rule-files'), { recursive: true })
	const POINTER_CORE = '# core\n\n**WorkPulse Brain:** see rule-files/workpulse-brain.md\n'
	writeFileSync(join(claude, 'CLAUDE.md'), POINTER_CORE)
	writeFileSync(join(claude, 'rule-files', 'workpulse-brain.md'), `## WorkPulse Brain\nintro\n${BLOCK}tail\n`)
	assert.equal(run('config', 'backup', '--home', home).status, 0)
	// A new machine after `setup`: a CLAUDE.md that only holds this machine's own marked rule.
	const fresh = join(root, 'fresh')
	mkdirSync(join(fresh, '.claude'), { recursive: true })
	const NEW = '<!-- workpulse-brain:start -->\nTHIS MACHINE RULE\n<!-- workpulse-brain:end -->'
	writeFileSync(join(fresh, '.claude', 'CLAUDE.md'), `${NEW}\n`)
	const r = run('config', 'restore', '--home', fresh)
	assert.equal(r.status, 0, r.err)
	assert.equal(readFileSync(join(fresh, '.claude', 'CLAUDE.md'), 'utf8'), POINTER_CORE, 'the core stays the backed-up pointer')
	const moved = readFileSync(join(fresh, '.claude', 'rule-files', 'workpulse-brain.md'), 'utf8')
	assert.match(moved, /THIS MACHINE RULE/)
	assert.doesNotMatch(moved, /OLD BRAIN RULE/)
})

test('final review 4: the CLI sandbox never reads the real ~/.claude or writes the real rule index', () => {
	const fx = claudeFixture()
	const sb = brainSandbox({})
	const home = join(sb.root, 'fakehome')
	mkdirSync(join(home, '.claude'), { recursive: true })
	cpSync(fx.claude, join(home, '.claude'), { recursive: true })
	const r = sb.runWith({ HOME: home, input: JSON.stringify({ session_id: 's', prompt: 'audit the flutter paywall purchase flow', cwd: tmpdir() }) }, 'recall')
	assert.equal(r.status, 0, r.err)
	assert.equal(existsSync(join(home, '.workpulse', 'rule-index.json')), false)
	assert.doesNotMatch(r.out, /flutter-paywall-audit/)
})

// `wp-brain rules`: split CLAUDE.md into rule files and prove that no line was lost.
// Node built-ins and two small modules of ours (budget.mjs, sensitive.mjs) that import only built-ins, so the guard can lazy-import
// this file. No top-level await import, here or in what it imports (a test walks the imports).
//
//   sectionsOf(markdown)            fence-aware `#`/`##` sections with `###` parts inside; the texts add up to the input
//   splitRules({ claude, mapPath })  stage the result in a folder (default ~/.claude/rule-split/), nothing else is touched
//   verifyRules({ dir })            every non-blank line of the old file is in the rule files or the kept core, as often
//   applyRules({ claude, dir })     the old file is copied aside, rule files are written first and the core last
//   rollbackRules({ claude })       put the old file back and take away what apply wrote
//   writeTestPass(dir)              the marker `apply` wants from `rules test` (Task 7 calls this when its run passes)
//   loadDocs / matchDocs / pointersFor   recall and the guard point at the right rule or skill (see "pointers" below)
//
// The map (`~/.claude/rule-files/rule-map.json`):
//   { rules: [{ slug, from: [heading | "heading > subheading"], load: 'file' | 'path' | 'always' | 'existing', paths?, file?, triggers, not?, onCommand?, title }] }
// `from` names `#`/`##` headings by their text. When any `A > x` is used for a section, `A` alone means only the text before
// its first `###`, and every `###` part must be named; otherwise `A` is the whole section.
//   load 'always'  stays in the core, word for word, in file order
//   load 'file'    rule-files/<slug>.md, a body byte-identical to the source; the core gets one pointer line
//   load 'path'    rules/<slug>.md with `paths` frontmatter, loaded by Claude Code only when such a file is open
//   load 'existing' the text already lives in <claude>/<file> and stays there (RTK.md): no `from`, nothing moved, recall points at it
import { createHash } from 'node:crypto'
import { copyFileSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { CAPS, tokensOf } from './budget.mjs'
import { SENSITIVE_FILE } from './sensitive.mjs'

const POINTER_START = '<!-- wp-rules:start -->'
const POINTER_END = '<!-- wp-rules:end -->'
const LOADS = ['file', 'path', 'always', 'existing']
const STAGE_FILES = ['old.md', 'old-sha256', 'test-pass.json']
const sha = (text) => createHash('sha256').update(text).digest('hex')
const read = (p) => readFileSync(p, 'utf8')
const nl = (t) => (t === '' || t.endsWith('\n') ? t : t + '\n')
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const isFile = (p) => {
	try {
		return lstatSync(p).isFile()
	} catch {
		return false
	}
}
const isDir = (p) => {
	try {
		return lstatSync(p).isDirectory()
	} catch {
		return false
	}
}

// ---- sections -------------------------------------------------------------------------------------

const HEADING = /^ {0,3}(#{1,3})[ \t]+(\S.*?)[ \t]*$/

/**
 * Sections at `#` and `##` (text before the first one is a section with heading '' and level 0), each with its `###` parts in
 * `sub`. A heading-looking line inside a fence is text; a fence closes on the same character at least as long as its opener, so a
 * four-backtick fence can hold a three-backtick one. `text` is the section's lines unchanged; the top-level texts add up to the input.
 */
export function sectionsOf(markdown) {
	const lines = markdown.match(/[^\n]*\n|[^\n]+$/g) ?? []
	const out = []
	let cur = null
	let sub = null
	let fence = null
	let lead = '' // a comment line directly above a heading (an opening marker, not one that says `end`) belongs to that heading's section
	for (const [i, line] of lines.entries()) {
		const body = line.replace(/\r?\n$/, '')
		if (!fence && /^ {0,3}<!--.*-->[ \t]*$/.test(body) && !/[:\s]end\b/i.test(body) && HEADING.test((lines[i + 1] ?? '').replace(/\r?\n$/, ''))) {
			lead = line
			continue
		}
		const f = body.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
		let head = null
		if (fence) {
			if (f && f[1][0] === fence.ch && f[1].length >= fence.len && f[2].trim() === '') fence = null
		} else if (f) {
			if (!(f[1][0] === '`' && f[2].includes('`'))) fence = { ch: f[1][0], len: f[1].length }
		} else {
			head = body.match(HEADING)
		}
		if (head && head[1].length <= 2) {
			cur = { heading: head[2], level: head[1].length, text: '', sub: [] }
			sub = null
			out.push(cur)
		} else if (!cur) {
			cur = { heading: '', level: 0, text: '', sub: [] }
			out.push(cur)
		}
		if (head && head[1].length === 3) {
			sub = { heading: head[2], level: 3, text: '', sub: [] }
			cur.sub.push(sub)
		}
		cur.text += lead + line
		if (sub) sub.text += lead + line
		lead = ''
	}
	return out
}

const blank = (t) => t.trim() === ''
const leadOf = (s) => s.text.slice(0, s.text.length - s.sub.reduce((n, p) => n + p.text.length, 0))

// ---- the map and the plan -------------------------------------------------------------------------

function mapProblems(map) {
	const problems = []
	if (!map || !Array.isArray(map.rules)) return ['The map needs a "rules" list.']
	const slugs = new Set()
	for (const [i, r] of map.rules.entries()) {
		const at = `rule ${i + 1}${r?.slug ? ` (${r.slug})` : ''}`
		if (!r || typeof r.slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(r.slug)) {
			problems.push(`${at}: slug must be lower-case letters, digits and dashes.`)
			continue
		}
		if (slugs.has(r.slug)) problems.push(`${at}: slug "${r.slug}" is used more than once.`)
		slugs.add(r.slug)
		if (SENSITIVE_FILE.test(`${r.slug}.md`)) problems.push(`${at}: the slug "${r.slug}" holds a word that config backup skips, so the rule would not be backed up; rename it (env-hygiene, not secret-rules).`)
		if (!LOADS.includes(r.load)) problems.push(`${at}: load must be one of ${LOADS.join(', ')}.`)
		if (r.load === 'existing') {
			if (typeof r.file !== 'string' || !/^[\w-][\w.-]*$/.test(r.file)) problems.push(`${at}: load: existing needs file, a plain file name in the Claude folder.`)
			if (r.from !== undefined) problems.push(`${at}: load: existing moves nothing, so it takes no from.`)
			if (!r.triggers?.length && !r.onCommand?.length) problems.push(`${at}: load: existing needs triggers or onCommand, or nothing brings it up.`)
		} else if (!Array.isArray(r.from) || !r.from.length || r.from.some((h) => typeof h !== 'string' || !h.trim())) problems.push(`${at}: from must list at least one heading.`)
		if (r.load === 'path' && (!Array.isArray(r.paths) || !r.paths.length || r.paths.some((p) => typeof p !== 'string' || !p))) problems.push(`${at}: a path rule needs a non-empty paths list.`)
		if (r.load === 'file' && (!Array.isArray(r.triggers) || !r.triggers.length)) problems.push(`${at}: a file rule needs triggers, or nothing says when to read it.`)
		for (const k of ['triggers', 'not']) if (r[k] !== undefined && (!Array.isArray(r[k]) || r[k].some((x) => typeof x !== 'string'))) problems.push(`${at}: ${k} must be a list of strings.`)
	}
	return problems
}

/** { top, sub } of one `from` entry. */
function refOf(text) {
	const i = text.indexOf(' > ')
	return i < 0 ? { top: text.trim(), sub: null } : { top: text.slice(0, i).trim(), sub: text.slice(i + 3).trim() }
}

/**
 * Which text goes where. Returns { problems, core, bodies } where `bodies` maps a slug to its text (file and path rules) and `core`
 * is the kept text in file order. Problems name every section the map misses, names twice or does not find.
 */
function plan(old, map) {
	const problems = mapProblems(map)
	if (problems.length) return { problems }
	const sections = sectionsOf(old)
	const refs = map.rules.flatMap((r) => (r.from ?? []).map((text) => ({ rule: r, text, ...refOf(text) })))
	const units = [] // { key, text, order, named: [rule] }
	const seenTop = new Map()
	for (const s of sections) if (s.heading) seenTop.set(s.heading, (seenTop.get(s.heading) ?? 0) + 1)
	for (const [h, n] of seenTop) if (n > 1 && !blank(sections.filter((s) => s.heading === h).map((s) => s.text).join(''))) problems.push(`The heading "${h}" appears ${n} times in the file (twice or more); rename one so the map can tell them apart.`)
	for (const s of sections) {
		const parted = s.heading && refs.some((r) => r.top === s.heading && r.sub !== null)
		const keys = new Map()
		if (parted) {
			units.push({ key: s.heading, text: leadOf(s), order: units.length })
			for (const p of s.sub) {
				const key = `${s.heading} > ${p.heading}`
				if (keys.has(key)) problems.push(`The part "${key}" appears twice in the file; rename one.`)
				keys.set(key, true)
				units.push({ key, text: p.text, order: units.length })
			}
		} else units.push({ key: s.heading, text: s.text, order: units.length, preamble: s.level === 0 })
	}
	const named = new Map()
	for (const r of refs) {
		const key = r.sub === null ? r.top : `${r.top} > ${r.sub}`
		const hit = units.filter((u) => u.key === key)
		if (!hit.length) {
			problems.push(`The map names "${r.text}" (rule ${r.rule.slug}), which is not in the file.`)
			continue
		}
		if (named.has(key)) problems.push(`"${key}" is mapped twice: by ${named.get(key)} and by ${r.rule.slug}.`)
		else named.set(key, r.rule.slug)
	}
	for (const u of units) {
		if (named.has(u.key) || blank(u.text)) continue
		problems.push(u.preamble ? 'The text before the first heading cannot be named in the map; put it under a heading.' : `Section "${u.key}" is not in the map; a section added later would vanish, so name it.`)
	}
	if (problems.length) return { problems }
	const byKey = new Map(units.map((u) => [u.key, u]))
	const bodies = {}
	for (const r of map.rules) {
		if (r.load === 'always' || r.load === 'existing') continue
		bodies[r.slug] = joinText(r.from.map((t) => byKey.get(refKey(t)).text))
	}
	const keep = new Set(map.rules.filter((r) => r.load === 'always').flatMap((r) => r.from.map(refKey)))
	const core = joinText(units.filter((u) => keep.has(u.key)).map((u) => u.text))
	const always = map.rules.filter((r) => r.load === 'always').flatMap((r) => r.from.map((t) => ({ slug: r.slug, key: refKey(t), text: byKey.get(refKey(t)).text }))).filter((a) => !blank(a.text))
	return { problems, core, bodies, always }
}

/** Texts end to end; a text with no final newline gets one only where another follows. */
const joinText = (texts) => texts.reduce((a, t) => a + (a && !a.endsWith('\n') ? '\n' : '') + t, '')

const refKey = (text) => {
	const r = refOf(text)
	return r.sub === null ? r.top : `${r.top} > ${r.sub}`
}

/** The pointer block for the core: one line per file rule, in map order. */
function pointerBlock(map) {
	const files = map.rules.filter((r) => r.load === 'file')
	if (!files.length) return ''
	const lines = files.map((r) => `- ${r.title || r.slug}: read ~/.claude/rule-files/${r.slug}.md when ${r.triggers.join(', ')}${r.onCommand ? ` (or before running ${[].concat(r.onCommand).join(', ')})` : ''}`)
	return [POINTER_START, '## Rules read on demand', 'Read the file before acting when the task matches.', ...lines, POINTER_END, ''].join('\n')
}

const frontmatterFor = (paths) => `---\npaths:\n${paths.map((p) => `  - ${JSON.stringify(p)}`).join('\n')}\n---\n`

/** The text of a staged path rule without its frontmatter, or null when the frontmatter is not what split writes. */
function stripFrontmatter(text) {
	const m = text.match(/^---\n(paths:\n(?: {2}- .+\n)+)---\n/)
	return m ? text.slice(m[0].length) : null
}

// ---- split ----------------------------------------------------------------------------------------

/**
 * Stage the split of `<claude>/CLAUDE.md` by the map at `mapPath` into `out` (default `<claude>/rule-split`). Throws, with every
 * problem named and nothing written, when the map doesn't cover the file exactly. Returns { dir, rules, coreTokens, summary }.
 */
export function splitRules({ claude, mapPath, out = join(claude, 'rule-split'), keepCore = false, discardCore = false }) {
	if (!mapPath) throw new Error('Give the map: wp-brain rules split --map FILE')
	let map
	let mapText
	try {
		mapText = read(mapPath)
		map = JSON.parse(mapText)
	} catch (e) {
		throw new Error(`Cannot read the map ${mapPath}: ${e.message}`)
	}
	const oldPath = join(claude, 'CLAUDE.md')
	if (!isFile(oldPath)) throw new Error(`${oldPath} does not exist.`)
	const old = read(oldPath)
	const planned = plan(old, map)
	if (!planned.problems.length) for (const r of map.rules) if (r.load === 'existing' && !isFile(join(claude, r.file))) planned.problems.push(`Rule ${r.slug} is load: existing, but ${join(claude, r.file)} does not exist.`)
	if (planned.problems.length) throw new Error(`The split stopped; nothing was written.\n${planned.problems.map((p) => `  - ${p}`).join('\n')}`)
	if (existsSync(out)) {
		if (!isDir(out)) throw new Error(`${out} is a file.`)
		if (readdirSync(out).length && !existsSync(join(out, 'old-sha256'))) throw new Error(`${out} is not empty and is not a staging folder of this tool; give another --out.`)
	}
	// A core drafted by hand in the staging folder (short forms, a table) is not ours to overwrite.
	const stagedCore = join(out, 'CLAUDE.md')
	const generatedSha = isFile(join(out, 'core-sha256')) ? read(join(out, 'core-sha256')).trim() : null
	const drafted = isFile(stagedCore) && sha(read(stagedCore)) !== generatedSha
	const notes = []
	if (drafted && !keepCore && !discardCore) throw new Error(`Refused: the staged CLAUDE.md in ${out} was edited since split wrote it, and splitting again would replace it.\n  --keep-core     regenerate the rule files and keep your drafted CLAUDE.md (verify then names any rule moved to load: always whose text is not in it)\n  --discard-core  save your draft as CLAUDE.md.prev and write a fresh core`)
	if (drafted && keepCore) notes.push('Kept the drafted CLAUDE.md as it is; its pointer block was not regenerated.')
	if (drafted && !keepCore) {
		let prev = join(out, 'CLAUDE.md.prev')
		for (let i = 2; existsSync(prev); i++) prev = join(out, `CLAUDE.md.prev-${i}`)
		writeFileSync(prev, read(stagedCore))
		notes.push(`Saved your drafted CLAUDE.md as ${prev}.`)
	}
	for (const f of STAGE_FILES) rmSync(join(out, f), { force: true })
	for (const d of ['rules', 'rule-files']) rmSync(join(out, d), { recursive: true, force: true })
	mkdirSync(join(out, 'rule-files'), { recursive: true })
	const put = (rel, text) => {
		mkdirSync(dirname(join(out, rel)), { recursive: true })
		writeFileSync(join(out, rel), text)
	}
	for (const r of map.rules) {
		if (r.load === 'file') put(`rule-files/${r.slug}.md`, planned.bodies[r.slug])
		if (r.load === 'path') put(`rules/${r.slug}.md`, frontmatterFor(r.paths) + planned.bodies[r.slug])
		if (r.load === 'existing') put(r.file, read(join(claude, r.file))) // a copy so `rules test` finds it here; apply writes only rules/ and rule-files/
	}
	const pointers = pointerBlock(map)
	const generated = planned.core ? nl(planned.core) + (pointers ? '\n' + pointers : '') : pointers
	let core = generated
	if (drafted && keepCore) core = read(stagedCore)
	else {
		put('CLAUDE.md', generated)
		put('core-sha256', sha(generated) + '\n')
	}
	put('rule-files/rule-map.json', mapText) // the map's own bytes, so a map already at ~/.claude/rule-files/ is not a clash on apply
	put('old.md', old)
	put('old-sha256', sha(old) + '\n')
	const coreTokens = tokensOf(core)
	const n = (l) => map.rules.filter((r) => r.load === l).length
	return { dir: out, rules: map.rules.length, coreTokens, summary: `${notes.map((n) => n + '\n').join('')}Staged in ${out}: ${n('file')} rule files, ${n('path')} path rules, ${n('always')} kept in the core (${coreTokens.toLocaleString('en-US')} tokens).` }
}

// ---- verify ---------------------------------------------------------------------------------------

const countLines = (text) => {
	const m = new Map()
	for (const l of text.split('\n')) if (!blank(l)) m.set(l, (m.get(l) ?? 0) + 1)
	return m
}

/** The staged core without its generated pointer block. */
function withoutPointers(core) {
	const a = core.indexOf(POINTER_START)
	const b = core.indexOf(POINTER_END)
	return a >= 0 && b > a ? core.slice(0, a) + core.slice(b + POINTER_END.length) : core
}

/** The staged folder, read: { old, hash, core, map }. Throws when it is not a staged split. */
function readStage(dir) {
	const need = ['old.md', 'old-sha256', 'CLAUDE.md', 'rule-files/rule-map.json']
	if (!dir || !need.every((f) => isFile(join(dir, f)))) throw new Error(`${dir} is not a staged split; run: wp-brain rules split --map FILE`)
	return { old: read(join(dir, 'old.md')), hash: read(join(dir, 'old-sha256')).trim(), core: read(join(dir, 'CLAUDE.md')), map: JSON.parse(read(join(dir, 'rule-files/rule-map.json'))) }
}

/**
 * Proves the staged files hold every non-blank line of the old file, unchanged and at least as often. Frontmatter and the
 * generated pointer block never count towards that. Returns { ok, problems, lost: [{ line, want, have }], added, coreTokens }.
 */
export function verifyRules({ dir }) {
	const { old, hash, core, map } = readStage(dir)
	const problems = []
	if (sha(old) !== hash) problems.push('old.md does not match old-sha256: the staged copy of the old file was changed.')
	const have = countLines(withoutPointers(core))
	for (const r of map.rules) {
		if (r.load === 'always' || r.load === 'existing') continue
		const file = join(dir, r.load === 'file' ? 'rule-files' : 'rules', `${r.slug}.md`)
		if (!isFile(file)) {
			problems.push(`${r.load === 'file' ? 'rule-files' : 'rules'}/${r.slug}.md is missing.`)
			continue
		}
		let text = read(file)
		if (r.load === 'path') {
			const body = stripFrontmatter(text)
			if (body === null) {
				problems.push(`rules/${r.slug}.md does not start with the paths frontmatter that split writes.`)
				continue
			}
			text = body
		}
		for (const [l, n] of countLines(text)) have.set(l, (have.get(l) ?? 0) + n)
	}
	const planned = plan(old, map)
	if (planned.problems.length) problems.push(...planned.problems.map((p) => `The staged map no longer fits the staged old file: ${p}`))
	const kept = withoutPointers(core)
	for (const a of planned.always ?? []) if (!kept.includes(a.text)) problems.push(`Rule "${a.slug}" is load: always, but "${a.key}" is not in the core word for word.`)
	for (const m of core.matchAll(/rule-files\/([a-z0-9-]+)\.md/g)) {
		const r = map.rules.find((x) => x.slug === m[1])
		if (r && r.load !== 'file') problems.push(`The core points to rule-files/${m[1]}.md, but "${m[1]}" is load: ${r.load}, so that file does not exist.`)
	}
	const lost = []
	for (const [line, want] of countLines(old)) if ((have.get(line) ?? 0) < want) lost.push({ line, want, have: have.get(line) ?? 0 })
	const before = countLines(old)
	const used = new Map()
	const added = []
	for (const l of core.split('\n')) {
		if (blank(l)) continue
		const k = (used.get(l) ?? 0) + 1
		used.set(l, k)
		if (k > (before.get(l) ?? 0)) added.push(l)
	}
	return { ok: !problems.length && !lost.length, problems, lost, added, coreTokens: tokensOf(core) }
}

/** The report the owner reads. */
export function verifyReport(v) {
	const out = [`Lines lost: ${v.lost.length}`]
	for (const l of v.lost.slice(0, 40)) out.push(`  - ${l.line}${l.want > 1 ? `  (wanted ${l.want}, found ${l.have})` : ''}`)
	if (v.lost.length > 40) out.push(`  … and ${v.lost.length - 40} more`)
	for (const p of v.problems) out.push(`Problem: ${p}`)
	out.push(`Lines added to the core: ${v.added.length}`)
	for (const l of v.added) out.push(`  + ${l}`)
	const over = v.coreTokens > CAPS.claudeMd
	out.push(`Core: ${v.coreTokens.toLocaleString('en-US')} tokens (target ${CAPS.claudeMd.toLocaleString('en-US')}${over ? ', OVER' : ''})`)
	out.push(v.ok ? 'Verified: every line of the old file is in the rule files or the core.' : 'NOT verified: do not apply.')
	return out.join('\n')
}

// ---- the pass marker ------------------------------------------------------------------------------

/** One digest over every staged file `apply` would write, so a pass is only good for exactly what was tested. */
function stagedDigest(dir) {
	const files = ['CLAUDE.md']
	for (const d of ['rules', 'rule-files']) if (isDir(join(dir, d))) files.push(...readdirSync(join(dir, d)).sort().map((f) => `${d}/${f}`))
	return sha(files.map((f) => `${f}\0${sha(read(join(dir, f)))}`).join('\n'))
}

/** Records that `rules test` passed on this staged split: the old file's hash and a digest of the staged files. */
export function writeTestPass(dir, { now = new Date(), tests } = {}) {
	const { hash } = readStage(dir)
	const marker = { hash, staged: stagedDigest(dir), at: now.toISOString() }
	if (tests) marker.tests = { path: tests, sha256: sha(read(tests)) } // the tests file the pass ran against
	writeFileSync(join(dir, 'test-pass.json'), JSON.stringify(marker, null, 2) + '\n')
}

/** null when the marker fits this staged split and its tests file is unchanged, else the reason it does not. */
function testPassProblem(dir, hash) {
	let p
	try {
		p = JSON.parse(read(join(dir, 'test-pass.json')))
		if (p.hash !== hash || p.staged !== stagedDigest(dir)) return 'it was stored for another old file or other staged files'
	} catch {
		return 'none is stored'
	}
	if (p.tests) {
		let now
		try {
			now = sha(read(p.tests.path))
		} catch {
			return `the tests file ${p.tests.path} it ran against is missing now`
		}
		if (now !== p.tests.sha256) return `the tests file ${p.tests.path} changed since the pass`
	}
	return null
}

// ---- apply and rollback ---------------------------------------------------------------------------

const MANIFEST = 'rule-split-applied.json'

/** What differs between two texts, as lines the owner can read. */
function describeChange(was, now) {
	const a = countLines(was)
	const b = countLines(now)
	const gone = [...a].filter(([l, n]) => (b.get(l) ?? 0) < n).map(([l]) => l)
	const fresh = [...b].filter(([l, n]) => (a.get(l) ?? 0) < n).map(([l]) => l)
	const show = (sign, list) => list.slice(0, 8).map((l) => `  ${sign} ${l}`).concat(list.length > 8 ? [`  … and ${list.length - 8} more`] : [])
	return [...show('-', gone), ...show('+', fresh)].join('\n') || '  (only blank lines or line order)'
}

const stagedWrites = (dir) => {
	const out = []
	for (const d of ['rule-files', 'rules']) if (isDir(join(dir, d))) out.push(...readdirSync(join(dir, d)).sort().map((f) => `${d}/${f}`))
	return out
}

/**
 * Applies the staged split to `claude`. Refuses unless `yes`, `verify` passes, a test pass is stored for this staged split, and the
 * old file is still the one that was split. The old file is copied to CLAUDE.md.pre-split-<date>, rule files are written first and
 * CLAUDE.md last (by rename); a failure before that undoes what was written. Returns { backup, written }.
 */
export function applyRules({ claude, dir = join(claude, 'rule-split'), yes = false, now = new Date() }) {
	const stage = readStage(dir)
	const v = verifyRules({ dir })
	if (!v.ok) throw new Error(`Refused: verify failed; run wp-brain rules verify.\n${verifyReport(v)}`)
	const noPass = testPassProblem(dir, stage.hash)
	if (noPass) throw new Error(`Refused: rules test has not passed for this staged split (${noPass}). A pass is stored against the old file hash, the staged files and the tests file; changing any of them voids it. Run: wp-brain rules test`)
	if (!yes) throw new Error('Refused: add --yes to apply.')
	const target = join(claude, 'CLAUDE.md')
	if (!isFile(target)) throw new Error(`Refused: ${target} does not exist.`)
	const current = read(target)
	if (sha(current) !== stage.hash) throw new Error(`Refused: CLAUDE.md has changed since the split; nothing was written. Split again.\n${describeChange(stage.old, current)}`)
	const writes = stagedWrites(dir)
	const clash = writes.filter((rel) => isFile(join(claude, rel)) && read(join(claude, rel)) !== read(join(dir, rel)))
	if (clash.length) throw new Error(`Refused: ${clash.join(', ')} already exist${clash.length === 1 ? 's' : ''} in ${claude} with other text; nothing was written.`)

	let backup = join(claude, `CLAUDE.md.pre-split-${ymd(now)}`)
	for (let i = 2; existsSync(backup); i++) backup = join(claude, `CLAUDE.md.pre-split-${ymd(now)}-${i}`)
	const made = [] // files created by this run
	const dirs = [] // folders created by this run
	const tmp = join(claude, 'CLAUDE.md.wp-rules.tmp')
	let backedUp = false
	try {
		copyFileSync(target, backup, constants.COPYFILE_EXCL)
		backedUp = true
		for (const rel of writes) {
			const dest = join(claude, rel)
			if (isFile(dest)) continue // identical, from an earlier try
			if (!isDir(dirname(dest))) {
				mkdirSync(dirname(dest))
				dirs.push(dirname(dest))
			}
			writeFileSync(dest, read(join(dir, rel)))
			made.push(rel)
		}
		const core = read(join(dir, 'CLAUDE.md'))
		writeFileSync(join(claude, MANIFEST), JSON.stringify({ backup, coreSha: sha(core), written: made.map((rel) => ({ rel, sha: sha(read(join(claude, rel))) })), dirs, at: now.toISOString() }, null, 2) + '\n')
		writeFileSync(tmp, core)
		renameSync(tmp, target)
	} catch (e) {
		rmSync(tmp, { force: true })
		rmSync(join(claude, MANIFEST), { force: true })
		for (const rel of made) rmSync(join(claude, rel), { force: true })
		for (const d of dirs.reverse()) tryRmdir(d)
		if (backedUp) rmSync(backup, { force: true })
		throw new Error(`Apply failed before CLAUDE.md was changed (it is untouched, and what was written is removed): ${e.message}`)
	}
	return { backup, written: made }
}

function tryRmdir(d) {
	try {
		rmdirSync(d)
	} catch {
		/* not empty: not ours to remove */
	}
}

/**
 * Puts the old CLAUDE.md back and removes the files `apply` wrote (a file edited since is kept). A CLAUDE.md edited after apply is
 * saved as CLAUDE.md.pre-rollback-<date> first. Returns { restored, removed, kept }.
 */
export function rollbackRules({ claude, now = new Date() }) {
	let manifest = null
	try {
		manifest = JSON.parse(read(join(claude, MANIFEST)))
	} catch {
		/* none: fall back on the newest backup */
	}
	let backup = manifest?.backup
	if (!backup) {
		const names = readdirSync(claude).filter((n) => /^CLAUDE\.md\.pre-split-\d{4}-\d{2}-\d{2}(-\d+)?$/.test(n)).sort()
		backup = names.length ? join(claude, names[names.length - 1]) : null
	}
	if (!backup || !isFile(backup)) throw new Error('There is nothing to roll back: no CLAUDE.md.pre-split-<date> file.')
	const target = join(claude, 'CLAUDE.md')
	const kept = []
	const removed = []
	const current = isFile(target) ? read(target) : null
	if (current !== null && current !== read(backup) && (!manifest || sha(current) !== manifest.coreSha)) {
		let save = join(claude, `CLAUDE.md.pre-rollback-${ymd(now)}`)
		for (let i = 2; existsSync(save); i++) save = join(claude, `CLAUDE.md.pre-rollback-${ymd(now)}-${i}`)
		writeFileSync(save, current)
		kept.push(`${save} (CLAUDE.md as it was before this rollback)`)
	}
	const tmp = join(claude, 'CLAUDE.md.wp-rules.tmp')
	writeFileSync(tmp, readFileSync(backup))
	renameSync(tmp, target)
	for (const w of manifest?.written ?? []) {
		const f = join(claude, w.rel)
		if (!isFile(f)) continue
		if (sha(read(f)) === w.sha) {
			rmSync(f)
			removed.push(w.rel)
		} else kept.push(`${w.rel} (edited since apply, left in place)`)
	}
	for (const d of (manifest?.dirs ?? []).slice().reverse()) tryRmdir(d)
	rmSync(join(claude, MANIFEST), { force: true })
	renameSync(backup, `${backup}.restored`)
	return { restored: target, from: backup, removed, kept }
}

// ---- the command ----------------------------------------------------------------------------------

/** `wp-brain rules <split|verify|apply|rollback>`; prints, and returns the exit code. */
export function rulesCommand({ pos, opt, claude, log = console.log }) {
	const [sub] = pos
	const dir = typeof opt.dir === 'string' ? opt.dir : join(claude, 'rule-split')
	try {
		if (sub === 'split') {
			const r = splitRules({ claude, mapPath: typeof opt.map === 'string' ? opt.map : undefined, out: typeof opt.out === 'string' ? opt.out : dir, keepCore: opt['keep-core'] === true, discardCore: opt['discard-core'] === true })
			log(r.summary)
			const v = verifyRules({ dir: r.dir })
			log(verifyReport(v))
			log(`\nNext: wp-brain rules verify --dir ${r.dir}`)
			return v.ok ? 0 : 1
		}
		if (sub === 'verify') {
			const v = verifyRules({ dir })
			log(verifyReport(v))
			return v.ok ? 0 : 1
		}
		if (sub === 'apply') {
			const r = applyRules({ claude, dir, yes: opt.yes === true || opt.yes === 'yes' })
			log(`Applied. The old file is kept as ${r.backup}\nWrote ${r.written.length} rule file${r.written.length === 1 ? '' : 's'}, then CLAUDE.md.\nUndo: wp-brain rules rollback`)
			return 0
		}
		if (sub === 'rollback') {
			const r = rollbackRules({ claude })
			log(`Restored ${r.restored} from ${r.from} (now ${r.from}.restored).\nRemoved ${r.removed.length} rule file${r.removed.length === 1 ? '' : 's'}.`)
			for (const k of r.kept) log(`Kept: ${k}`)
			return 0
		}
		log('Usage: wp-brain rules split --map FILE [--out DIR] [--keep-core | --discard-core] | verify [--dir DIR] | apply --yes [--dir DIR] | rollback')
		return 1
	} catch (e) {
		console.error(e.message)
		return 1
	}
}

// ---- pointers: recall and the guard point at the right rule or skill ---------------------------------
//
// Nothing here prints rule or skill text, only `- Read before acting: <path> (<why>)`. Everything is silent until the owner has a
// rule map (`<claude>/rule-files/rule-map.json`): no map, no rule and no skill pointers, so other installs see no change.

const claudeHome = () => process.env.CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
export const mapPathOf = (claude) => join(claude, 'rule-files', 'rule-map.json')
/** The skills cache: `WP_BRAIN_RULE_INDEX`, else `~/.workpulse/rule-index.json` (which follows HOME). */
const indexPath = () => process.env.WP_BRAIN_RULE_INDEX || join(homedir(), '.workpulse', 'rule-index.json')
const PROMPT_CHARS = 600
const SKILL_WORDS = 60

/** The map as { map } when it reads, { problem } when it is there and broken, {} when there is none. */
function readMap(claude) {
	const path = mapPathOf(claude)
	if (!isFile(path)) return {}
	try {
		const map = JSON.parse(read(path))
		if (!map || !Array.isArray(map.rules)) return { problem: 'has no "rules" list' }
		return { map }
	} catch (e) {
		return { problem: e instanceof SyntaxError ? 'is not valid JSON' : 'cannot be read' }
	}
}

/** For `doctor`: { exists, ok, detail } about the map and what recall can point at. */
export function ruleMapState(claude) {
	const { map, problem } = readMap(claude)
	if (problem) return { exists: true, ok: false, detail: `${mapPathOf(claude)} ${problem}; recall skips rules and skills until it is fixed (wp-brain rules split shows what it expects)` }
	if (!map) return { exists: false, ok: true, detail: 'none' }
	const docs = ruleDocs(claude, map)
	const missing = map.rules.filter((r) => r?.load && r.load !== 'always' && Array.isArray(r.triggers) && r.triggers.length).length - docs.length
	return { exists: true, ok: missing <= 0, detail: `${docs.length} rule${docs.length === 1 ? '' : 's'} on demand${missing > 0 ? `, ${missing} with no file on disk` : ''}` }
}

/** Where a moved rule's text is, under a Claude folder or a staged split laid out like one. */
export const rulePathOf = (claude, r) => (r.load === 'existing' ? join(claude, r.file) : join(claude, r.load === 'path' ? 'rules' : 'rule-files', `${r.slug}.md`))

function ruleDocs(claude, map) {
	const out = []
	for (const r of map.rules) {
		if (!r || typeof r.slug !== 'string' || r.load === 'always') continue
		const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : [])
		const triggers = strings(r.triggers)
		const onCommand = strings([].concat(r.onCommand ?? []))
		if (!triggers.length && !onCommand.length) continue
		if (r.load === 'existing' && (typeof r.file !== 'string' || !/^[\w-][\w.-]*$/.test(r.file))) continue
		const path = rulePathOf(claude, r)
		if (!isFile(path)) continue
		out.push({ kind: 'rule', name: r.slug, path, title: String(r.title || r.slug), triggers, not: strings(r.not), onCommand })
	}
	return out
}

const STOP = new Set(
	'about above after again also always another because been before being both can could does doing done each else even ever every from have here into just like make many more most much must need never only other over same should some such than that their them then there these they this those through under until upon used uses using very want when where which while will with without would your what whenever whether skill skills claude code file files'.split(' '),
)
const stem = (w) => (w.length > 4 ? w.replace(/(?:ing|ed|es|s)$/, '') : w)
const wordsOf = (text) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []

/** The `name` and `description` of a skill's frontmatter (a value may continue on indented lines), or null when there is none. */
function skillFields(text) {
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
	if (!m) return null
	const f = {}
	let key = null
	for (const line of m[1].split(/\r?\n/)) {
		const kv = line.match(/^(name|description):\s*(.*)$/)
		if (kv) {
			key = kv[1]
			f[key] = /^[>|][+-]?$/.test(kv[2].trim()) ? '' : kv[2].trim()
		} else if (/^\s+\S/.test(line) && key) f[key] = `${f[key]} ${line.trim()}`.trim()
		else key = null
	}
	for (const k of Object.keys(f)) f[k] = f[k].replace(/^(["'])([\s\S]*)\1$/, '$2')
	return f
}

function skillDoc(path, folder) {
	let f
	try {
		f = skillFields(read(path))
	} catch {
		return null
	}
	if (!f) return null
	const name = f.name || folder
	const description = f.description ?? ''
	const triggers = [...new Set(wordsOf(description).filter((w) => w.length >= 4 && !STOP.has(w)).map(stem))].slice(0, SKILL_WORDS)
	return { kind: 'skill', name, path, title: description.slice(0, 80), triggers, not: [] }
}

/** The skills in `<claude>/skills`, each parsed once and again only when its SKILL.md changes (cache: see indexPath). */
function skillDocs(claude) {
	const dir = join(claude, 'skills')
	let names = []
	try {
		names = readdirSync(dir).sort()
	} catch {
		return []
	}
	let cache = { claude, skills: {} }
	try {
		const c = JSON.parse(read(indexPath()))
		if (c?.v === 1 && c.claude === claude && c.skills && typeof c.skills === 'object') cache = c
	} catch {
		/* none yet, or unreadable: start again */
	}
	const next = {}
	let changed = false
	const docs = []
	for (const folder of names) {
		const path = join(dir, folder, 'SKILL.md')
		let m
		try {
			m = statSync(path).mtimeMs // follows a symlinked skill folder
		} catch {
			continue
		}
		const old = cache.skills[folder]
		const doc = old && old.m === m ? old.doc : skillDoc(path, folder)
		if (!old || old.m !== m) changed = true
		next[folder] = { m, doc }
		if (doc) docs.push(doc)
	}
	if (changed || Object.keys(next).length !== Object.keys(cache.skills).length) {
		try {
			mkdirSync(dirname(indexPath()), { recursive: true })
			const tmp = `${indexPath()}.${process.pid}.tmp`
			writeFileSync(tmp, JSON.stringify({ v: 1, claude, skills: next }))
			renameSync(tmp, indexPath())
		} catch {
			/* a cache that cannot be written only costs the next run a reread */
		}
	}
	return docs
}

/**
 * What recall can point at: `{ kind: 'rule' | 'skill', name, path, title, triggers, not }[]`. Empty when `claude` has no rule map, so
 * an install that has not opted in gets no pointers. A broken map gives nothing, the same as no map (`doctor` says so).
 */
export function loadDocs(claude = claudeHome()) {
	const { map, problem } = readMap(claude)
	if (!map) return []
	return [...ruleDocs(claude, map), ...skillDocs(claude)]
}

const escapeRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A regex source for a word and its simple inflections: s, es, ed, ing, a doubled final consonant (commit, committing) and a dropped
 * final e (merge, merging); y becomes ies/ied. Not er, y or ly, so `pusher` and `pushy` stay out. Short words and non-letters stay as they are.
 */
export function inflect(word) {
	const w = word.toLowerCase()
	if (w.length < 3 || !/^\p{L}+$/u.test(w)) return `${escapeRe(w)}(?:s|es)?` // short or non-letter words keep only the plural
	const last = w.at(-1)
	if (last === 'e') return `${escapeRe(w.slice(0, -1))}(?:e|es|ed|ing)`
	if (last === 'y' && !/[aeiou]y$/.test(w)) return `(?:${escapeRe(w)}(?:s|ed|ing)?|${escapeRe(w.slice(0, -1))}(?:ies|ied))`
	const dbl = /[^aeiou]/.test(last) && !'wxy'.includes(last) && /[aeiou][^aeiou]$/.test(w) ? `|${escapeRe(w)}${last}(?:ed|ing)` : ''
	return `(?:${escapeRe(w)}(?:s|es|ed|ing)?${dbl})`
}

const phrase = (p) => new RegExp(`(?<![\\p{L}\\p{N}])${p.trim().split(/\s+/).map(inflect).join('\\s+')}(?![\\p{L}\\p{N}])`, 'u')

/**
 * The docs a prompt calls for, rules first and then skills, at most `limit` in all: `{ doc, why }[]`. A rule matches on one of its
 * trigger words or phrases (a `not` phrase is taken out of the prompt first); a skill on every word of its name (a one-word name
 * needs 6 letters) or on two of its description words. Only the first 600 characters count, and a slash command matches nothing.
 */
export function matchDocs(prompt, docs, limit = 2) {
	const text = String(prompt ?? '').slice(0, PROMPT_CHARS).toLowerCase()
	if (!text.trim() || text.trim().startsWith('/')) return []
	const rules = []
	const skills = []
	let words = null
	for (const doc of docs) {
		if (doc.kind === 'rule') {
			let t = text
			for (const n of doc.not ?? []) if (n.trim()) t = t.replace(new RegExp(phrase(n).source, 'gu'), ' ')
			const hit = doc.triggers.find((w) => w.trim() && phrase(w).test(t))
			if (hit) rules.push({ doc, why: hit })
		} else if (doc.kind === 'skill') {
			words ??= new Set(wordsOf(text).map(stem))
			const nameWords = wordsOf(doc.name)
			const byName = nameWords.length > 0 && (nameWords.length > 1 || nameWords[0].length >= 6) && nameWords.every((w) => words.has(stem(w)))
			const hits = doc.triggers.filter((w) => words.has(w))
			if (byName || hits.length >= 2) skills.push({ doc, why: byName ? doc.name : hits.slice(0, 3).join(', '), score: (byName ? 10 : 0) + hits.length })
		}
	}
	skills.sort((a, b) => b.score - a.score)
	return [...rules, ...skills].slice(0, limit).map(({ doc, why }) => ({ doc, why }))
}

/** The id a seen-mark uses for a doc. */
export const markOf = (doc) => `${doc.kind}:${doc.name}`

/** `- Read before acting: <path> (<title>; <why>)`: a pointer, never the text. */
export function pointerLine({ doc, why }) {
	return `- Read before acting: ${doc.path} (${doc.kind === 'skill' ? `skill ${doc.name}` : doc.title}${why ? `; matched ${why}` : ''})`
}

const GUARD_HEADER = 'WorkPulse rules for this command (read the file before running it):'

/**
 * For the guard: pointers for the rules whose `onCommand` starts this command (`argv` is one normalised command, or a list of them),
 * leaving out the ones in `seen` and adding the ones it names to it. Null when there is nothing new, no map, or the map is broken.
 */
export function pointersFor(argv, seen, claude = claudeHome()) {
	const { map } = readMap(claude)
	if (!map) return null
	const commands = Array.isArray(argv[0]) ? argv : [argv]
	const found = []
	for (const doc of ruleDocs(claude, map)) {
		if (seen.has(markOf(doc))) continue
		const on = doc.onCommand.find((p) => commands.some((c) => p.trim().split(/\s+/).every((w, i) => c[i] === w)))
		if (on) found.push({ doc, why: on })
	}
	if (!found.length) return null
	for (const f of found) seen.add(markOf(f.doc))
	return [GUARD_HEADER, ...found.map(pointerLine)].join('\n')
}

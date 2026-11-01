// `wp-brain rules test`: proves every moved rule (any map rule whose `load` is not `always`) still comes up, so the core can stay short.
// Its own file so wp-brain.mjs stays small; rules.mjs stays free of the guard. Node built-ins plus rules.mjs and guard.mjs.
//
// Tests file (`rule-files/rule-tests.json`, in the staged folder, else `--tests FILE`, else the Claude home):
//   { tests: [{ rule, prompt?, file?, command?, gate? }], quiet: [prompt] }
//   prompt   recall's own matcher (loadDocs + matchDocs) must put the rule itself among the pointers it would give
//   file     the rule's `paths` must match this path (path.matchesGlob)
//   command  pointersFor must name the rule for this shell command (parsed with the guard's commandsIn)
//   gate     { command, expect: 'ask' | 'deny' | 'allow' }: the guard's decide must give that; `rule` is optional here
//   quiet    prompts that must bring up no rule at all
// Level 1 spends nothing. `--live` adds level 2: `claude -p` in a temp git repo with an InstructionsLoaded logging hook, which
// needs the split applied for real and spends tokens, so nothing here runs it by itself.
// A pass writes the marker `rules apply` wants (writeTestPass); any failed run removes an earlier one.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'

import { commandsIn, decide, normalise } from './guard.mjs'
import { loadDocs, matchDocs, pointersFor, rulePathOf, writeTestPass } from './rules.mjs'

const short = (s, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const slugOf = (doc) => doc.name

/** path.matchesGlob is experimental; its warning must not reach the output. */
function globMatch(file, pattern) {
	const emit = process.emitWarning
	process.emitWarning = () => {}
	try {
		return path.matchesGlob(file, pattern)
	} finally {
		process.emitWarning = emit
	}
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

// ---- level 2: live ----------------------------------------------------------------------------------

/** The claude call for one prompt: { cmd, args }. `settings` is a settings file that logs InstructionsLoaded. */
export function liveCommand({ prompt, settings }) {
	return { cmd: 'claude', args: ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--settings', settings, '--allowedTools', 'Read', '--max-turns', '4'] }
}

const tailOf = (p) => String(p).split('/').slice(-2).join('/')

/**
 * Did the rule load? ok when the transcript (stream-json lines) holds a Read of the rule file, or the InstructionsLoaded log
 * (one JSON object per line) shows `path_glob_match` for it. Lines that are not JSON are skipped.
 */
export function liveVerdict({ rulePath, transcript = '', log = '' }) {
	const want = tailOf(rulePath)
	const lines = (text) => text.split('\n').flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
	for (const e of lines(transcript))
		for (const c of e?.message?.content ?? []) if (c?.type === 'tool_use' && c.name === 'Read' && typeof c.input?.file_path === 'string' && tailOf(c.input.file_path) === want) return { ok: true, why: 'the transcript shows a Read of the rule file' }
	for (const e of lines(log)) if (e?.load_reason === 'path_glob_match' && typeof e.file_path === 'string' && tailOf(e.file_path) === want) return { ok: true, why: 'InstructionsLoaded logged path_glob_match' }
	return { ok: false, why: 'the rule file was neither read nor loaded by a path match' }
}

function runLive({ prompt, rulePath, file }) {
	const repo = mkdtempSync(join(tmpdir(), 'wp-rules-live-'))
	try {
		execFileSync('git', ['init', '-q', repo])
		if (file) {
			mkdirSync(join(repo, path.dirname(file)), { recursive: true })
			writeFileSync(join(repo, file), '\n')
		}
		const logFile = join(repo, '..', `${path.basename(repo)}.instructions.log`)
		const settings = join(repo, '..', `${path.basename(repo)}.settings.json`)
		writeFileSync(settings, JSON.stringify({ hooks: { InstructionsLoaded: [{ hooks: [{ type: 'command', command: `cat >> '${logFile}'; echo >> '${logFile}'` }] }] } }))
		const { cmd, args } = liveCommand({ prompt: file ? `Open ${file} and reply ok.` : prompt, settings })
		const r = spawnSync(cmd, args, { cwd: repo, encoding: 'utf8', timeout: 180000 })
		if (r.error) return { ok: false, why: `could not run claude: ${r.error.message}` }
		const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
		rmSync(logFile, { force: true })
		rmSync(settings, { force: true })
		return liveVerdict({ rulePath, transcript: r.stdout ?? '', log })
	} finally {
		rmSync(repo, { recursive: true, force: true })
	}
}

// ---- the run ----------------------------------------------------------------------------------------

/** `wp-brain rules test [--dir DIR] [--tests FILE] [--live] [--json]`: prints, and returns the exit code. */
export function rulesTestCommand({ opt, claude, log = console.log }) {
	const dir = typeof opt.dir === 'string' ? opt.dir : join(claude, 'rule-split')
	const results = [] // { rule, kind, ok, label, why? }
	rmSync(join(dir, 'test-pass.json'), { force: true }) // a run that throws or fails leaves no marker
	const fail = (message) => {
		log(message)
		return 1
	}
	let map
	try {
		map = readJson(join(dir, 'rule-files', 'rule-map.json'))
		if (!Array.isArray(map.rules)) throw new Error('no "rules" list')
	} catch (e) {
		return fail(`${dir} has no readable rule-files/rule-map.json (${e.message}); run: wp-brain rules split --map FILE`)
	}
	const candidates = [typeof opt.tests === 'string' ? opt.tests : null, join(dir, 'rule-files', 'rule-tests.json'), join(claude, 'rule-files', 'rule-tests.json')].filter(Boolean)
	const testsPath = candidates.find((p) => existsSync(p))
	let spec
	try {
		if (!testsPath) throw new Error(`looked for ${candidates.join(' and ')}`)
		spec = readJson(testsPath)
		if (!spec || !Array.isArray(spec.tests)) throw new Error('has no "tests" list')
	} catch (e) {
		return fail(`No usable rule-tests.json: ${e.message}`)
	}

	const moved = map.rules.filter((r) => r && typeof r.slug === 'string' && r.load !== 'always')
	const bySlug = new Map(moved.map((r) => [r.slug, r]))
	const docs = loadDocs(dir) // the staged folder is laid out like a Claude home: rule-files/, rules/, rule-map.json
	const add = (rule, kind, ok, label, why) => results.push({ rule, kind, ok, label, why })

	for (const t of spec.tests) {
		if (!t || typeof t !== 'object') {
			add('?', 'unknown', false, 'a test entry that is not an object')
			continue
		}
		const slug = t.rule
		if (slug !== undefined && !bySlug.has(slug)) {
			add(slug ?? '?', 'unknown', false, `rule "${slug}" is not a moved rule in the map`)
			continue
		}
		const r = bySlug.get(slug)
		if (typeof t.prompt === 'string') {
			const hits = matchDocs(t.prompt, docs)
			const ok = hits.some((h) => h.doc.kind === 'rule' && slugOf(h.doc) === slug)
			add(slug, 'prompt', ok, `prompt "${short(t.prompt)}"`, ok ? null : `recall points at ${hits.map((h) => h.doc.name).join(', ') || 'nothing'}`)
		}
		if (typeof t.file === 'string') {
			let ok = false
			let why = null
			try {
				ok = Array.isArray(r?.paths) && r.paths.some((p) => globMatch(t.file, p))
				if (!ok) why = r?.paths?.length ? `paths ${r.paths.join(', ')} do not match` : `${slug} has no paths (load: ${r?.load})`
			} catch (e) {
				why = e.message
			}
			add(slug, 'file', ok, `file ${t.file}`, why)
		}
		if (typeof t.command === 'string') {
			const text = pointersFor(commandsIn(t.command).map(normalise), new Set(), dir) // as the hook does
			const ok = Boolean(text) && text.includes(`/${slug}.md (`)
			add(slug, 'command', ok, `command "${short(t.command)}"`, ok ? null : 'pointersFor does not name the rule')
		}
		if (t.gate && typeof t.gate === 'object') {
			const got = decide({ tool_name: 'Bash', tool_input: { command: t.gate.command }, cwd: dir })?.decision ?? 'allow'
			const ok = got === (t.gate.expect ?? 'ask')
			add(slug, 'gate', ok, `gate "${short(String(t.gate.command))}" expects ${t.gate.expect}`, ok ? null : `the guard gives ${got}`)
		}
	}
	for (const p of Array.isArray(spec.quiet) ? spec.quiet : []) {
		const hits = matchDocs(String(p), docs).filter((h) => h.doc.kind === 'rule')
		add(undefined, 'quiet', hits.length === 0, `quiet "${short(String(p))}"`, hits.length ? `brought up ${hits.map((h) => h.doc.name).join(', ')}` : null)
	}
	for (const r of moved) if (!results.some((x) => x.rule === r.slug)) add(r.slug, 'coverage', false, 'no test', 'a moved rule needs at least one test')

	if (opt.live === true) {
		for (const t of spec.tests) {
			const r = bySlug.get(t?.rule)
			if (!r || typeof t?.prompt !== 'string') continue
			const rulePath = rulePathOf(claude, r)
			const v = runLive({ prompt: t.prompt, rulePath, file: r.load === 'path' && typeof t.file === 'string' ? t.file : null })
			add(r.slug, 'live', v.ok, `live prompt "${short(t.prompt)}"`, v.ok ? null : v.why)
		}
	}

	if (!results.length) add('-', 'empty', false, 'no tests ran', 'the tests file has no tests and no quiet prompts')
	const rules = {}
	for (const x of results.filter((y) => y.rule !== undefined && y.kind !== 'coverage' && y.kind !== 'unknown')) {
		rules[x.rule] ??= { passed: 0, total: 0 }
		rules[x.rule].total++
		if (x.ok) rules[x.rule].passed++
	}
	for (const r of moved) rules[r.slug] ??= { passed: 0, total: 0 }
	const failed = results.filter((x) => !x.ok)
	const passed = results.length - failed.length
	const uncovered = results.filter((x) => x.kind === 'coverage').map((x) => x.rule)
	const keep = [...new Set(failed.filter((x) => bySlug.has(x.rule)).map((x) => x.rule))]
	const ok = results.every((x) => x.ok)

	// The marker is written last, after everything was printed, so a run that throws on the way leaves none.
	const finish = () => {
		if (!ok) return 1
		try {
			writeTestPass(dir, { tests: path.resolve(testsPath) })
		} catch (e) {
			log(`No pass marker: ${e.message}`)
			return 1
		}
		return 0
	}
	if (opt.json === true) {
		log(JSON.stringify({ ok, passed, failed: failed.length, movedRules: moved.length, uncovered, rules, keepAlwaysLoaded: keep, tests: results.map(({ rule, kind, ok: k, label, why }) => ({ rule: rule ?? null, kind, ok: k, label, why: why ?? null })) }, null, 2))
		return finish()
	}
	for (const x of results) {
		log(`${x.ok ? 'pass' : 'fail'}  ${x.rule ?? '-'}  ${x.label}${x.why ? `  (${x.why})` : ''}`)
		if (!x.ok && bySlug.has(x.rule) && results.findIndex((y) => !y.ok && y.rule === x.rule) === results.indexOf(x)) log(`keep always-loaded: ${x.rule}`)
	}
	for (const [slug, c] of Object.entries(rules)) log(`${slug}: ${c.passed}/${c.total}`)
	log(`Result: ${passed} passed, ${failed.length} failed (${moved.length} moved rules, ${uncovered.length} with no test)${ok ? `; pass marker written` : '; no pass marker, rules apply stays locked'}`)
	return finish()
}

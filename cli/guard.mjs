// PreToolUse hook for Bash and Artifact: asks before `git push`, deploys, publishes and commands that discard work,
// and refuses attribution trailers in commits and PRs.
// Node built-ins only and nothing heavy at load: this runs before every Bash call.
//
//   commandsIn(text)   argv lists, quote- and heredoc-aware, entering $(…), backticks and `sh -c '…'`
//   normalise(argv)    drops assignments, wrappers (timeout, env, rtk …), a directory before the command, git's -C / -c
//   ATTRIBUTION        the shapes that are refused (a trailer naming Claude or Anthropic, a Generated-with line)
//   decide(input)      { decision: 'ask' | 'deny', reason } | null; only reads git state
//
// Run as a script it reads the hook JSON on stdin and prints the PreToolUse decision, always exiting 0.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ATTRIBUTION =
	/co-authored-by:[^\n]*(?:claude|anthropic)|noreply@anthropic\.com|generated with \[?claude code\]?/i

// ---- parsing ---------------------------------------------------------------------------------------

// `<<[-]DELIM` at text[i] (the `<<` already confirmed): the delimiter and where it ends.
function readDelim(text, i) {
	i += 2
	const strip = text[i] === '-'
	if (strip) i++
	while (text[i] === ' ' || text[i] === '\t') i++
	let delim = ''
	while (i < text.length && !/[\s;|&<>()]/.test(text[i])) {
		if (text[i] === "'" || text[i] === '"') {
			const j = text.indexOf(text[i], i + 1)
			delim += text.slice(i + 1, j < 0 ? text.length : j)
			i = (j < 0 ? text.length : j) + 1
		} else delim += text[i++]
	}
	return { delim, strip, end: i }
}

// The heredoc body starting at text[i] (just after the newline): its lines and the index after the delimiter line.
function readBody(text, i, p) {
	const lines = []
	while (i < text.length) {
		let e = text.indexOf('\n', i)
		if (e < 0) e = text.length
		const line = text.slice(i, e)
		i = e + 1
		if ((p.strip ? line.replace(/^\t+/, '') : line) === p.delim) break
		lines.push(line)
	}
	return { body: lines.join('\n'), end: i }
}

function matchParen(text, start) {
	let depth = 1
	let i = start
	const pend = []
	while (i < text.length) {
		const c = text[i]
		if (c === "'") i = text.indexOf("'", i + 1) + 1 || text.length
		else if (c === '"') {
			i++
			while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
			i++
		} else if (c === '\\') i += 2
		else if (c === '<' && text[i + 1] === '<' && text[i + 2] !== '<') {
			const d = readDelim(text, i)
			pend.push(d)
			i = d.end
		} else if (c === '\n' && pend.length) {
			i++
			for (const p of pend.splice(0)) i = readBody(text, i, p).end
		} else {
			if (c === '(') depth++
			else if (c === ')' && --depth === 0) return { inner: text.slice(start, i), end: i + 1 }
			i++
		}
	}
	UNREAD ??= OPEN_QUOTES
	return { inner: text.slice(start), end: text.length }
}

function backtick(text, start) {
	let i = start
	while (i < text.length && text[i] !== '`') i += text[i] === '\\' ? 2 : 1
	if (i >= text.length) UNREAD ??= OPEN_QUOTES
	return { inner: text.slice(start, i).replace(/\\`/g, '`'), end: i + 1 }
}

// Commands as { argv, stdin } where stdin is a heredoc body. Nested commands come out as their own entries.
// Put in front of text that came out of $( ) or backticks, so a command word made by a substitution can be told from a literal one.
const MARK = '\u0001'

// Why the text could not be read to the end: quotes, $( ) or backticks left open, or nesting past the limit. decide() resets it per command line.
let UNREAD = null
const OPEN_QUOTES = 'unbalanced quotes'
const TOO_DEEP = 'nested too deep'

// Words that may stand before a command, so a `((` after them is still at the start of one.
const BEFORE_COMMAND = new Set(['if', 'elif', 'while', 'until', 'then', 'else', 'do', 'for', '!', '{', 'time'])

// `((` at text[i]. Bash reads it as arithmetic only when the paren closing the second `(` is followed at once by `)`; else it is nested
// subshells (null). Quotes hide parens, as in bash. The $( ) and backticks inside run, quoted or not (zsh runs them even in single quotes).
function arithSpan(text, i) {
	const subs = []
	const isSub = (j) => text[j] === '`' || (text[j] === '$' && text[j + 1] === '(')
	const sub = (j) => {
		const arith = text[j] === '$' && text[j + 2] === '(' && arithSpan(text, j + 1)
		if (arith) {
			subs.push(...arith.subs)
			return arith.end
		}
		const m = text[j] === '`' ? backtick(text, j + 1) : matchParen(text, j + 2)
		subs.push(m.inner)
		return m.end
	}
	let depth = 1
	let j = i + 2
	while (j < text.length) {
		const c = text[j]
		if (c === '\\') j += 2
		else if (isSub(j)) j = sub(j)
		else if (c === "'" || c === '"') {
			j++
			while (j < text.length && text[j] !== c) {
				if (c === '"' && text[j] === '\\') j += 2
				else if (isSub(j)) j = sub(j)
				else j++
			}
			j++
		} else {
			if (c === '(') depth++
			else if (c === ')' && --depth === 0) return text[j + 1] === ')' ? { end: j + 2, subs } : null
			j++
		}
	}
	UNREAD ??= OPEN_QUOTES
	return null
}

function parse(text, depth = 0, cd0 = []) {
	const out = []
	const pending = []
	const cdStack = []
	let cd = cd0
	let redirect = false
	let cmd = { argv: [], stdin: '', cd }
	let word = null
	let hereString = false
	const endWord = () => {
		if (word !== null) {
			if (hereString) {
				cmd.stdin += `${word}\n`
				hereString = false
				redirect = false
			} else if (redirect) redirect = false
			else cmd.argv.push(word)
		}
		word = null
	}
	// Ends the command; returns it when it had words.
	const endCmd = () => {
		endWord()
		const done = cmd.argv.length ? cmd : null
		if (done) {
			out.push(cmd)
			const a = strip(cmd.argv).argv
			if (a[0] === 'cd' && a[1] !== '-') cd = [...cd, a[1] ?? process.env.HOME ?? '.']
		}
		redirect = false
		hereString = false
		cmd = { argv: [], stdin: '', cd }
		return done
	}
	const absorb = (inner) => {
		if (depth > 6) {
			UNREAD ??= TOO_DEEP
			return ''
		}
		const sub = expand(parse(inner, depth + 1, cd), depth + 1)
		out.push(...sub)
		return MARK + sub.map((c) => `${c.argv.join(' ')} ${c.stdin}`).join(' ')
	}
	let i = 0
	let span = null
	const n = text.length
	// $( at text[i]: $(( … )) is arithmetic, so only the substitutions inside it are commands.
	const dollar = () => {
		const arith = text[i + 2] === '(' && arithSpan(text, i + 1)
		if (arith) {
			for (const inner of arith.subs) absorb(inner)
			i = arith.end
			return MARK
		}
		const m = matchParen(text, i + 2)
		i = m.end
		return absorb(m.inner)
	}
	while (i < n) {
		const c = text[i]
		if (c === "'") {
			const j = text.indexOf("'", i + 1)
			const end = j < 0 ? n : j
			if (j < 0) UNREAD ??= OPEN_QUOTES
			word = (word ?? '') + text.slice(i + 1, end)
			i = end + 1
		} else if (c === '"') {
			word ??= ''
			i++
			while (i < n && text[i] !== '"') {
				const ch = text[i]
				if (ch === '\\' && i + 1 < n) {
					word += '"\\$`'.includes(text[i + 1]) ? text[i + 1] : `\\${text[i + 1]}`
					i += 2
				} else if (ch === '$' && text[i + 1] === '(') {
					word += dollar()
				} else if (ch === '`') {
					const m = backtick(text, i + 1)
					word += absorb(m.inner)
					i = m.end
				} else {
					word += ch
					i++
				}
			}
			if (i >= n) UNREAD ??= OPEN_QUOTES
			i++
		} else if (c === '\\') {
			if (text[i + 1] !== '\n') word = (word ?? '') + (text[i + 1] ?? '')
			i += 2
		} else if (c === '$' && text[i + 1] === '(') {
			word = (word ?? '') + dollar()
		} else if (c === '`') {
			const m = backtick(text, i + 1)
			word = (word ?? '') + absorb(m.inner)
			i = m.end
		} else if (c === '#' && word === null) {
			while (i < n && text[i] !== '\n') i++
		} else if (c === ' ' || c === '\t' || c === '\r') {
			endWord()
			i++
		} else if (c === '\n') {
			endCmd()
			i++
			for (const p of pending.splice(0)) {
				const r = readBody(text, i, p)
				p.cmd.stdin = r.body
				i = r.end
			}
		} else if (c === '(' && text[i + 1] === '(' && word === null && cmd.argv.every((w) => BEFORE_COMMAND.has(w)) && (span = arithSpan(text, i))) {
			for (const inner of span.subs) absorb(inner)
			i = span.end // (( … )) is arithmetic: a `<<` inside it is a shift, not a heredoc
		} else if (c === ';' || c === '|' || c === '(' || c === ')') {
			const prev = endCmd()
			if (c === '(') cdStack.push(cd)
			else if (c === ')' && cdStack.length) cd = cdStack.pop()
			cmd.cd = cd
			// What a pipe carries is what the left side wrote on its command line, so `echo msg | git commit -F -` can be read.
			if (c === '|' && text[i + 1] !== '|' && prev) {
				cmd.piped = true
				cmd.stdin = `${prev.argv.slice(1).join(' ')}\n${prev.stdin}`
			}
			i += c === '|' && (text[i + 1] === '|' || text[i + 1] === '&') ? 2 : 1
		} else if (c === '&') {
			if (text[i + 1] === '>') {
				endWord()
				i += text[i + 2] === '>' ? 3 : 2
				redirect = true
			} else {
				endCmd()
				i += text[i + 1] === '&' ? 2 : 1
			}
		} else if (c === '<' && text[i + 1] === '<' && text[i + 2] !== '<') {
			endWord()
			const d = readDelim(text, i)
			i = d.end
			pending.push({ cmd, delim: d.delim, strip: d.strip })
		} else if (c === '<' && text.startsWith('<<<', i)) {
			endWord()
			i += 3
			hereString = true
		} else if (c === '>' || c === '<') {
			if (word !== null && /^\d+$/.test(word)) word = null
			else endWord()
			while (text[i] === '>' || text[i] === '<') i++
			if (text[i] === '&' || text[i] === '|') i++
			redirect = true
		} else {
			word = (word ?? '') + c
			i++
		}
	}
	endCmd()
	return out
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish', 'ksh'])

// Add the commands inside `sh -c '…'` and `eval …`.
function expand(cmds, depth = 0) {
	const out = []
	for (const c of cmds) {
		out.push(c)
		const inner = (t) => {
			if (depth <= 6) return expand(parse(t, depth + 1, c.cd), depth + 1)
			UNREAD ??= TOO_DEEP
			return []
		}
		const a = strip(c.argv).argv
		const base = a[0]?.split('/').at(-1)
		if (SHELLS.has(base)) {
			const k = a.findIndex((x, idx) => idx > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(x))
			if (k > 0 && a[k + 1] != null) out.push(...inner(a[k + 1]))
			else if (k < 0 && !a.slice(1).some((x) => !x.startsWith('-'))) {
				// A shell with no -c and no script reads commands from its input.
				if (c.stdin.trim()) out.push(...inner(c.stdin))
				if (c.piped) c.pipedShell = true
			}
		} else if (base === 'eval' && a.length > 1) out.push(...inner(a.slice(1).join(' ')))
	}
	return out
}

export const commandsIn = (text) => expand(parse(String(text ?? ''))).map((c) => c.argv.map((w) => w.replaceAll(MARK, '')))

// ---- normalising -----------------------------------------------------------------------------------

const RESERVED = new Set(['if', 'then', 'elif', 'else', 'do', 'while', 'until', '!', '{', 'exec'])
// git options that take their value as the next word
const GIT_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])

const splitWords = (v) => String(v).split(/\s+/).filter(Boolean)
// Tools a package runner (npx, yarn …) can start that the guard has rules for.
const RUNNABLE = new Set(['vercel', 'supabase', 'firebase', 'asc', 'gh', 'git'])
// Drops the leading options of a wrapper, and the value of the ones in `valued`; a bare `--` ends them.
function skipOptions(a, valued) {
	while (a[0]?.startsWith('-')) {
		const f = a.shift()
		if (f === '--') break
		if (valued.test(f)) a.shift()
	}
}

// Package managers that start a binary: `pnpm vercel …`, `pnpm --filter x exec vercel …`, `yarn dlx vercel …`.
// npm has no shorthand, only exec / x. Returns how many leading words to drop, or null when it is not a runner.
const PKG = new Set(['pnpm', 'npm', 'bun', 'yarn'])
const PKG_VALUE = /^(--filter|-F|--prefix|-C|--dir|--workspace|--cwd)$/
function pkgRun(base, a) {
	let j = 1
	while (a[j]?.startsWith('-') && a[j] !== '--') j += PKG_VALUE.test(a[j]) ? 2 : 1
	if (['exec', 'dlx', 'x'].includes(a[j])) return { drop: j + 1, runner: true }
	if (base !== 'npm' && RUNNABLE.has(a[j])) return { drop: j, runner: false }
	return null
}

function strip(argv) {
	const a = [...argv]
	const dirs = []
	for (let guard = 0; guard < 25 && a.length; guard++) {
		const w = a[0]
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
			a.shift()
			continue
		}
		if (RESERVED.has(w)) {
			a.shift()
			continue
		}
		if (w === 'function' && a.length > 1) {
			a.splice(0, 2) // function NAME { body }: the body is what runs
			continue
		}
		const base = w.split('/').at(-1)
		if (base === 'git') break
		if (base === 'timeout' || base === 'gtimeout') {
			a.shift()
			while (a[0]?.startsWith('-')) if (/^(-s|-k|--signal|--kill-after)$/.test(a.shift())) a.shift()
			a.shift()
		} else if (base === 'nice') {
			a.shift()
			if (a[0] === '-n' || a[0] === '--adjustment') a.splice(0, 2)
			else if (/^(-n\d+|-\d+|--adjustment=.*)$/.test(a[0] ?? '')) a.shift()
		} else if (base === 'stdbuf') {
			a.shift()
			while (a[0]?.startsWith('-')) if (a.shift().length === 2) a.shift()
		} else if (base === 'env') {
			a.shift()
			while (a[0] && (a[0].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0]))) {
				const f = a.shift()
				if (/^(-S|--split-string)$/.test(f)) a.unshift(...splitWords(a.shift() ?? ''))
				else if (/^-S./.test(f) || f.startsWith('--split-string=')) a.unshift(...splitWords(f.startsWith('--') ? f.slice(15) : f.slice(2)))
				else if (/^(-u|-C|--unset|--chdir)$/.test(f)) a.shift()
			}
		} else if (base === 'sudo' || base === 'doas') {
			a.shift()
			skipOptions(a, /^(-u|-g|-h|-p|-C|-D|-R|-r|-t|-T|--user|--group|--host|--prompt|--chdir|--role|--type)$/)
		} else if (base === 'xargs') {
			a.shift()
			skipOptions(a, /^(-I|-L|-n|-P|-s|-d|-E|-a|-J|--max-args|--max-procs|--max-lines|--delimiter|--arg-file|--max-chars)$/)
		} else if (base === 'watch') {
			a.shift()
			skipOptions(a, /^(-n|--interval)$/)
		} else if (base === 'npx' || base === 'bunx') {
			a.shift()
			skipOptions(a, /^(-p|--package|--call)$/)
		} else if (PKG.has(base) && pkgRun(base, a)) {
			const { drop, runner } = pkgRun(base, a)
			a.splice(0, drop)
			if (runner) skipOptions(a, /^(-p|--package|--call)$/)
		} else if (base === 'rtk') {
			a.shift()
			if (a[0] === 'proxy') a.shift()
		} else if (base === 'command' && /^-[vV]$/.test(a[1] ?? '')) {
			break // `command -v vercel` only looks the command up
		} else if (['time', 'nohup', 'command', 'builtin', 'noglob'].includes(base)) {
			a.shift()
			while (a[0]?.startsWith('-') && base !== 'nohup') a.shift()
		} else break
	}
	if (a[0]?.includes('/') && a[0].split('/').at(-1)) a[0] = a[0].split('/').at(-1)
	if (a[0] === 'vc') a[0] = 'vercel' // Vercel's short binary name
	if (a[0] === 'git') {
		while (a[1]?.startsWith('-')) {
			if (a[1] === '-C') dirs.push(a[2] ?? '.')
			a.splice(1, GIT_VALUE.has(a[1]) ? 2 : 1)
		}
	}
	return { argv: a, dirs }
}

export const normalise = (argv) => strip(argv).argv

// ---- git state -------------------------------------------------------------------------------------

// All the git calls of one command line share this, so a slow git can't outlive the hook (timeout 5 s in setup.mjs): a command
// the guard can't scan in time still gets its ask. SIGKILL, because a git stuck on a lock or a network may not heed SIGTERM.
const GIT_BUDGET_MS = 3500
let gitDeadline = 0

function git(cwd, args) {
	const left = gitDeadline - Date.now()
	if (left <= 0) throw new Error('out of time')
	return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: left, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'] })
}

const PUSH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])

function pushRanges(cwd, args) {
	const pos = []
	for (let k = 2; k < args.length; k++) {
		if (PUSH_VALUE.has(args[k])) k++
		else if (!args[k].startsWith('-')) pos.push(args[k])
	}
	const ranges = []
	for (const spec of pos.slice(1)) {
		const src = spec.replace(/^\+/, '').split(':')[0]
		if (src && !spec.replace(/^\+/, '').startsWith(':')) ranges.push([src, '--not', '--remotes'])
	}
	if (args.includes('--all') || args.includes('--mirror')) ranges.push(['--branches', '--not', '--remotes'])
	let upstream = true
	try {
		git(cwd, ['rev-parse', '--verify', '-q', '@{u}'])
	} catch {
		upstream = false
	}
	if (!pos.slice(1).length) ranges.push(upstream ? ['@{u}..HEAD', '--not', '--remotes'] : ['HEAD', '--not', '--remotes'])
	else ranges.push(['HEAD', '--not', '--remotes'])
	return ranges
}

function pushScan(argv, _c, { cwd }) {
	const bad = []
	let failed = false
	let ranges = []
	try {
		ranges = pushRanges(cwd, argv)
	} catch {
		failed = true
	}
	for (const r of ranges) {
		try {
			const log = git(cwd, ['log', '--format=%h%x1f%B%x1e', '--abbrev=7', ...r])
			for (const rec of log.split('\x1e')) {
				const [sha, ...msg] = rec.trim().split('\x1f')
				if (sha && ATTRIBUTION.test(msg.join('\x1f')) && !bad.includes(sha)) bad.push(sha)
			}
		} catch {
			failed = true
		}
	}
	if (bad.length)
		return {
			decision: 'deny',
			reason: `Unpushed commit ${bad.join(', ')} carries an attribution trailer (Co-Authored-By naming Claude or Anthropic, or a Generated-with line). Reword it before pushing.`,
		}
	if (failed || !ranges.length)
		return { decision: 'ask', reason: 'git push needs your yes. (Could not scan the unpushed commits for attribution trailers.)' }
	return { decision: 'ask', reason: 'git push needs your yes.' }
}

const flagsOf = (argv) => {
	const i = argv.indexOf('--')
	return argv.slice(1, i < 0 ? undefined : i)
}
// `--long` given, or one of `letters` in a short cluster such as -fd.
const hasFlag = (argv, long, letters) =>
	flagsOf(argv).some((a) => a === long || a.startsWith(`${long}=`) || (/^-[a-zA-Z]+$/.test(a) && [...letters].some((l) => a.includes(l))))

function pushRule(argv, c, ctx) {
	const d = pushScan(argv, c, ctx)
	const forced = hasFlag(argv, '--force', 'f') || flagsOf(argv).some((a) => a.startsWith('--force-with-lease')) || argv.slice(2).some((a) => /^\+[^+]/.test(a))
	if (forced && d.decision === 'ask') d.reason = d.reason.replace('git push needs your yes.', 'git push --force can overwrite history on the remote and needs your yes.')
	return d
}

// ---- messages --------------------------------------------------------------------------------------

const DENY = {
	decision: 'deny',
	reason:
		'This message carries an attribution trailer (Co-Authored-By naming Claude or Anthropic, noreply@anthropic.com, or a Generated-with line). Commits and PRs must read as the owner\'s own work: remove it.',
}

function readFile(name, cwd, stdin) {
	if (name === '-') return stdin
	try {
		return readFileSync(resolve(cwd, name), 'utf8')
	} catch {
		return ''
	}
}

// Walks argv for options: valueFlags (short/long) take the next word, `=value` and `-mTEXT` forms are accepted.
function optionValues(args, { short, long, fileShort, fileLong }, cwd, stdin) {
	const texts = []
	for (let i = 2; i < args.length; i++) {
		const a = args[i]
		let m
		if (long.includes(a) || /^-[a-zA-Z]*[mbt]$/.test(a) && short.includes(a.at(-1))) texts.push(args[++i] ?? '')
		else if (fileLong.includes(a) || /^-[a-zA-Z]*[FfC]$/.test(a) && fileShort.includes(a.at(-1)))
			texts.push(readFile(args[++i] ?? '', cwd, stdin))
		else if ((m = /^--([a-z-]+)=([\s\S]*)$/.exec(a))) {
			if (long.includes(`--${m[1]}`)) texts.push(m[2])
			else if (fileLong.includes(`--${m[1]}`)) texts.push(readFile(m[2], cwd, stdin))
		} else if (a.length > 2 && a[0] === '-' && a[1] !== '-') {
			if (short.includes(a[1])) texts.push(a.slice(2))
			else if (fileShort.includes(a[1])) texts.push(readFile(a.slice(2), cwd, stdin))
		}
	}
	return texts.join('\n')
}

const commitRule = (argv, c, { cwd }) =>
	ATTRIBUTION.test(
		optionValues(argv, { short: ['m'], long: ['--message'], fileShort: ['F'], fileLong: ['--file'] }, cwd, c.stdin),
	)
		? DENY
		: null

const prRule = (argv, c, { cwd }) =>
	ATTRIBUTION.test(
		optionValues(argv, { short: ['b', 't'], long: ['--body', '--title', '--subject'], fileShort: ['F'], fileLong: ['--body-file'] }, cwd, c.stdin),
	)
		? DENY
		: null

const needsYes = (what) => ({ decision: 'ask', reason: `${what} needs your yes.` })
const prAsk = (what) => (argv, c, ctx) => prRule(argv, c, ctx) ?? needsYes(what)

// The words of a command that are not flags, skipping the value of the flags in `valued`.
function words(argv, valued = []) {
	const out = []
	for (let i = 1; i < argv.length; i++) {
		if (valued.includes(argv[i])) i++
		else if (!argv[i].startsWith('-')) out.push(argv[i])
	}
	return out
}
// Every word of a command that is not a flag, up to a bare `--`, flag values included: the subcommand is among them
// wherever the tool's own options put it.
const plain = (argv) => {
	const i = argv.indexOf('--')
	return argv.slice(1, i < 0 ? undefined : i).filter((a) => !a.startsWith('-'))
}
const has = (list, ...seq) => list.some((_, k) => seq.every((w, j) => list[k + j] === w))
// `seq` in this order, with any words between: `plain` keeps flag values, so `db --db-url u push` has one there.
const inOrder = (list, ...seq) => {
	let at = 0
	return seq.every((w) => (at = list.indexOf(w, at) + 1) > 0)
}
// gh's words with its flags and their values gone: `gh pr -R o/r merge` is pr, merge. Only -R and --hostname come before a subcommand.
const GH_VALUE = new Set(['-R', '--repo', '--hostname'])
function ghWords(argv) {
	const out = []
	for (let i = 1; i < argv.length && argv[i] !== '--'; i++) {
		if (GH_VALUE.has(argv[i])) i++
		else if (!argv[i].startsWith('-')) out.push(argv[i])
	}
	return out
}
const starts = (argv, valued, ...want) => want.every((w, i) => words(argv, valued)[i] === w)

// Vercel: a deploy is `vercel`, `vercel <dir>`, `vercel deploy`, anything with --prod/--target. Only these subcommands are known not to deploy.
const VERCEL_QUIET = new Set([
	'env', 'ls', 'list', 'link', 'unlink', 'logs', 'whoami', 'login', 'logout', 'pull', 'build', 'dev', 'inspect', 'help', 'open',
	'switch', 'teams', 'projects', 'domains', 'dns', 'certs', 'telemetry', 'curl', 'httpstat', 'bisect', 'install', 'git', 'webhooks', 'cache', 'blob',
])
const vercelRule = (argv) => {
	const w = words(argv, ['--token', '-t', '--scope', '-S', '--cwd', '--local-config', '-A', '--global-config', '-Q'])
	const info = argv.some((a) => ['--version', '-v', '--help', '-h'].includes(a))
	if (argv.includes('--prod') || argv.includes('--production') || argv.some((a) => a === '--target' || a.startsWith('--target='))) return needsYes('A Vercel deploy')
	if (!w.length) return info ? null : needsYes('A Vercel deploy')
	return VERCEL_QUIET.has(w[0]) ? null : needsYes('A Vercel deploy')
}
const supabaseRule = (argv) => {
	const p = plain(argv)
	if (inOrder(p, 'functions', 'deploy')) return needsYes('supabase functions deploy')
	return inOrder(p, 'db', 'push') ? needsYes('supabase db push') : null
}
const ascRule = (argv) => {
	const p = plain(argv)
	if (inOrder(p, 'builds', 'upload')) return needsYes('asc builds upload')
	return p.includes('publish') ? needsYes('asc publish') : null
}
const publishRule = (argv) => (plain(argv).includes('publish') ? needsYes(`${argv[0]} publish`) : null)
const firebaseRule = (argv) => (plain(argv).includes('deploy') ? needsYes('firebase deploy') : null)

const discard = (what) => needsYes(`${what} throws work away, so it`)
const resetRule = (argv) => (hasFlag(argv, '--hard', '') ? discard('git reset --hard') : null)
const checkoutRule = (argv) => (hasFlag(argv, '--force', 'f') ? discard('git checkout --force') : null)
const cleanRule = (argv) => (hasFlag(argv, '--force', 'f') ? discard('git clean -f') : null)
const branchRule = (argv) => (hasFlag(argv, '--force', 'f') ? discard('git branch --force') : null)

const TOOL_RULES = { vercel: vercelRule, supabase: supabaseRule, asc: ascRule, npm: publishRule, pnpm: publishRule, yarn: publishRule, bun: publishRule, firebase: firebaseRule }

// Artifact tool: publish (also when the action is left out) and delete reach claude.ai; list, read and open do not.
const ARTIFACT_QUIET = new Set(['list', 'read', 'open', 'pin', 'unpin', 'quickstart'])
function artifactRule(input) {
	const action = input?.action
	if (typeof action === 'string' && ARTIFACT_QUIET.has(action)) return null
	return needsYes(action === 'delete' ? 'Deleting an artifact from claude.ai' : 'Publishing an artifact to claude.ai')
}

// One row per gated command. Key: `git <sub>` or `gh <group> <sub>`; the other tools are in TOOL_RULES by name.
const RULES = {
	'git push': pushRule,
	'git commit': commitRule,
	'gh pr create': prAsk('gh pr create'),
	'gh pr merge': prAsk('gh pr merge'),
	'gh pr edit': prRule,
	'gh pr comment': prRule,
	'git reset': resetRule,
	'git checkout': checkoutRule,
	'git clean': cleanRule,
	'git branch': branchRule,
}
function ruleFor(argv) {
	if (argv[0] === 'gh') {
		const p = ghWords(argv) // -R o/r pr merge: the group and subcommand follow the options
		for (let k = 0; k + 1 < p.length; k++) if (RULES[`gh ${p[k]} ${p[k + 1]}`]) return RULES[`gh ${p[k]} ${p[k + 1]}`]
		return undefined
	}
	return RULES[argv.slice(0, 2).join(' ')] ?? TOOL_RULES[argv[0]]
}

// Words that make a command worth a second look. LOOSE is the cheap pre-filter (a substring is enough); WORD must stand alone.
const GATED_LOOSE = /git|gh|vercel|supabase|asc|npm|pnpm|firebase|push|deploy|publish|merge|upload|create|commit|clean|checkout|branch|--prod|--hard|--force/
const GATED_WORD = /(?:^|[^\w-])(?:git|gh|vercel|supabase|asc|npm|pnpm|firebase|push|deploy|publish|merge|upload|create)(?![\w-])|--hard|--force/
// Commands whose real command comes from somewhere the guard cannot see.
const INDIRECT = new Set(['su', 'runuser', 'setsid', 'ionice', 'chroot', 'parallel', 'flock', 'script'])
// Words that gate only through their own subcommand or flag: they count when the command word itself is an expansion.
const GATED_EXPANDED = /(?:^|[^\w-])(?:commit|clean|checkout|branch)(?![\w-])|--prod/
const expanded = (w) => !!w && (w.includes('$') || w.includes(MARK))
// Commands that only read, print or install the words they are given; none of those words is run as a command.
const WORDS_ONLY = new Set(
	('echo printf grep egrep fgrep rg ag ack cat bat less more head tail wc sort uniq cut tr sed awk diff cmp ls ll tree stat file touch ' +
		'mkdir rmdir rm mv cp ln chmod chown tee open code vim vi nvim nano emacs jq which type whereis whatis man info help tldr ' +
		'brew apt apt-get dpkg yum dnf pip pip3 pipx gem cargo go say alias export set unset read test [ true false basename dirname ' +
		'realpath readlink printenv git gh').split(' '),
)
/**
 * An unknown wrapper (gtimeout, caffeinate, arch, op run --, find -exec …) in front of a gated command: when the command word has
 * no rule of its own, look for a gated command that starts at a later word. A quoted `"git push"` is one word, so it never matches.
 */
function inWrapper(argv) {
	if (!argv[0] || WORDS_ONLY.has(argv[0])) return null
	for (let k = 1; k < argv.length; k++) {
		const t = strip(argv.slice(k))
		if (t.argv.length < 2) continue // a bare `vercel` after `brew install` is a name, not a deploy
		const rule = ruleFor(t.argv)
		if (rule) return { rule, argv: t.argv, dirs: t.dirs }
	}
	return null
}

/** A git alias set for this one command: what it runs is in the config value, not in the words after `git`. */
function gitAlias(raw, argv) {
	if (argv[0] !== 'git' && (WORDS_ONLY.has(argv[0]) || !raw.some((w) => w.split('/').at(-1) === 'git'))) return false
	const gated = (t) => GATED_WORD.test(t) || GATED_EXPANDED.test(t)
	return raw.some((w, k) => {
		const next = raw[k + 1] ?? ''
		if (w === '-c' && /^alias\./i.test(next)) return gated(next)
		if (w === '--config-env') return /^alias\./i.test(next) // its value is in the environment: unseen
		return /^--config-env=alias\./i.test(w) || /^GIT_CONFIG_KEY_\d+=alias\./i.test(w) || /^GIT_CONFIG_PARAMETERS=.*alias\./i.test(w)
	})
}

/** `$IFS` splits one word into a command and its arguments, so the words the guard read are not the ones that run. */
function ifsInCommand(raw, argv) {
	const ifs = (w) => /\$\{?IFS\b/.test(w)
	if (argv[0] !== 'git') return ifs(argv[0] ?? '')
	const after = raw.slice(raw.findIndex((w) => w.split('/').at(-1) === 'git') + 1)
	const sub = after.findIndex((w) => !w.startsWith('-'))
	return after.slice(0, sub < 0 ? undefined : sub + 1).some(ifs)
}

/** Why the guard cannot tell what this command runs, or null. Only the command's own words (the whole line for `eval $x`) are tested. */
function unreadable(argv, text) {
	const own = argv.join(' ').replaceAll(MARK, '')
	const gated = (t) => GATED_WORD.test(t) || GATED_EXPANDED.test(t)
	if (expanded(argv[0]) || (['git', 'gh'].includes(argv[0]) && expanded(argv[1])))
		return gated(own) ? 'the command word is an expansion' : null
	if (argv[0] === 'eval' && argv.slice(1).some((w) => w.startsWith('$'))) return GATED_WORD.test(text) ? 'eval runs a variable' : null
	if (INDIRECT.has(argv[0]) || argv[0]?.startsWith('-')) return GATED_WORD.test(own) ? `it runs another command through ${argv[0]}` : null
	return null
}
const cannotRead = (why) => ({ decision: 'ask', reason: `The guard couldn't read this command (${why}) and it mentions a gated action, so it needs your yes.` })

export function decide({ tool_name, tool_input, cwd } = {}) {
	if (tool_name === 'Artifact') return artifactRule(tool_input)
	if (tool_name !== 'Bash') return null
	const text = tool_input?.command
	if (typeof text !== 'string' || !GATED_LOOSE.test(text.replace(/['"\\]/g, ''))) return null // gi""t and g\it are git
	let ask = null
	UNREAD = null
	gitDeadline = Date.now() + GIT_BUDGET_MS
	const cmds = expand(parse(text))
	for (const c of cmds) {
		const first = strip(c.argv)
		let { argv, dirs } = first
		let rule = ruleFor(argv)
		if (!rule) {
			const w = inWrapper(argv)
			if (w) ({ rule, argv, dirs } = { rule: w.rule, argv: w.argv, dirs: [...first.dirs, ...w.dirs] })
		}
		const own = c.argv.join(' ')
		const why =
			c.pipedShell && GATED_WORD.test(text) ? 'a shell reads its commands from a pipe'
			: gitAlias(c.argv, first.argv) ? 'a git alias set on the command line'
			: ifsInCommand(c.argv, first.argv) && (GATED_WORD.test(own) || GATED_EXPANDED.test(own)) ? '$IFS in the command word'
			: rule ? null
			: unreadable(argv, text)
		if (why) ask ??= cannotRead(why)
		const dir = [...(c.cd ?? []), ...dirs].reduce((p, d) => resolve(p, d), cwd || process.cwd())
		const d = rule?.(argv, c, { cwd: dir })
		if (d?.decision === 'deny') return d
		ask ??= d
	}
	if (!ask && UNREAD && GATED_WORD.test(text)) ask = cannotRead(UNREAD)
	return ask ?? null
}

// ---- hook entry point ------------------------------------------------------------------------------

// ---- pointing at rules --------------------------------------------------------------------------------

/** The normalised argv of every command in a Bash command line. */
function commandsOf(text) {
	return expand(parse(text)).map((c) => strip(c.argv).argv)
}

/**
 * A short reminder of the rules whose `onCommand` fits this command, once per session and agent, or null. Cheap first: without a
 * rule map, or when no `onCommand` word appears in the command, rules.mjs is never imported.
 */
async function ruleHint(input) {
	const text = input?.tool_input?.command
	if (input?.tool_name !== 'Bash' || typeof text !== 'string') return null
	const claude = process.env.CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
	const mapPath = join(claude, 'rule-files', 'rule-map.json')
	if (!existsSync(mapPath)) return null
	const prefixes = []
	for (const r of JSON.parse(readFileSync(mapPath, 'utf8')).rules ?? [])
		for (const c of [].concat(r?.onCommand ?? [])) if (typeof c === 'string' && c.trim()) prefixes.push(c.trim().split(/\s+/))
	if (!prefixes.some((p) => text.includes(p[0]))) return null
	const commands = commandsOf(text)
	if (!commands.some((c) => prefixes.some((p) => p.every((w, i) => c[i] === w)))) return null
	const { pointersFor } = await import('./rules.mjs')
	const id = (v) => (typeof v === 'string' && /^[\w-]+$/.test(v) ? v : null)
	const session = id(input.session_id)
	const sessions = process.env.WP_BRAIN_SESSIONS || join(homedir(), '.workpulse', 'sessions')
	// The main agent shares recall's file, so a rule recall already showed is not repeated; each subagent has its own.
	const file = session ? join(sessions, `${session}.rules${id(input.agent_id) ? `.${id(input.agent_id)}` : ''}.json`) : null
	let marks = []
	try {
		if (file && existsSync(file)) marks = JSON.parse(readFileSync(file, 'utf8'))
	} catch {
		/* unreadable marks: start again */
	}
	const seen = new Set(marks)
	const hint = pointersFor(commands, seen, claude)
	if (hint && file) {
		try {
			mkdirSync(sessions, { recursive: true })
			writeFileSync(file, JSON.stringify([...seen]))
		} catch {
			/* the pointer is still given; it may repeat */
		}
	}
	return hint
}

async function main() {
	let input
	try {
		input = JSON.parse(readFileSync(0, 'utf8'))
	} catch {
		return
	}
	let d = null
	try {
		d = decide(input)
	} catch {
		if (input?.tool_name === 'Artifact' || GATED_LOOSE.test(String(input?.tool_input?.command ?? '')))
			d = { decision: 'ask', reason: 'This action needs your yes. (The guard hit an internal error.)' }
	}
	let hint = null
	if (d?.decision !== 'deny') {
		try {
			hint = await ruleHint(input)
		} catch {
			/* a broken map or rule file never changes what the guard decides */
		}
	}
	if (d || hint)
		process.stdout.write(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: 'PreToolUse',
					...(d && { permissionDecision: d.decision, permissionDecisionReason: d.reason }),
					...(hint && { additionalContext: hint }),
				},
			}),
		)
}

let entry = false
try {
	entry = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
} catch {}
if (entry) await main()

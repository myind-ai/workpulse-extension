#!/usr/bin/env node
// wp-brain — the CLI side of the WorkPulse bridge.
//
// The extension and this script share one private GitHub repository (the one
// WorkPulse backs up to). Each writes only its own files under bridge/, so they
// never conflict:
//
//   bridge/entries/<YYYY-MM>/<device>.jsonl   what was asked, done, learned, broken
//   bridge/inbox/to-cli/*.json                requests from the extension
//   bridge/inbox/acks/<device>/<id>.json      this side saying "picked that up"
//
// The format code is the extension's own (extension/src/core/bridge.ts), loaded
// directly — Node 22.18+ strips TypeScript types itself — so the two sides can
// never disagree about what an entry is.
//
// Usage (see `wp-brain help`):
//   wp-brain init owner/repo [--branch NAME] [--clone DIR] [--device NAME]
//   wp-brain add <kind> "title" [--ticket K] [--project P] [--scope work|personal] [--body TEXT|--body-file F]
//                [--asked T] [--done T] [--root-cause T] [--status S] [--pr URL] [--commit SHA]… [--related K]… [--next T]… [--tags a,b]
//   wp-brain add --json FILE|-          one entry or an array, e.g. a whole ticket session
//   wp-brain brief [TICKET] [--project P]   what to know before starting
//   wp-brain list [--kind K] [--scope S] [--ticket K] [--project P] [--query Q] [--limit N]
//   wp-brain report [--days 7] [--scope S]
//   wp-brain inbox [--ack ID]
//   wp-brain sync
//
// Writing pushes at once unless --no-push. Nothing that looks like a secret is
// ever written.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bridge = await import(join(here, '..', 'extension', 'src', 'core', 'bridge.ts')).catch((e) => {
	console.error(`wp-brain needs Node 22.18 or newer (it loads the extension's TypeScript directly).\n${e.message}`)
	process.exit(1)
})
const { KINDS, ROOT, appendLine, entriesPath, filter, fold, newEntry, reportMarkdown, secretsIn, summarise } = bridge

const CONFIG = process.env.WP_BRAIN_CONFIG || join(homedir(), '.config', 'workpulse', 'brain.json')
const DAY = 86_400_000

// ── arguments ───────────────────────────────────────────────────────────────

const REPEATABLE = new Set(['commit', 'related', 'next', 'url'])
function parseArgs(argv) {
	const pos = []
	const opt = {}
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (!a.startsWith('--')) {
			pos.push(a)
			continue
		}
		const key = a.slice(2)
		const next = argv[i + 1]
		const value = next === undefined || next.startsWith('--') ? true : (i++, next)
		if (REPEATABLE.has(key)) (opt[key] ??= []).push(value)
		else opt[key] = value
	}
	return { pos, opt }
}

// ── config and git ──────────────────────────────────────────────────────────

function config() {
	if (!existsSync(CONFIG)) die(`Not set up. Run: wp-brain init owner/repo`)
	return JSON.parse(readFileSync(CONFIG, 'utf8'))
}

const git = (cfg, ...args) => execFileSync('git', ['-C', cfg.clone, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function pull(cfg) {
	try {
		// An empty repository, or a branch nobody has pushed yet, has nothing to pull.
		if (git(cfg, 'ls-remote', '--heads', 'origin', ...(cfg.branch ? [cfg.branch] : []))) git(cfg, 'pull', '--rebase', '--quiet')
	} catch (e) {
		console.error(`(pull failed, using what is here: ${String(e.stderr || e.message).trim().split('\n')[0]})`)
	}
}

function commitAndPush(cfg, paths, message, push = true) {
	git(cfg, 'add', '--', ...paths)
	if (!git(cfg, 'status', '--porcelain', '--', ...paths)) return false
	git(cfg, 'commit', '--quiet', '-m', message)
	if (push) {
		// Every path has one writer, so a rebase onto what others pushed always applies.
		for (let i = 0; i < 3; i++) {
			try {
				git(cfg, 'push', '--quiet', 'origin', 'HEAD')
				return true
			} catch {
				git(cfg, 'pull', '--rebase', '--quiet')
			}
		}
		die('Committed locally but could not push. Run: wp-brain sync')
	}
	return true
}

function readAll(cfg) {
	const files = {}
	const dir = join(cfg.clone, ROOT, 'entries')
	if (!existsSync(dir)) return []
	for (const month of readdirSync(dir)) {
		const m = join(dir, month)
		for (const f of readdirSync(m).filter((f) => f.endsWith('.jsonl'))) files[`${ROOT}/entries/${month}/${f}`] = readFileSync(join(m, f), 'utf8')
	}
	return fold(files)
}

function die(msg) {
	console.error(msg)
	process.exit(1)
}

const day = (t) => new Date(t).toISOString().slice(0, 10)
const short = (e) => `${day(e.at)}  ${e.kind.padEnd(8)} ${e.scope === 'personal' ? '[personal] ' : ''}${e.ticket ? e.ticket + ' ' : ''}${e.project ? '(' + e.project + ') ' : ''}${e.title}`

// ── commands ────────────────────────────────────────────────────────────────

const SCHEMA_DOC = `# bridge/

Shared between the WorkPulse extension and the \`wp-brain\` CLI (Claude Code skill \`workpulse-brain\`).
Every file has exactly one writer — a device — so nothing ever conflicts.

| Path | Writer | What |
|---|---|---|
| \`entries/<YYYY-MM>/<device>.jsonl\` | that device | One entry per line (\`workpulse.bridge.entry/1\`) |
| \`inbox/to-cli/<ts>-<id>.json\` | the extension | A request for the CLI |
| \`inbox/acks/<device>/<id>.json\` | the CLI device | "Picked that up" |

Entry kinds: ${KINDS.join(', ')}. Scope: \`work\` or \`personal\`.
Fields: id, at (epoch ms), device, kind, scope, title, body (Markdown), ticket, project, tags,
asked, done, rootCause, status, next[], links { pr, commits[], related[], urls[] }.

The extension's backup folder (\`workpulse/\`) is never written from here.
`

const commands = {
	init({ pos, opt }) {
		const repo = pos[0]
		if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) die('Usage: wp-brain init owner/repo [--branch NAME] [--clone DIR] [--device NAME]')
		const clone = opt.clone || join(homedir(), '.workpulse', 'brain')
		const device = opt.device || `cli-${hostname().split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '')}`
		const branch = typeof opt.branch === 'string' ? opt.branch : null
		if (branch && !existsSync(join(clone, '.git'))) {
			// One branch of a repository you already have — e.g. a `brain` branch of
			// a private code repository — holds only the brain: never a full clone of
			// the code. An existing branch is checked out; a missing one starts empty.
			mkdirSync(clone, { recursive: true })
			const g = (...a) => execFileSync('git', ['-C', clone, ...a], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
			g('init', '-q', '-b', branch)
			g('remote', 'add', 'origin', `https://github.com/${repo}.git`)
			try {
				g('fetch', '-q', 'origin', branch)
				g('checkout', '-q', '-B', branch, '--track', `origin/${branch}`)
			} catch {
				// No such branch yet: the first commit below creates it, with tracking.
				g('config', `branch.${branch}.remote`, 'origin')
				g('config', `branch.${branch}.merge`, `refs/heads/${branch}`)
			}
		}
		if (!existsSync(join(clone, '.git'))) {
			mkdirSync(dirname(clone), { recursive: true })
			// gh uses whatever login you already have; plain git is the fallback.
			try {
				execFileSync('gh', ['repo', 'clone', repo, clone, '--', '--quiet'], { stdio: 'inherit' })
			} catch {
				execFileSync('git', ['clone', '--quiet', `https://github.com/${repo}.git`, clone], { stdio: 'inherit' })
			}
		}
		const cfg = { repo, clone, device, ...(branch ? { branch } : {}) }
		mkdirSync(dirname(CONFIG), { recursive: true })
		writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n')
		const doc = join(clone, ROOT, 'SCHEMA.md')
		if (!existsSync(doc)) {
			mkdirSync(dirname(doc), { recursive: true })
			writeFileSync(doc, SCHEMA_DOC)
			commitAndPush(cfg, [`${ROOT}/SCHEMA.md`], 'bridge: describe the folder', !opt['no-push'])
		}
		console.log(`Ready. ${repo}${branch ? ` (branch ${branch})` : ''} at ${clone}; this machine writes as ${device}.\nConfig: ${CONFIG}`)
		if (branch) console.log(`In the extension: Settings → Backup → repository ${repo}, branch ${branch}.`)
	},

	add({ pos, opt }) {
		const cfg = config()
		let inputs
		if (opt.json) {
			const raw = opt.json === '-' || opt.json === true ? readFileSync(0, 'utf8') : readFileSync(opt.json, 'utf8')
			const parsed = JSON.parse(raw)
			inputs = Array.isArray(parsed) ? parsed : [parsed]
		} else {
			const [kind, ...words] = pos
			if (!KINDS.includes(kind) || !words.length) die(`Usage: wp-brain add <${KINDS.join('|')}> "title" [options]`)
			const body = opt['body-file'] ? readFileSync(opt['body-file'], 'utf8') : typeof opt.body === 'string' ? opt.body : undefined
			const links = {
				...(opt.pr ? { pr: opt.pr } : {}),
				...(opt.commit ? { commits: opt.commit } : {}),
				...(opt.related ? { related: opt.related } : {}),
				...(opt.url ? { urls: opt.url } : {}),
			}
			inputs = [
				{
					kind,
					title: words.join(' '),
					scope: opt.scope === 'personal' ? 'personal' : 'work',
					body,
					ticket: opt.ticket ? String(opt.ticket).toUpperCase() : undefined,
					project: opt.project || undefined,
					asked: opt.asked || undefined,
					done: opt.done || undefined,
					rootCause: opt['root-cause'] || undefined,
					status: opt.status || undefined,
					next: opt.next,
					tags: typeof opt.tags === 'string' ? opt.tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean) : undefined,
					links: Object.keys(links).length ? links : undefined,
				},
			]
		}
		pull(cfg)
		const now = Date.now()
		const written = new Set()
		let n = 0
		for (const input of inputs) {
			const { schema, id, at, device, ...rest } = input
			const scope = rest.scope === 'personal' ? 'personal' : 'work'
			const entry = newEntry({ ...rest, scope, kind: rest.kind }, cfg.device, now + n++) // throws on anything secret-shaped
			const rel = entriesPath(entry.at, cfg.device)
			const abs = join(cfg.clone, rel)
			mkdirSync(dirname(abs), { recursive: true })
			writeFileSync(abs, appendLine(existsSync(abs) ? readFileSync(abs, 'utf8') : null, entry))
			written.add(rel)
			console.log(`+ ${short(entry)}`)
		}
		const first = inputs[0]
		const what = inputs.length === 1 ? `${first.kind} — ${String(first.title).slice(0, 60)}` : `${inputs.length} entries${first.ticket ? ' for ' + first.ticket : ''}`
		const pushed = commitAndPush(cfg, [...written], `bridge: ${what}`, !opt['no-push'])
		console.log(pushed && !opt['no-push'] ? 'Pushed.' : 'Committed locally.')
	},

	brief({ pos, opt }) {
		const cfg = config()
		pull(cfg)
		const out = briefLines(cfg, readAll(cfg), pos[0]?.toUpperCase(), typeof opt.project === 'string' ? opt.project : undefined)
		console.log(out.length ? out.join('\n') : 'Nothing recorded yet.')
	},

	/**
	 * For a Claude Code SessionStart hook: reads the hook's JSON on stdin, finds
	 * the ticket key in the git branch (`fix/pay-2433-…` → PAY-2433) and the
	 * project in the remote (`owner/repo`), and prints the brief as context for
	 * the session. Silent — no output, exit 0 — when the brain is not set up, the
	 * folder is not a git repository, or there is nothing recorded to say.
	 */
	hook() {
		if (!existsSync(CONFIG)) return
		let cwd = process.cwd()
		try {
			const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
			if (typeof input.cwd === 'string') cwd = input.cwd
		} catch {
			/* no stdin: use the current folder */
		}
		const here = (...a) => {
			try {
				return execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
			} catch {
				return ''
			}
		}
		const branch = here('branch', '--show-current')
		if (!branch) return
		const key = branch.match(/\b([a-z]{2,10})-(\d{1,6})\b/i)?.slice(1, 3).join('-').toUpperCase()
		const remote = here('remote', 'get-url', 'origin').match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/)?.[1]
		const cfg = config()
		pull(cfg)
		const all = readAll(cfg)
		// Entries name a project either as owner/repo or by the repo alone.
		const project = [remote, remote?.split('/')[1]].find((p) => p && all.some((e) => e.project === p)) ?? remote
		const known = all.filter((e) => (key && (e.ticket === key || e.links?.related?.includes(key))) || (project && e.project === project))
		if (!known.length && !pending(cfg).length) return
		const lines = briefLines(cfg, all, key, project)
		const text = [`WorkPulse Brain — what was recorded before for ${[key, project].filter(Boolean).join(' / ')} (read it before planning; record mistakes and the session with the workpulse-brain skill):`, '', ...lines].join('\n')
		process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text.slice(0, 8000) } }))
	},

	list({ opt }) {
		const cfg = config()
		pull(cfg)
		const got = filter(readAll(cfg), { kind: opt.kind, scope: opt.scope, ticket: opt.ticket?.toUpperCase(), project: opt.project, query: opt.query })
		for (const e of got.slice(0, Number(opt.limit) || 30)) console.log(short(e))
		if (!got.length) console.log('Nothing matches.')
	},

	report({ opt }) {
		const cfg = config()
		pull(cfg)
		const days = Number(opt.days) || 7
		const to = Date.now() + 1
		const entries = filter(readAll(cfg), { scope: opt.scope })
		process.stdout.write(reportMarkdown(entries, to - days * DAY, to, days === 7 ? 'Week report' : `Last ${days} days`))
	},

	inbox({ opt }) {
		const cfg = config()
		pull(cfg)
		if (opt.ack) {
			const rel = `${ROOT}/inbox/acks/${cfg.device}/${opt.ack}.json`
			mkdirSync(dirname(join(cfg.clone, rel)), { recursive: true })
			writeFileSync(join(cfg.clone, rel), JSON.stringify({ id: opt.ack, at: Date.now(), by: cfg.device }) + '\n')
			commitAndPush(cfg, [rel], `bridge: picked up ${opt.ack}`, !opt['no-push'])
			console.log(`Acknowledged ${opt.ack}.`)
			return
		}
		const list = pending(cfg)
		for (const m of list) console.log(`[${m.id}] ${day(m.at)} ${m.ticket ? m.ticket + ': ' : ''}${m.text}`)
		if (!list.length) console.log('Inbox empty.')
	},

	sync() {
		const cfg = config()
		pull(cfg)
		try {
			git(cfg, 'push', '--quiet', 'origin', 'HEAD')
		} catch {
			/* nothing to push */
		}
		console.log(`In step with ${cfg.repo}.`)
	},

	help() {
		console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).slice(0, 30).map((l) => l.slice(3)).join('\n'))
	},
}

/** The brief: earlier entries for a ticket and project, repeat mistakes, open follow-ups, the inbox. */
function briefLines(cfg, all, key, project) {
	const out = []
	if (key) {
		const mine = all.filter((e) => e.ticket === key || e.links?.related?.includes(key))
		const related = new Set(mine.flatMap((e) => e.links?.related ?? []))
		out.push(`## ${key}: ${mine.length ? mine.length + ' earlier entries' : 'nothing recorded yet'}`)
		for (const e of mine.slice(0, 12)) {
			out.push(`- ${short(e)}`)
			if (e.rootCause) out.push(`    root cause: ${e.rootCause}`)
			if (e.next?.length) out.push(`    next: ${e.next.join(' · ')}`)
		}
		if (related.size) out.push(`Related: ${[...related].join(', ')}`)
	}
	if (project) {
		const p = all.filter((e) => e.project === project).slice(0, 10)
		out.push('', `## ${project}: last ${p.length}`, ...p.map((e) => `- ${short(e)}`))
	}
	const recent = all.filter((e) => e.at > Date.now() - 30 * DAY)
	const { repeats } = summarise(recent)
	if (repeats.length) {
		out.push('', '## Mistakes that keep coming back (30 days)')
		for (const r of repeats.slice(0, 6)) {
			const last = recent.find((e) => e.kind === 'mistake' && e.tags?.includes(r.tag))
			out.push(`- #${r.tag} ×${r.count}${last ? ` — last: ${last.title}${last.rootCause ? ' (' + last.rootCause + ')' : ''}` : ''}`)
		}
	}
	const open = all.filter((e) => e.next?.length && e.status !== 'done' && e.at > Date.now() - 14 * DAY).slice(0, 6)
	if (open.length) out.push('', '## Open follow-ups (14 days)', ...open.map((e) => `- ${e.ticket ?? e.project ?? ''} ${e.next.join(' · ')}`))
	const inbox = pending(cfg)
	if (inbox.length) out.push('', '## Inbox from the extension', ...inbox.map((m) => `- [${m.id}] ${m.ticket ? m.ticket + ': ' : ''}${m.text}`))
	return out
}

/** Inbox messages nobody on this machine has acknowledged. */
function pending(cfg) {
	const dir = join(cfg.clone, ROOT, 'inbox', 'to-cli')
	if (!existsSync(dir)) return []
	const ackDir = join(cfg.clone, ROOT, 'inbox', 'acks', cfg.device)
	const acked = new Set(existsSync(ackDir) ? readdirSync(ackDir).map((f) => f.replace(/\.json$/, '')) : [])
	return readdirSync(dir)
		.filter((f) => f.endsWith('.json'))
		.map((f) => {
			try {
				return JSON.parse(readFileSync(join(dir, f), 'utf8'))
			} catch {
				return null
			}
		})
		.filter((m) => m && !acked.has(m.id) && !secretsIn(JSON.stringify(m)).length)
		.sort((a, b) => a.at - b.at)
}

const [cmd = 'help', ...rest] = process.argv.slice(2)
const run = commands[cmd]
if (!run) die(`Unknown command "${cmd}". Try: wp-brain help`)
try {
	run(parseArgs(rest))
} catch (e) {
	die(e.message)
}

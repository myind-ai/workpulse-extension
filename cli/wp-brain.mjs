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
//   bridge/records/<device>/<YYYY-MM>/*.md     a readable copy of each entry this device wrote
//   bridge/library/<type>/<folder>/           opt-in text backup of a learning (the device in its .owner file)
//   bridge/config/<device>/                   opt-in text copy of ~/.claude rules and skills
//   bridge/SCHEMA.md                          what all this is
//
// The format code is the extension's own (extension/src/core/bridge.ts), loaded
// directly — Node 22.18+ strips TypeScript types itself — so the two sides can
// never disagree about what an entry is.
//
// Usage (see `wp-brain help`):
//   wp-brain setup        asks repo (created private if missing), branch, device, hooks, rule, skill, text backup — then installs them (start here)
//   wp-brain doctor       checks every part of the link
//   wp-brain guard "<command>"   what the guard hook would answer (allow, ask or deny) and why; setup --guard yes installs it
//   wp-brain init owner/repo [--branch NAME] [--create] [--steps] [--clone DIR] [--device NAME] [--allow-public]
//   wp-brain connect [--repo NAME|owner/name] [--use brain|skills|sessions]  (first run: links this computer and starts storing)
//   wp-brain move owner/repo [--yes]        (the Brain and its history to a repository of its own; without --yes, only says what would happen)
//   wp-brain move --catch-up                (what was written to the old repository after the move)
//   wp-brain add <kind> "title" [--subtitle TEXT] [--ticket K] [--project P] [--scope work|personal] [--body TEXT|--body-file F]
//                [--source-type youtube|instagram|site|workpulse|session|manual] [--source-url U] [--source-title T] [--source-by T] [--source-library P]
//                [--asked T] [--done T] [--root-cause T] [--status S] [--pr URL] [--commit SHA]… [--related K]… [--next T]… [--tags a,b]
//   wp-brain add --json FILE|-          one entry or an array, e.g. a whole ticket session
//                                       (an entry already there with the same kind and title is skipped; --force adds it)
//   wp-brain learn <url> [--root DIR]    save a web article for learning (article.md, meta.json, notes.md); prints one JSON line
//   wp-brain recall ["words"]   lessons close to a prompt (UserPromptSubmit hook; reads stdin when no words)
//   wp-brain brief [TICKET] [--project P] [--about "words"] [--full]   what to know before starting (+ related learnings); capped at 400 tokens, --full is not
//   wp-brain show ID                        one entry in full: body, root cause, next steps (ID: the [xxxxxxxx] lists show)
//   wp-brain list [--kind K] [--scope S] [--ticket K] [--project P] [--source TYPE|none] [--query Q] [--limit N] [--archived]
//   wp-brain edit ID [--title T] [--subtitle T] [--body T] [--tags a,b] [--root-cause T] [--next T]… [--status S] [--kind K]
//                [--source-type T] [--source-url U] [--source-title T] [--source-by T] [--source-library P]
//   wp-brain archive ID | restore ID | rm ID [--purge]     (ID: the [xxxxxxxx] every list shows)
//   wp-brain search "words" [--limit N]     ranked past work; filters: ticket: type: status:open|done repo: tag:/#tag
//                                           after:/before: (2026-10-01 or 7d) has:next-action|pr|root-cause scope: source:youtube
//   wp-brain db rebuild | status            the local database search and recall read from (~/.workpulse/brain.db or WP_BRAIN_DB; rebuilt from the clone, safe to delete)
//   wp-brain library add FOLDER --type youtube|instagram|… [--no-push]   back up a folder's notes and transcripts (only with "library": true in brain.json)
//   wp-brain library list | restore [--root DIR] [--force]
//   wp-brain config backup [--no-push]      back up ~/.claude/CLAUDE.md, RTK.md, rules/, rule-files/ and the text of your skills to bridge/config/<device>/ (needs "library": true);
//                                           hidden folders and sensitive names (.env, *.pem, *token*, …) are left out
//                                           "configSkip": ["skills/foo/template", …] in brain.json leaves those paths out (whole path segments)
//   wp-brain config scan [--home DIR]       the same check, read-only: names each file and shape that looks like a secret (never the value); exit 1 on a hit; no library switch needed
//   wp-brain config restore [--from DEVICE] [--force] [--home DIR]   put them back on a new machine; a file already there is kept,
//                                           except a CLAUDE.md holding only the Brain rule from setup
//   wp-brain vault init [--yes]             turn the vault on: a private repo, its clone, a Keychain key and "vault" in brain.json (only says what it would do unless --yes)
//   wp-brain vault key export | confirm | import   in your own terminal: print the key for an offline copy, record that copy, or paste the key on a new Mac
//   wp-brain vault backup [--videos] [--databases] [--yes] [--dry-run] [--discard-staged]   videos and encrypted databases to your private vault repo (only with "vault" in brain.json; a dry run unless --yes)
//   wp-brain vault restore [NAME|ID] [--to DIR] [--force]   put one item back under its name (no argument: list them); checked end to end, a file already there is kept
//   wp-brain vault prune [--keep N] [--yes]   delete old snapshots (the newest 5 and the monthly ones stay) and orphan releases of this device; a list unless --yes
//   wp-brain vault list | status            what the vault holds; the key's state, orphan releases and unlisted assets (never the key)
//   wp-brain backup-all [--videos] [--scheduled]   everything, once: capture, export, library, config, pack, vault (databases; videos only with --videos), and a monthly restore test.
//                                           Each part says done, skipped or failed; one failing never stops the rest; exit 1 naming what failed. --scheduled prints numbers only
//   wp-brain backup status                  when each part last succeeded, what isn't backed up yet, what is left out, and iCloud. One screen, no text
//   wp-brain backup schedule on | off       run backup-all once a day with a macOS LaunchAgent: low priority, at the next wake if the Mac was asleep, never on a prompt
//   wp-brain backfill-source [--yes] [--no-push]   give older lessons the source they can be told from (dry run unless --yes)
//   wp-brain index [--no-push]              add any missing records of this device; write INDEX.md and graph.json
//                                           next to the clone (built from every device, never committed)
//   wp-brain budget [--json] [--check]      tokens that instructions, skills and the Brain cost per session; --check exits 1 over target
//   wp-brain rules split --map FILE [--out DIR] [--keep-core|--discard-core] | verify [--dir DIR] | test [--dir DIR] [--tests FILE] [--live] [--json] | apply --yes | rollback
//                                           split CLAUDE.md into rule files, prove no line was lost; the old file is kept
//   wp-brain graph [X] [--depth 1|2] [--type tag,project,ticket,source,lesson] [--limit N] [--json]
//                                           what connects to X (a ticket, '#tag', project:name, a lesson id or words); no X: counts and the
//                                           most connected hubs. Read-only; only on request, never printed unasked
//   wp-brain report [--days 7] [--scope S]
//   wp-brain inbox [--ack ID]               asks from the extension (saved pages are in the queue)
//   wp-brain queue                          pages saved from the extension: waiting, stuck, failed
//   wp-brain queue next [--root DIR]        claim the oldest waiting page (or resume this device's claim); prints one JSON line
//   wp-brain queue done ID [--lessons N] | fail ID --why TEXT | retry ID
//   wp-brain hook [--plugin]       (Claude Code SessionStart hook: the brief for this branch, as context;
//                                  --plugin: from the plugin — offers the link when nothing is set up)
//   wp-brain stop-check [--plugin] (Claude Code Stop hook: once per session, ask to record committed work)
//   wp-brain memory on | off       keep the full text of your sessions in a local database, secrets masked. It stays on this machine,
//                                  and if you use the vault it also goes into its encrypted backups. Off unless you turn it on.
//                                  off keeps everything already kept; sessions run while off stay out
//   wp-brain memory status [--since 14d]  is capture working: on or off, last write, sessions seen and captured per day,
//                                  missed, recovered and lost, last error, drift, database size. Reads only
//   wp-brain memory search "words" [--repo R] [--role prompt|answer] [--session ID] [--agents] [--since 30d] [--limit N] [--json]
//                                  your sessions' masked text, best match first, 10 hits of at most 200 characters; recall and brief never read it
//   wp-brain memory show SESSION [--text]  facts and summary; the full masked text only with --text
//   wp-brain memory import-claude-mem [--db PATH] [--dry-run]  copy claude-mem's history, read-only, into an archive in the memory database
//                                  (default ~/.claude-mem/claude-mem.db). Never changes or stops claude-mem. Search it with: memory search "words" --archive [--type T] [--project P]
//   wp-brain memory compare [--since 14d] [--db PATH]  per day, sessions we captured and sessions claude-mem saw, and the ones only one has. A report only
//   wp-brain memory promote --type decision|bugfix [--project P] [--query Q] [--limit N]  list archive rows not yet promoted (writes nothing)
//   wp-brain memory promote --json FILE|- [--no-push]  turn reviewed rows into Brain lessons, at most 20; you write each title
//   wp-brain memory backfill [--yes]  capture every session file on disk, including time capture was off; no --yes is a dry run that writes nothing
//   wp-brain memory export [--session ID] [--since DATE]  one readable Markdown file per session in ~/Documents/claude-sessions/<project>/
//                                  (WP_SESSIONS_MD), masked; only its marked block is rewritten, so your own text in the file stays. Stays on this machine
//   wp-brain memory unpack DB --to DIR  put back the files of a pack restored from the vault (session-files.db); refuses to overwrite
//   wp-brain memory audit  check every stored row against the secret shapes; prints counts only (rows checked, per shape), never a value. Exits 1 on a hit
//   wp-brain memory summary --session ID [--next T] "text"  save this session's summary for the next session's note: masked, cut to 200
//                                  tokens at a sentence end, replaces the session's earlier one. Always exits 0, one line of output
//   wp-brain sync
//   wp-brain scan-claude [--since 24h] [--gap 20] [--max-session 120] [--job ZOHO_JOB_ID] [--ticket PAY-123]
//   wp-brain worklog "summary" --minutes 30 [--job ZOHO_JOB_ID] [--ticket PAY-123]
//   wp-brain worklog "summary" --from 2026-10-28T10:00:00+05:30 --to 2026-10-28T10:45:00+05:30 [--job ZOHO_JOB_ID]
//
// Writing pushes at once unless --no-push. Nothing that looks like a secret is
// ever written.

import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, hostname } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bridge = await import(join(here, '..', 'extension', 'src', 'core', 'bridge.ts')).catch((e) => {
	console.error(`wp-brain needs Node 22.18 or newer (it loads the extension's TypeScript directly).\n${e.message}`)
	process.exit(1)
})
const { EDITABLE, KINDS, ROOT, SOURCE_TYPES, sourceOf, appendLine, duplicateOf, entriesPath, entryByRef, filter, fold, newEntry, reportMarkdown, secretsIn, shortId, summarise } = bridge
const { brainGraph, brainIndex, brainRecord } = await import(join(here, '..', 'extension', 'src', 'core', 'brain-index.ts'))
const { findNodesHow, narrowGraph } = await import(join(here, '..', 'extension', 'src', 'core', 'brain-graph.ts'))
const { connectionGraph, connectionLines, nodeLine, overviewLines } = await import(join(here, 'graph.mjs'))
const { LESSON_KINDS, matchBrain, parseBrainQuery, recallFor, searchBrain } = await import(join(here, '..', 'extension', 'src', 'core', 'brain-query.ts'))
const { LIBRARY_FILES, OWNER_FILE, SKIPPED_BY_CONFIG, assertNoLinks, configDevices, configFilesIn, configPath, countWhy, isLinkSafe, libraryEnabled, libraryPath, linkFree, listLibrary, pickFiles, repoVisibility, restoreConfig, restoreInto, secretReport, validDevice } = await import(join(here, 'library.mjs'))
const { learn } = await import(join(here, 'article.mjs'))
const budgetOf = await import(join(here, 'budget.mjs'))
const { ackOf, countable, isSavedUrl, ownerOf, queueCountLine, queueRows } = await import(join(here, 'queue.mjs'))
const brainDb = await import(join(here, 'brain-db.mjs'))
const { claudeDir, doctor, ensureRepo, extensionSteps, holdsRule, markedRule, memoryOff, memoryOn, nudgeText, onlyRule, placeRule, placeRuleIn, settingsHasHook, setup } = await import(join(here, 'setup.mjs'))
const { claudeTranscriptFiles, memoryDbPath, projectsRoot, sessionsMdDir, ticketOf } = await import(join(here, 'claude-files.mjs'))
const { capBrief, inboxItem, recallLine, recallText, section, showText } = await import(join(here, 'caps.mjs'))

const CONFIG = process.env.WP_BRAIN_CONFIG || join(homedir(), '.config', 'workpulse', 'brain.json')
const DAY = 86_400_000
let dieThrows = false // backup-all runs commands as parts: one that stops must not end the whole run

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

/** --source-type/-url/-title/-by/-library as the entry's `source`, or undefined when none is given. */
function sourceFrom(opt) {
	const text = (k) => (typeof opt[`source-${k}`] === 'string' && opt[`source-${k}`].trim() ? opt[`source-${k}`].trim() : undefined)
	const type = text('type')
	if (!type && !text('url') && !text('title') && !text('by') && !text('library')) return undefined
	if (!SOURCE_TYPES.includes(type)) die(`--source-type must be one of ${SOURCE_TYPES.join(', ')}`)
	return { type, ...Object.fromEntries(['url', 'title', 'by', 'library'].filter(text).map((k) => [k, text(k)])) }
}

// ── config and git ──────────────────────────────────────────────────────────

function config() {
	if (!existsSync(CONFIG)) die(`Not set up. Run: wp-brain init owner/repo`)
	return JSON.parse(readFileSync(CONFIG, 'utf8'))
}

// Paths are literal: a folder called foo* must never stand for its neighbours in add, reset, checkout or clean.
const gitEnv = (cfg, env, ...args) => execFileSync('git', ['-C', cfg.clone, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_LITERAL_PATHSPECS: '1', ...env } }).trim()
const git = (cfg, ...args) => gitEnv(cfg, {}, ...args)

/**
 * The git operation left unfinished in the clone (rebase, merge, cherry-pick or revert), or null. A commit made during
 * one is not a plain commit: git would conclude a merge or cherry-pick from the temporary index and drop the other side.
 */
function unfinishedOp(cfg) {
	try {
		const gitDir = git(cfg, 'rev-parse', '--absolute-git-dir')
		const there = (...names) => names.some((n) => existsSync(join(gitDir, n)))
		return there('rebase-merge', 'rebase-apply') ? 'rebase' : there('MERGE_HEAD') ? 'merge' : there('CHERRY_PICK_HEAD') ? 'cherry-pick' : there('REVERT_HEAD') ? 'revert' : null
	} catch {
		return null
	}
}

const unfinishedMessage = (cfg, op) => `The Brain clone at ${cfg.clone} is in the middle of a ${op}, so nothing was written. Finish it (git -C "${cfg.clone}" ${op} --continue) or undo it (git -C "${cfg.clone}" ${op} --abort), then run again.`

/**
 * pull --rebase that never leaves the clone mid-rebase, and only ever aborts a rebase it started: one already there
 * is someone's work and makes this throw. Returns true when it pulled, false when its own conflict was undone; other failures throw.
 */
function pullRebase(cfg) {
	const op = unfinishedOp(cfg)
	if (op) throw new Error(`a ${op} is already unfinished in the clone`)
	try {
		git(cfg, 'pull', '--rebase', '--quiet')
		return true
	} catch (e) {
		if (unfinishedOp(cfg) !== 'rebase') throw e
		try {
			git(cfg, 'rebase', '--abort')
		} catch {
			/* still mid-rebase: the next write command stops and says so */
		}
		return false
	}
}

/**
 * Brings the clone up to date. A rebase, merge, cherry-pick or revert left unfinished belongs to whoever started it and is never touched:
 * a write command stops, `reading` only skips the pull. After a failed pull the clone is as it was.
 */
function pull(cfg, { reading = false } = {}) {
	const unfinished = () => {
		const op = unfinishedOp(cfg)
		if (!op) return false
		if (!reading) die(unfinishedMessage(cfg, op))
		console.error(`(the Brain clone is in the middle of a ${op}: not pulling, using what is here)`)
		return true
	}
	if (unfinished()) return
	try {
		// An empty repository, or a branch nobody has pushed yet, has nothing to pull.
		if (git(cfg, 'ls-remote', '--heads', 'origin', ...(cfg.branch ? [cfg.branch] : []))) {
			if (!pullRebase(cfg)) console.error('(pull failed, using what is here: it conflicts with what is on the remote, so the rebase was undone)')
		}
	} catch (e) {
		console.error(`(pull failed, using what is here: ${String(e.stderr || e.message).trim().split('\n')[0]})`)
	}
	unfinished()
}

/**
 * Commits `paths` as they are on disk and nothing else, from a temporary index that starts at HEAD: anything else
 * staged stays staged and out of the commit, and a file, link or folder may turn into another of those (which
 * `git commit -- paths` cannot do). Returns false when they match HEAD.
 */
function commitPaths(cfg, paths, message) {
	const stage = newStage(cfg)
	const env = { GIT_INDEX_FILE: join(stage, 'index') }
	try {
		let born = true
		try {
			git(cfg, 'rev-parse', '--verify', '--quiet', 'HEAD')
		} catch {
			born = false
		}
		if (born) gitEnv(cfg, env, 'read-tree', 'HEAD') // an unborn branch starts from an empty index
		gitEnv(cfg, env, 'add', '-A', '-f', '--', ...paths) // -A: a purged record is a deletion to stage; -f: every path is explicit, and a gitignore must not leave one out silently
		if (!gitEnv(cfg, env, 'status', '--porcelain', '--', ...paths)) return false
		gitEnv(cfg, env, 'commit', '--quiet', '-m', message)
	} finally {
		rmSync(stage, { recursive: true, force: true })
	}
	try {
		git(cfg, 'reset', '-q', '--', ...paths) // the real index catches up on these paths only
	} catch {
		/* the commit stands; at worst `git status` shows these paths until the next reset */
	}
	return true
}

function commitAndPush(cfg, paths, message, push = true) {
	const op = unfinishedOp(cfg)
	if (op) die(unfinishedMessage(cfg, op))
	if (!commitPaths(cfg, paths, message)) return false
	if (push) {
		// Every path has one writer, so a rebase onto what others pushed normally applies. When a hand edit makes
		// it conflict, the rebase is undone and the commit stays here for the owner to sort out.
		for (let i = 0; i < 3; i++) {
			try {
				git(cfg, 'push', '--quiet', 'origin', 'HEAD')
				return true
			} catch {
				try {
					if (!pullRebase(cfg)) die('Committed locally but not pushed: it conflicts with what is on the remote, so the rebase was undone. Sort out the conflict in the clone by hand, then run: wp-brain sync')
				} catch {
					/* no upstream yet, or nothing to rebase onto: the message below says where the commit is */
				}
			}
		}
		die('Committed locally but could not push. Run: wp-brain sync')
	}
	return true
}

/** Undoes an unfinished write to `rel` (this path only): unstage, restore tracked files, remove new ones. */
function rollback(cfg, rel) {
	for (const args of [['reset', '-q', '--', rel], ['checkout', '--', rel], ['clean', '-fdqx', '--', rel]]) {
		try {
			git(cfg, ...args)
		} catch {
			/* nothing tracked there, or nothing new */
		}
	}
	pruneEmpty(cfg, dirname(rel))
}

/** Removes `rel` and the folders above it while they are empty: what a failed write created and nothing else uses. */
function pruneEmpty(cfg, rel) {
	for (let d = rel; d && d !== '.' && d !== ROOT; d = dirname(d)) {
		try {
			rmdirSync(join(cfg.clone, d))
		} catch {
			break
		}
	}
}

/** Whether GitHub knows this repository, for `move`. A missing gh is an error, not a "no": it would otherwise try to create one. */
function repoExists(repo) {
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) return false
	try {
		execFileSync('gh', ['repo', 'view', repo, '--json', 'name'], { stdio: ['ignore', 'ignore', 'ignore'] })
		return true
	} catch (e) {
		if (e.code === 'ENOENT') die('The GitHub CLI is missing. Install https://cli.github.com, run gh auth login, then run this again.')
		return false
	}
}

/** Refuses to put library or config content in a public repository; a repository that can't be told only gets a warning. */
function requirePrivate(cfg) {
	const v = repoVisibility(cfg.repo)
	if (v === 'public') die(`${cfg.repo} is a public repository. Notes, transcripts, skills and rules are not put in a public repository; nothing was backed up.`)
	if (v === 'unknown') console.error(`warning: could not tell whether ${cfg.repo} is private (is the GitHub CLI signed in?); continuing because the Brain repository is private by default.`)
}

/** Commits not on the remote: against the upstream, or (before the first successful push, when there is none) against every origin ref. */
function aheadCount(cfg) {
	for (const args of [['rev-list', '--count', '@{u}..HEAD'], ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin']]) {
		try {
			return Number(git(cfg, ...args)) || 0
		} catch {
			/* try the next way of counting */
		}
	}
	return 0
}

/** A new private folder inside .git (never a path another device could own, never shared with another run). */
function newStage(cfg) {
	const gitDir = git(cfg, 'rev-parse', '--absolute-git-dir')
	for (const f of readdirSync(gitDir)) {
		if (!f.startsWith('wp-brain-stage')) continue // left by a killed run: only old ones, a live run may own a young one
		try {
			if (Date.now() - statSync(join(gitDir, f)).mtimeMs > 3_600_000) rmSync(join(gitDir, f), { recursive: true, force: true })
		} catch {
			/* gone already */
		}
	}
	return mkdtempSync(join(gitDir, 'wp-brain-stage-'))
}

/**
 * Builds `rel` from nothing in a stage, then swaps it in (a mirror: what is in the folder now, links and untracked
 * files too, is dropped, never followed or staged); a failure leaves the old copy. Refuses when `rel` or a folder
 * above it is a symlink.
 */
function rebuild(cfg, rel, fill) {
	assertNoLinks(cfg.clone, rel)
	const stage = newStage(cfg)
	const dest = join(cfg.clone, rel)
	try {
		chmodSync(stage, 0o755)
		fill(stage)
		mkdirSync(dirname(dest), { recursive: true })
		assertNoLinks(cfg.clone, rel) // again, after the mkdir
		rmSync(dest, { recursive: true, force: true })
		renameSync(stage, dest)
	} catch (e) {
		rmSync(stage, { recursive: true, force: true })
		rollback(cfg, rel)
		throw e
	}
}

/** What HEAD holds under `rel` (staged and never committed is not tracked here): its path, and whether it is a symlink. */
function trackedIn(cfg, rel) {
	let listing
	try {
		listing = git(cfg, 'ls-tree', '-r', '-z', 'HEAD', '--', rel)
	} catch {
		return [] // an unborn branch tracks nothing
	}
	return listing.split('\0').filter(Boolean).map((line) => {
		const tab = line.indexOf('\t')
		return { path: line.slice(tab + 1), link: line.startsWith('120000') }
	})
}

/**
 * Writes exactly `files` ({ name: content }) into the folder `rel` and commits exactly those paths; everything else
 * in the folder stays as it is, unstaged. Each file goes through a temp file and a rename, so a link at the target
 * is replaced, never written through. On failure these paths go back to what they were, byte for byte.
 */
function writeExact(cfg, rel, files, message, push) {
	assertNoLinks(cfg.clone, rel)
	const dest = join(cfg.clone, rel)
	const names = Object.keys(files)
	const kind = (p) => {
		try {
			return lstatSync(p)
		} catch {
			return null
		}
	}
	for (const name of names) if (kind(join(dest, name))?.isDirectory()) die(`${rel}/${name} is a folder in the Brain clone, where a file belongs. Nothing was changed; remove it, then run again.`)
	const stage = newStage(cfg)
	const clearStage = () => rmSync(stage, { recursive: true, force: true })
	process.once('exit', clearStage) // die() exits from inside commitAndPush
	const finished = () => {
		clearStage()
		process.removeListener('exit', clearStage) // backup-all writes many folders in one process
	}
	const old = join(stage, 'old') // what was at each target, to put back
	mkdirSync(old)
	const undo = () => {
		for (const name of names) {
			try {
				git(cfg, 'reset', '-q', '--', `${rel}/${name}`)
			} catch {
				/* nothing to unstage */
			}
			if (!kind(join(stage, name))) rmSync(join(dest, name), { force: true }) // its temp file is gone, so it reached the target
			if (kind(join(old, name))) renameSync(join(old, name), join(dest, name))
		}
		pruneEmpty(cfg, rel)
	}
	for (const name of names) writeFileSync(join(stage, name), files[name], { mode: 0o644 })
	try {
		mkdirSync(dest, { recursive: true })
		assertNoLinks(cfg.clone, rel) // again, after the mkdir
		for (const name of names) {
			if (kind(join(dest, name))) renameSync(join(dest, name), join(old, name)) // a link is moved as a link
			renameSync(join(stage, name), join(dest, name))
		}
	} catch (e) {
		undo()
		finished()
		throw e
	}
	try {
		return commitBackup(cfg, names.map((name) => `${rel}/${name}`), message, push, undo)
	} finally {
		finished()
	}
}

/**
 * commitAndPush for a backup: a failed commit runs `undo` so the clone is as it was, and when there is nothing
 * new it still pushes commits an earlier run left behind (or says they are not pushed). Returns { changed, unpushed }.
 */
function commitBackup(cfg, paths, message, push, undo) {
	let head0 = null
	try {
		head0 = git(cfg, 'rev-parse', 'HEAD')
	} catch {
		/* empty repository */
	}
	let changed
	try {
		changed = commitAndPush(cfg, paths, message, push)
	} catch (e) {
		let now = null
		try {
			now = git(cfg, 'rev-parse', 'HEAD')
		} catch {
			/* still empty */
		}
		if (now === head0) undo()
		throw e
	}
	let ahead = aheadCount(cfg)
	if (!changed && ahead > 0 && push) {
		try {
			git(cfg, 'push', '--quiet', 'origin', 'HEAD')
			ahead = 0
		} catch {
			die(`Nothing new to back up, but ${ahead} earlier commit${ahead === 1 ? ' is' : 's are'} only on this machine: the push failed. Nothing is backed up on GitHub yet. Run: wp-brain sync`)
		}
	}
	return { changed, unpushed: ahead }
}

function readAll(cfg, archived = false) {
	const files = {}
	const dir = join(cfg.clone, ROOT, 'entries')
	if (existsSync(dir)) {
		for (const month of readdirSync(dir)) {
			const m = join(dir, month)
			for (const f of readdirSync(m).filter((f) => f.endsWith('.jsonl'))) files[`${ROOT}/entries/${month}/${f}`] = readFileSync(join(m, f), 'utf8')
		}
	}
	// A learning the extension copied to bridge/ is also in its backup, under the
	// same `journal:<id>`: one line, not two. Read as one more file, so an edit,
	// archive or delete made to it from any device applies here too.
	files['workpulse-backup.jsonl'] = fromBackup(cfg).map((e) => JSON.stringify(e)).join('\n')
	return fold(files, { archived })
}

/**
 * What you wrote in the extension's Learnings page, as the extension's daily
 * backup left it on the same branch (`workpulse/data/learnings/<month>.json`).
 * Read-only from here: those files belong to the backup. Each line keeps its
 * ticket by key, looked up through the backed-up tickets.
 */
function fromBackup(cfg) {
	const base = join(cfg.clone, cfg.backupDir || 'workpulse', 'data')
	const learnDir = join(base, 'learnings')
	if (!existsSync(learnDir)) return []
	const keyOf = {}
	const ticketDir = join(base, 'tickets')
	if (existsSync(ticketDir)) {
		for (const f of readdirSync(ticketDir).filter((f) => f.endsWith('.json'))) {
			try {
				const t = JSON.parse(readFileSync(join(ticketDir, f), 'utf8'))
				const key = String(t.name ?? '').match(/\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/)?.[0]
				if (t.id && key) keyOf[t.id] = key
			} catch {
				/* a half-written shard is skipped, not fatal */
			}
		}
	}
	const out = []
	for (const f of readdirSync(learnDir).filter((f) => f.endsWith('.json'))) {
		let list = []
		try {
			list = JSON.parse(readFileSync(join(learnDir, f), 'utf8'))
		} catch {
			continue
		}
		for (const l of Array.isArray(list) ? list : []) {
			if (!l?.id || !l.text) continue
			out.push({
				schema: 'workpulse.bridge.entry/1',
				id: `journal:${l.id}`,
				at: Number(l.at) || Date.parse(l.date) || 0,
				device: 'extension-learnings',
				kind: l.kind === 'mistake' ? 'mistake' : 'learning',
				scope: 'work',
				title: String(l.text).split('\n')[0].slice(0, 200),
				body: String(l.text).includes('\n') ? l.text : undefined,
				tags: Array.isArray(l.tags) ? l.tags : [],
				ticket: l.ticketId ? keyOf[l.ticketId] : undefined,
			})
		}
	}
	return out
}

function die(msg) {
	if (dieThrows) throw new Error(msg)
	console.error(msg)
	process.exit(1)
}

/** Transcript contents are never copied into a timesheet.  Claude's event
 * timestamps are only a bounded activity clock, split at idle gaps.
 * The file walk is shared (claude-files.mjs); the whole-file read below is a cost of the timesheet. */
function claudeSessions({ since, gapMinutes, maxMinutes }) {
	const projects = projectsRoot()
	const records = []
	for (const file of claudeTranscriptFiles(projects)) {
		let lines
		try { lines = readFileSync(file, 'utf8').split('\n') } catch { continue }
		const events = []
		for (const line of lines) {
			try {
				const row = JSON.parse(line)
				const at = Date.parse(row.timestamp)
				if (Number.isFinite(at) && at >= since && (row.type === 'user' || row.type === 'assistant')) events.push(at)
			} catch { /* Ignore a partially written JSONL line. */ }
		}
		events.sort((a, b) => a - b)
		if (!events.length) continue
		const project = file.slice(projects.length).split('/')[1] || 'Claude Code'
		let start = events[0]
		let last = events[0]
		const finish = () => {
			if (last - start >= 60_000) records.push({ file, project, from: start, to: last })
		}
		for (const at of events.slice(1)) {
			if (at - last > gapMinutes * 60_000 || at - start >= maxMinutes * 60_000) { finish(); start = at }
			last = at
		}
		finish()
	}
	return records.sort((a, b) => a.from - b.from)
}

const day = (t) => new Date(t).toISOString().slice(0, 10)
// A title that already starts with its ticket key does not need it twice.
// The [id] at the end is what edit, archive, restore and rm take.
const short = (e) => `${day(e.at)}  ${e.kind.padEnd(8)} ${sourceOf(e) ? `<${sourceOf(e).type}> ` : ''}${e.scope === 'personal' ? '[personal] ' : ''}${e.archived ? '[archived] ' : ''}${e.ticket ? e.ticket + ' ' : ''}${e.project ? '(' + e.project + ') ' : ''}${e.ticket && e.title.toUpperCase().startsWith(e.ticket) ? e.title.slice(e.ticket.length).replace(/^[\s:—-]+/, '') : e.title}  [${shortId(e.id)}]`

/** An entry's readable record, written once, by the device that wrote the entry. */
function writeRecord(cfg, entry) {
	const { path, content } = brainRecord(entry)
	mkdirSync(dirname(join(cfg.clone, path)), { recursive: true })
	writeFileSync(join(cfg.clone, path), content)
	return path
}

/** Where `wp-brain index` puts what is built from every device: beside the clone, never in it. */
const viewDir = (cfg) => `${cfg.clone.replace(/\/+$/, '')}-index`

// ── commands ────────────────────────────────────────────────────────────────

const SCHEMA_DOC = `# bridge/

Shared between the WorkPulse extension and the \`wp-brain\` CLI (Claude Code skill \`workpulse-brain\`).
Every file has exactly one writer — a device — so nothing ever conflicts.

| Path | Writer | What |
|---|---|---|
| \`entries/<YYYY-MM>/<device>.jsonl\` | that device | One entry per line (\`workpulse.bridge.entry/1\`) |
| \`inbox/to-cli/<ts>-<id>.json\` | the extension | A request for the CLI |
| \`inbox/acks/<device>/<id>.json\` | the CLI device | "Picked that up": \`{ id, at, by, state?, why? }\`, state \`claimed\`, \`done\` or \`failed\` (none means done); the earliest \`at\` owns a saved page |
| \`records/<device>/<YYYY-MM>/*.md\` | that device | A readable copy of each entry, written once |
| \`library/<type>/<folder>/\` | the device named in its \`.owner\` file | Opt-in text backup (\`"library": true\` in brain.json): ${LIBRARY_FILES.join(', ')}; at most 2 MB each, never media, each file checked for secrets |
| \`config/<device>/\` | that device | Opt-in (same switch) text copy of \`~/.claude\`: \`CLAUDE.md\`, \`RTK.md\`, the text files of \`rules/\` and \`rule-files/\` (the rules a split moved out of \`CLAUDE.md\`, and the map that finds them), and the text files of \`skills/<name>/\` (symlinked skills, hidden folders, files and folders with sensitive names such as \`.env\`, \`*.pem\` or \`*token*\`, \`node_modules\`, \`.git\`, binaries and files over 2 MB are left out); each file checked for secrets, restored with \`wp-brain config restore\` |

Entry kinds: ${KINDS.join(', ')}. Scope: \`work\` or \`personal\`.
Fields: id, at (epoch ms), device, kind, scope, title, subtitle, body (Markdown), ticket, project, tags,
asked, done, rootCause, status, next[], links { pr, commits[], related[], urls[] }, source { type, url, title, by, library }
(type: ${SOURCE_TYPES.join(', ')}; where a lesson came from — optional, older entries have none).

The extension's backup folder (\`workpulse/\`) is never written from here. The index and graph are
built on read (\`wp-brain index\`, the extension's Brain page), so no file is shared between writers.
The database search and recall read from (\`~/.workpulse/brain.db\`) is local to each machine, rebuilt from this
folder, safe to delete, and never committed.
Videos and database backups never come here: \`wp-brain vault\` keeps them as release assets in a separate private repository,
whose git history holds only \`manifest/<device>.json\` (name, size, checksum, date), each written by that device.
`

// ── session memory: search, show, backfill (the data lives in cli/memory-db.mjs and cli/memory-capture.mjs) ──

const memoryOnIn = () => {
	try {
		return JSON.parse(readFileSync(CONFIG, 'utf8'))?.memory === true
	} catch {
		return false
	}
}

/** `30d`, `12h`, `2w`, `45m` as a time that long ago, in ms; dies on anything else. */
function sinceTime(text) {
	const m = String(text).match(/^(\d+(?:\.\d+)?)([hmwd])$/i)
	if (!m) die('Use --since like 8h, 2d or 1w.')
	const unit = { m: 60_000, h: 3_600_000, d: DAY, w: 7 * DAY }[m[2].toLowerCase()]
	return Date.now() - Number(m[1]) * unit
}

async function openForRecall() {
	const { memoryDbPath } = await import(join(here, 'claude-files.mjs'))
	const { openMemory } = await import(join(here, 'memory-db.mjs'))
	if (!existsSync(memoryDbPath())) die('No session memory yet. Turn it on with: wp-brain memory on')
	try {
		return { db: openMemory(memoryDbPath(), { readOnly: true }), memory: await import(join(here, 'memory-db.mjs')) }
	} catch (error) {
		return die(`Session memory cannot be opened (${error?.code || 'error'}). Run: wp-brain memory status`)
	}
}

const dayOf = (ms) => (Number.isFinite(ms) ? day(ms) : 'unknown date')

/** `wp-brain memory search "words"`: the masked text of your sessions, never recall's or the brief's source. */
async function memorySearchCommand({ pos, opt }) {
	const text = pos.join(' ').trim()
	if (!text) die('Usage: wp-brain memory search "words" [--repo R] [--role prompt|answer] [--session ID] [--agents] [--since 30d] [--limit N] [--json] | "words" --archive [--type T] [--project P]')
	if (opt.archive === true) return memoryArchiveSearch({ text, opt })
	if (opt.type !== undefined || opt.project !== undefined) die('--type and --project go with --archive.')
	if (opt.role !== undefined && !['prompt', 'answer'].includes(opt.role)) die('--role is prompt or answer.')
	const { db, memory } = await openForRecall()
	try {
		const limit = opt.limit === undefined ? 10 : Number(opt.limit)
		if (!Number.isInteger(limit) || limit < 1) die('--limit is a whole number of 1 or more.')
		if (limit > 100) console.error('--limit is capped at 100; showing at most 100.')
		const hits = memory.searchMemory(db, text, {
			repo: typeof opt.repo === 'string' ? opt.repo : undefined, role: opt.role, session: typeof opt.session === 'string' ? opt.session : undefined,
			agents: opt.agents === true, since: opt.since === undefined ? undefined : sinceTime(opt.since), limit,
		})
		if (opt.json) return console.log(JSON.stringify(hits))
		if (!hits.length) return console.log('Nothing in your sessions matches. Fewer or shorter words find more; --agents adds subagent text.')
		for (const h of hits) console.log(`${dayOf(h.at)}  ${h.role}  ${h.repo ? basename(h.repo) : '-'}  ${h.session_id.slice(0, 8)}  ${h.snippet}`)
		console.log('Open one: wp-brain memory show SESSION [--text]')
	} finally {
		db.close()
	}
}

/** `wp-brain memory search "words" --archive`: claude-mem's imported history, the only way to reach it. */
async function memoryArchiveSearch({ text, opt }) {
	for (const k of ['repo', 'role', 'session']) if (opt[k] !== undefined) die(`--${k} does not apply to the archive; it takes --type, --project, --since and --limit.`)
	if (opt.agents === true) die('--agents does not apply to the archive.')
	const { db } = await openForRecall()
	try {
		const limit = opt.limit === undefined ? 10 : Number(opt.limit)
		if (!Number.isInteger(limit) || limit < 1) die('--limit is a whole number of 1 or more.')
		const { searchArchive } = await import(join(here, 'memory-archive.mjs'))
		const hits = searchArchive(db, text, {
			type: typeof opt.type === 'string' ? opt.type : undefined, project: typeof opt.project === 'string' ? opt.project : undefined,
			since: opt.since === undefined ? undefined : sinceTime(opt.since), limit,
		})
		if (opt.json) return console.log(JSON.stringify(hits))
		if (!hits.length) return console.log('Nothing in the archive matches. Fewer or shorter words find more. Is it imported? wp-brain memory import-claude-mem')
		for (const h of hits) console.log(`${dayOf(h.at)}  ${h.type ?? '-'}  ${h.project ?? '-'}  ${h.source_table}:${h.source_id}  ${h.snippet}`)
		console.log('These are old records from claude-mem: a clue to check, not a fact.')
	} finally {
		db.close()
	}
}

/** `wp-brain memory import-claude-mem`: explicit, never from a hook. Reads claude-mem's database read-only; writes only the archive. */
async function memoryImportCommand({ opt }) {
	const { importClaudeMem, defaultClaudeMemPath } = await import(join(here, 'memory-archive.mjs'))
	if (opt.db === true) die('--db needs a path.')
	const source = typeof opt.db === 'string' ? opt.db : defaultClaudeMemPath()
	const { memoryDbPath } = await import(join(here, 'claude-files.mjs'))
	const { openMemory, isBusyError, errorCode } = await import(join(here, 'memory-db.mjs'))
	if (!existsSync(source)) die(`claude-mem's database is not at ${source}. Pass --db PATH.`) // before the memory database is opened, which would create it
	let db = null
	try {
		if (opt['dry-run'] === true) {
			if (existsSync(memoryDbPath())) {
				try { db = openMemory(memoryDbPath(), { readOnly: true }) } catch { db = null } // no tables yet: everything would be new
			}
			let n
			try {
				n = await importClaudeMem(db, source, { dryRun: true })
			} catch (error) {
				if (!db || /no such table/i.test(String(error?.message))) n = await importClaudeMem(null, source, { dryRun: true }) // an old memory db without import_state: all new
				else throw error
			}
			console.log(`Dry run: ${n.observations} observations, ${n.summaries} summaries and ${n.prompts} prompts would be added to the archive. Nothing was written.`)
			return
		}
		try {
			db = openMemory()
		} catch (error) {
			return die(`Session memory cannot be opened (${error?.code || 'error'}). Run: wp-brain memory status`)
		}
		const n = await importClaudeMem(db, source)
		console.log(`Imported into the archive: ${n.observations} observations, ${n.summaries} summaries, ${n.prompts} prompts${n.skipped ? `, ${n.skipped} skipped (masking failed)` : ''}. claude-mem was only read.`)
		console.log('Search it with: wp-brain memory search "words" --archive')
	} catch (error) {
		if (error?.code === 'ERR_ARCHIVE_NO_SOURCE' || error?.code === 'ERR_ARCHIVE_SCHEMA') return die(error.message)
		if (isBusyError(error)) return die('A database was busy. Nothing is lost: run the same command again to carry on.')
		return die(`The import stopped (${errorCode(error)}). Run it again to carry on; claude-mem was not changed.`)
	} finally {
		db?.close()
	}
}

/** `wp-brain memory promote`: on request only. Without --json it lists unpromoted decisions or bugfixes (writes nothing); with --json it turns the
 * reviewed ones into Brain lessons, at most 20, using the titles given: no archived text is copied. The entry is written first and the row marked
 * after, so a stop between the two is mended by the next run (the entry is found by its source marker, not written twice). */
async function memoryPromoteCommand({ opt }) {
	const archive = await import(join(here, 'memory-archive.mjs'))
	const fail = (error) => (error?.code === 'ERR_PROMOTE' ? die(error.message) : Promise.reject(error))
	if (opt.json === undefined) {
		const { db } = await openForRecall()
		try {
			const rows = archive.promotionCandidates(db, { type: opt.type, project: typeof opt.project === 'string' ? opt.project : undefined, query: typeof opt.query === 'string' ? opt.query : undefined, limit: opt.limit === undefined ? archive.PROMOTE_MAX : Number(opt.limit) })
			if (!rows.length) return console.log('Nothing unpromoted matches.')
			for (const r of rows) console.log(`${r.id}  ${dayOf(r.at)}  ${r.project ?? '-'}  ${r.title ?? '-'}\n    ${r.text}`)
			console.log('Review, then write a title for each lesson in a JSON file: [{ "id", "title", "body"?, "tags"?, "scope"? }], and run: wp-brain memory promote --json FILE [--no-push]')
		} catch (error) {
			return fail(error)
		} finally {
			db.close()
		}
		return
	}
	let items
	try {
		items = JSON.parse(opt.json === true || opt.json === '-' ? readFileSync(0, 'utf8') : readFileSync(opt.json, 'utf8'))
	} catch (error) {
		return die(`The JSON could not be read (${error?.code || 'not valid JSON'}).`)
	}
	const { memoryDbPath } = await import(join(here, 'claude-files.mjs'))
	if (!existsSync(memoryDbPath())) die('No session memory yet. Nothing to promote.')
	const { openMemory } = await import(join(here, 'memory-db.mjs'))
	let db
	try {
		db = openMemory()
	} catch (error) {
		return die(`Session memory cannot be opened (${error?.code || 'error'}). Run: wp-brain memory status`)
	}
	try {
		let plan
		try {
			plan = archive.promotionPlan(db, items)
		} catch (error) {
			return await fail(error)
		}
		for (const p of plan) {
			const found = secretsIn(JSON.stringify(p.input))
			if (found.length) die(`Item ${p.id} looks like it holds a ${found.join(', ')}. Take it out. Nothing was promoted.`)
		}
		const todo = plan.filter((p) => !p.promoted)
		if (!todo.length) return console.log('Nothing new: every item was promoted before.')
		const cfg = config()
		pull(cfg)
		const known = readAll(cfg)
		const marks = []
		const fresh = []
		for (const p of todo) {
			const there = known.find((e) => e.source?.title === p.input.source.title)
			if (there) marks.push({ id: p.id, entry: there.id }) // written by an earlier run that stopped before marking
			else fresh.push(p)
		}
		if (fresh.length) {
			const done = addEntries(cfg, fresh.map((p) => p.input), { push: !opt['no-push'], force: true })
			fresh.forEach((p, i) => marks.push({ id: p.id, entry: done[i].entry.id }))
		} else if (!opt['no-push']) {
			// Every lesson was written by an earlier run. If that run's push failed, they are still only here.
			try {
				git(cfg, 'push', '--quiet', 'origin', 'HEAD')
			} catch {
				die('The lessons are written here but could not be pushed, so nothing was marked. Run: wp-brain sync')
			}
		}
		archive.markPromoted(db, marks)
		console.log(`Promoted ${marks.length} (${fresh.length} new lesson${fresh.length === 1 ? '' : 's'}, ${marks.length - fresh.length} found already written). The archive rows are marked and no longer listed.`)
	} finally {
		db.close()
	}
}

/** `wp-brain memory compare [--since 14d]`: a report of which sessions each side has. Changes neither database. */
async function memoryCompareCommand({ opt }) {
	const { compareWithClaudeMem, defaultClaudeMemPath } = await import(join(here, 'memory-archive.mjs'))
	if (opt.db === true) die('--db needs a path.')
	const source = typeof opt.db === 'string' ? opt.db : defaultClaudeMemPath()
	const { db } = await openForRecall()
	try {
		const rows = await compareWithClaudeMem(db, source, { since: sinceTime(opt.since ?? '14d') })
		if (opt.json) return console.log(JSON.stringify(rows))
		if (!rows.length) return console.log('No sessions on either side in that period.')
		console.log('day         sessions  ours  theirs  only-theirs  only-ours')
		for (const r of rows) console.log(`${r.day}  ${String(r.sessions).padStart(8)}  ${String(r.ours).padStart(4)}  ${String(r.theirs).padStart(6)}  ${String(r.missedByUs).padStart(11)}  ${String(r.missedByThem).padStart(9)}`)
		console.log("Note: claude-mem's own worker sessions are counted in 'only-theirs', so that column runs high.")
	} catch (error) {
		if (error?.code === 'ERR_ARCHIVE_NO_SOURCE' || error?.code === 'ERR_ARCHIVE_SCHEMA') return die(error.message)
		throw error
	} finally {
		db.close()
	}
}

/** `wp-brain memory show SESSION`: facts and summary; the full masked text only with --text. */
async function memoryShowCommand({ pos, opt }) {
	if (!pos[0]) die('Usage: wp-brain memory show SESSION [--text]')
	const { db, memory } = await openForRecall()
	try {
		const got = memory.showSession(db, pos[0], { text: opt.text === true })
		if (!got) return die(`No session starts with ${pos[0].slice(0, 40)}.`)
		if (got.ambiguous) return die(`More than one session starts with that: ${got.ambiguous.map((i) => i.slice(0, 12)).join(', ')}. Use more of the id.`)
		const f = got.facts
		console.log(`Session ${f.id}`)
		console.log(`${dayOf(f.started_at)} to ${dayOf(f.last_event_at)} · ${Math.round(f.active_ms / 60_000)} min active · ${f.prompts} prompts · ${f.answers} answers`)
		console.log(`repo ${f.repo ?? '-'} · branch ${f.branch ?? '-'}${f.ticket ? ` · ${f.ticket}` : ''} · ${f.edits} files edited`)
		if (f.title) console.log(`title: ${f.title}`)
		for (const c of f.commits.slice(0, 10)) console.log(`commit ${c.sha.slice(0, 8)} ${c.subject ?? ''}`)
		console.log(got.summary ? `summary: ${got.summary}${got.next ? `\nnext: ${got.next}` : ''}` : 'no summary written')
		if (got.messages) for (const m of got.messages) console.log(`\n[${m.role} ${dayOf(m.at)}]\n${m.text}`)
		else console.log('The full text: add --text.')
	} finally {
		db.close()
	}
}

/** `wp-brain memory backfill [--yes]`: explicit, never from a hook. A dry run lists files and bytes and writes nothing, not even the database. */
async function memoryBackfillCommand({ opt }) {
	if (!memoryOnIn()) die('Session memory is off. Turn it on first with: wp-brain memory on')
	const { backfillPlan, backfill } = await import(join(here, 'memory-capture.mjs'))
	const plan = backfillPlan()
	const mb = (plan.bytes / 1048576).toFixed(1)
	if (opt.yes !== true) {
		console.log(`Dry run: ${plan.files.length} session files (${plan.main} main, ${plan.files.length - plan.main} subagent), ${mb} MB on disk. Nothing was written.`)
		console.log('Backfill reads everything on disk, including any period capture was off, and keeps it masked in your local database. Run: wp-brain memory backfill --yes')
		return
	}
	const { loadMask, openMemory } = await import(join(here, 'memory-db.mjs'))
	await loadMask()
	let db
	try {
		db = openMemory()
	} catch (error) {
		return die(`Session memory cannot be opened (${error?.code || 'error'}). Run: wp-brain memory status`)
	}
	try {
		const done = backfill(db, plan, { onProgress: ({ done: n, total, bytes }) => console.log(`backfill ${n}/${total} files, ${(bytes / 1048576).toFixed(1)} MB read`) })
		console.log(`Backfill ${done.stopped ? 'stopped early (database busy): run it again to carry on' : 'done'}: ${done.files} files, ${done.rows} rows added${done.errors ? `, ${done.errors} files failed (${done.lastErrorCode})` : ''}${done.skipped ? `, ${done.skipped} lines skipped` : ''}${done.drift ? `, file format changed (${done.drift})` : ''}.`)
		if (done.errors || done.stopped) process.exitCode = 1
	} finally {
		db.close()
	}
}

/** `wp-brain memory export`: counts only on screen, as the text stays in the files. */
async function memoryExportCommand({ opt }) {
	const dbPath = memoryDbPath()
	if (!existsSync(dbPath)) die(`There is no session database at ${dbPath}. Turn it on with: wp-brain memory on`)
	let since
	if (opt.since !== undefined) {
		since = /^\d+(?:\.\d+)?[hmwd]$/i.test(String(opt.since)) ? sinceTime(opt.since) : Date.parse(String(opt.since))
		if (!Number.isFinite(since)) die('Use --since like 2026-10-01 or 30d.')
	}
	const { openMemory } = await import(join(here, 'memory-db.mjs'))
	const { assertOutsideBrain, exportSessions } = await import(join(here, 'memory-export.mjs'))
	const root = sessionsMdDir()
	const cfg = existsSync(CONFIG) ? config() : {}
	if (existsSync(CONFIG)) assertOutsideBrain(root, cfg.clone)
	const refusal = (await import(join(here, 'auto-backup.mjs'))).icloudRefusal(cfg, root)
	if (refusal) die(`Refused: ${refusal}.`)
	const db = openMemory(dbPath, { readOnly: true })
	try {
		const r = exportSessions(db, { root, since, session: typeof opt.session === 'string' ? opt.session : undefined })
		console.log(`Session files: ${r.written} written, ${r.unchanged} unchanged, ${r.kept} left alone (no marked block), ${r.errors} failed, in ${root}`)
		if (r.errors) process.exitCode = 1
	} finally {
		db.close()
	}
}

/** `wp-brain memory audit`: the proof that masking held, as counts. Reads every stored text column; prints rows checked and shape names, never a value. */
async function memoryAuditCommand() {
	const dbPath = memoryDbPath()
	if (!existsSync(dbPath)) die(`There is no session database at ${dbPath}. Turn it on with: wp-brain memory on`)
	const { openMemory } = await import(join(here, 'memory-db.mjs'))
	const { fileSecretsIn } = await import(join(here, 'library.mjs'))
	const db = openMemory(dbPath, { readOnly: true })
	try {
		const shapes = new Map()
		let checked = 0
		let hits = 0
		for (const [table, columns] of [['messages', ['text']], ['summaries', ['text', 'next']], ['sessions', ['title', 'repo', 'cwd', 'branch', 'ticket']], ['session_commits', ['subject']], ['archive', ['project', 'title', 'text']], ['session_files', ['path']], ['commit_calls', ['dirs']], ['files', ['path']], ['capture_log', ['detail']]]) {
			let rows = 0
			for (const row of db.prepare(`SELECT ${columns.join(', ')} FROM ${table}`).iterate()) {
				rows++
				const found = new Set(columns.flatMap((c) => (typeof row[c] === 'string' ? fileSecretsIn(row[c]) : [])))
				if (found.size) hits++
				for (const name of found) shapes.set(name, (shapes.get(name) ?? 0) + 1)
			}
			checked += rows
			console.log(`${table.padEnd(16)} ${rows} rows`)
		}
		for (const [name, n] of [...shapes].sort()) console.log(`  ${name}: ${n}`)
		console.log(`Rows checked: ${checked}. Rows with a secret shape: ${hits}.`)
		if (hits) process.exitCode = 1
	} finally {
		db.close()
	}
}

/** `wp-brain memory unpack DB --to DIR`. */
async function memoryUnpackCommand({ pos, opt }) {
	if (!pos[0] || typeof opt.to !== 'string') die('Usage: wp-brain memory unpack DB --to DIR')
	const { unpack } = await import(join(here, 'session-pack.mjs'))
	const { files } = unpack(pos[0], resolve(opt.to))
	console.log(`Unpacked ${files} files into ${resolve(opt.to)}.`)
}

/** Writes entries to this device's file and commits them (pushing unless `push` is false). The same title twice is pointed at, not added,
 * unless `force`. Returns one { entry, created } per input, in order, so a caller can tell what already existed. Shared by `add` and
 * `memory promote`. */
function addEntries(cfg, inputs, { push = true, force = false } = {}) {
	pull(cfg)
	const now = Date.now()
	const written = new Set()
	const results = []
	const known = force ? [] : readAll(cfg)
	let n = 0
	for (const input of inputs) {
		const { schema, id, at, device, archived, editedAt, ...rest } = input
		const scope = rest.scope === 'personal' ? 'personal' : 'work'
		// The same thing said twice is noise in every brief: point at the one there is.
		const same = !rest.amends && duplicateOf(known, rest.kind, String(rest.title ?? ''), rest.ticket ? String(rest.ticket).toUpperCase() : undefined)
		if (same) {
			console.log(`= already there: ${short(same)}  (edit it with: wp-brain edit ${shortId(same.id)} …; --force adds anyway)`)
			results.push({ entry: same, created: false })
			continue
		}
		const entry = newEntry({ ...rest, scope, kind: rest.kind }, cfg.device, now + n++) // throws on anything secret-shaped
		const rel = entriesPath(entry.at, cfg.device)
		const abs = join(cfg.clone, rel)
		mkdirSync(dirname(abs), { recursive: true })
		writeFileSync(abs, appendLine(existsSync(abs) ? readFileSync(abs, 'utf8') : null, entry))
		written.add(rel)
		if (!entry.amends) written.add(writeRecord(cfg, entry))
		console.log(`+ ${short(entry)}`)
		results.push({ entry, created: true })
	}
	if (!written.size) {
		console.log('Nothing new to save.')
		return results
	}
	const first = inputs[0]
	const what = inputs.length === 1 ? `${first.kind} — ${String(first.title).slice(0, 60)}` : `${inputs.length} entries${first.ticket ? ' for ' + first.ticket : ''}`
	const pushed = commitAndPush(cfg, [...written], `bridge: ${what}`, push)
	console.log(pushed && push ? 'Pushed.' : 'Committed locally.')
	return results
}

const commands = {
	init({ pos, opt }) {
		const repo = pos[0]
		if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) die('Usage: wp-brain init owner/repo [--branch NAME] [--create] [--steps] [--clone DIR] [--device NAME]')
		const clone = opt.clone || process.env.WP_BRAIN_CLONE || join(homedir(), '.workpulse', 'brain')
		const device = opt.device || `cli-${hostname().split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '')}`
		if (!validDevice(device)) die(`--device must be letters, digits, dots, dashes or underscores (not "." or ".."), got "${device}".`)
		if (!opt['allow-public'] && repoVisibility(repo) === 'public') die(`${repo} is a public repository, and anyone could read your learning there. Use a private one, or pass --allow-public if that is what you want. Nothing was changed.`)
		const branch = typeof opt.branch === 'string' ? opt.branch : null
		// --create: a repository that doesn't exist yet is made private first (gh).
		if (opt.create && !existsSync(join(clone, '.git'))) console.log(`${repo}: ${ensureRepo({ repo, create: true })}`)
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
		const op = unfinishedOp({ clone })
		if (op) die(unfinishedMessage({ clone }, op))
		let library = false
		let configSkip = null
		let vault = null
		let memory = {}
		try {
			const old = JSON.parse(readFileSync(CONFIG, 'utf8'))
			// Nor turn session memory off, or forget the day it first started. Only what is really set is carried over.
			memory = Object.fromEntries(['memory', 'capture_since', 'capture_resumed_at', 'backup', 'movedFrom'].filter((k) => old[k] !== undefined).map((k) => [k, old[k]]))
			library = old.library === true // setting up again must not turn the backup off
			if (Array.isArray(old.configSkip)) configSkip = old.configSkip // nor forget what it leaves out
			if (old.vault) vault = old.vault // nor turn the vault off and forget its offline copy
		} catch {
			/* no config yet */
		}
		const cfg = { repo, clone, device, ...(branch ? { branch } : {}), ...(library ? { library } : {}), ...(configSkip ? { configSkip } : {}), ...(vault ? { vault } : {}), ...memory }
		mkdirSync(dirname(CONFIG), { recursive: true })
		writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n')
		pull(cfg) // a clone that is behind must not write SCHEMA.md on top of an older copy of it
		const doc = join(clone, ROOT, 'SCHEMA.md')
		// Older text is brought up to date; a link, here or above, is not followed, and a folder of that name is left alone.
		const schemaNow = linkFree(clone, ROOT, 'SCHEMA.md') ? (existsSync(doc) ? (lstatSync(doc).isFile() ? readFileSync(doc, 'utf8') : SCHEMA_DOC) : null) : SCHEMA_DOC
		if (schemaNow !== SCHEMA_DOC) {
			mkdirSync(dirname(doc), { recursive: true })
			writeFileSync(doc, SCHEMA_DOC)
			commitAndPush(cfg, [`${ROOT}/SCHEMA.md`], 'bridge: describe the folder', !opt['no-push'])
		}
		console.log(`Ready. ${repo}${branch ? ` (branch ${branch})` : ''} at ${clone}; this machine writes as ${device}.\nConfig: ${CONFIG}`)
		if (opt.steps) console.log(`\n${extensionSteps({ repo, branch, tokenUrl: bridge.tokenUrl })}`)
		else if (branch) console.log(`In the extension: Settings → Backup → repository ${repo}, branch ${branch}.`)
	},

	/** First run: the answers the skill asks for, then the repository, the skills and session memory (cli/connect.mjs). */
	async connect({ opt }) {
		const { connect } = await import('./connect.mjs')
		try {
			console.log(await connect({ opt, config: CONFIG, init: commands.init, backupSkills: () => commands.config({ pos: ['backup'], opt: {} }), defaultName: bridge.DEFAULT_REPO_NAME, tokenUrl: bridge.tokenUrl }))
		} catch (e) {
			die(e.message)
		}
	},

	async move({ pos, opt }) {
		const cfg = config()
		const op = unfinishedOp(cfg)
		if (op) die(unfinishedMessage(cfg, op))
		const { afterMove, catchUp, describePlan, planMove, runMove } = await import('./repo-move.mjs')
		const g = (...a) => git(cfg, ...a)
		try {
			if (opt['catch-up']) {
				const { from, brought } = catchUp({ cfg, git: g })
				console.log(brought ? `Brought ${brought} commit${brought === 1 ? '' : 's'} across from ${from}.` : `Nothing new in ${from}.`)
				return
			}
			pull(cfg)
			const exists = repoExists(pos[0])
			const plan = planMove({ cfg, target: pos[0], git: g, exists })
			if (!opt.yes) return console.log(describePlan(plan, cfg))
			const saveConfig = (next) => writeFileSync(CONFIG, JSON.stringify(next, null, 2) + '\n')
			const moved = runMove({ plan, cfg, git: g, saveConfig })
			console.log(afterMove({ from: moved.from, to: moved.to, branch: plan.branch }))
		} catch (e) {
			die(e.stderr ? `${e.message}\n${e.stderr}` : e.message)
		}
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
					subtitle: typeof opt.subtitle === 'string' ? opt.subtitle : undefined,
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
					source: sourceFrom(opt),
				},
			]
		}
		return addEntries(cfg, inputs, { push: !opt['no-push'], force: opt.force })
	},

	/** A compact, explicit interval for WorkPulse's local timesheet. It is never
	 * sent to Zoho by this CLI; the extension imports it and keeps the final
	 * Zoho push behind the user's button. */
	worklog({ pos, opt }) {
		const text = pos.join(' ').trim()
		if (!text) die('Usage: wp-brain worklog "what you did" --minutes 30 [--job ZOHO_JOB_ID], or --from ISO --to ISO.')
		if (secretsIn(text).length) die('Work-log text looks like it contains a secret; it was not saved.')
		const now = Date.now()
		const to = opt.to ? Date.parse(String(opt.to)) : now
		const minutes = Number(opt.minutes)
		const from = opt.from ? Date.parse(String(opt.from)) : Number.isFinite(minutes) && minutes > 0 ? to - Math.round(minutes) * 60_000 : NaN
		if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) die('Give a positive --minutes value, or valid --from and --to ISO times.')
		if (to - from > 12 * 60 * 60_000) die('A work-log interval cannot be longer than 12 hours.')
		const cfg = config()
		pull(cfg)
		const record = { schema: 'workpulse.worklog/1', id: crypto.randomUUID(), at: now, device: cfg.device, from, to, text: text.slice(0, 500), ...(opt.job ? { jobId: String(opt.job) } : {}), ...(opt.ticket ? { ticket: String(opt.ticket).toUpperCase() } : {}) }
		const rel = `${ROOT}/worklogs/${new Date(from).toISOString().slice(0, 7)}/${cfg.device}.jsonl`
		const abs = join(cfg.clone, rel)
		mkdirSync(dirname(abs), { recursive: true })
		writeFileSync(abs, `${existsSync(abs) ? readFileSync(abs, 'utf8').replace(/\n*$/, '\n') : ''}${JSON.stringify(record)}\n`)
		const pushed = commitAndPush(cfg, [rel], `worklog: ${text.slice(0, 60)}`, !opt['no-push'])
		console.log(`Work log saved: ${Math.round((to - from) / 60_000)}m${record.jobId ? ` · ${record.jobId}` : ''}${pushed && !opt['no-push'] ? ' · synced to WorkPulse' : ' · committed locally'}.`)
	},

	/** Turn local Claude Code activity into conservative, reviewable WorkPulse
	 * intervals.  The browser still imports these locally and the user makes the
	 * final, visible Zoho push. */
	'scan-claude'({ opt }) {
		const sinceText = String(opt.since ?? '24h')
		const duration = sinceText.match(/^(\d+(?:\.\d+)?)([hmwd])$/i)
		if (!duration) die('Use --since like 8h, 2d or 1w.')
		const unit = duration[2].toLowerCase()
		const multiplier = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : unit === 'd' ? DAY : 7 * DAY
		const gapMinutes = Number(opt.gap ?? 20)
		const maxMinutes = Number(opt['max-session'] ?? 120)
		if (!Number.isFinite(gapMinutes) || gapMinutes < 1 || gapMinutes > 120) die('--gap must be between 1 and 120 minutes.')
		if (!Number.isFinite(maxMinutes) || maxMinutes < 5 || maxMinutes > 120) die('--max-session must be between 5 and 120 minutes.')
		const now = Date.now()
		const sessions = claudeSessions({ since: now - Number(duration[1]) * multiplier, gapMinutes, maxMinutes })
		if (!sessions.length) return console.log('No Claude Code intervals found. Nothing was logged.')
		const cfg = config()
		pull(cfg)
		const changes = new Map()
		let added = 0
		for (const session of sessions) {
			const safeProject = session.project.replace(/^[-_]+|[-_]+$/g, '').replace(/[-_]+/g, ' ').slice(-120) || 'Claude Code'
			const id = `claude:${createHash('sha256').update(`${session.file}:${session.from}:${session.to}`).digest('hex').slice(0, 32)}`
			const rel = `${ROOT}/worklogs/${new Date(session.from).toISOString().slice(0, 7)}/${cfg.device}.jsonl`
			const current = changes.get(rel) ?? (existsSync(join(cfg.clone, rel)) ? readFileSync(join(cfg.clone, rel), 'utf8') : '')
			if (current.split('\n').some((line) => line.includes(`"id":"${id}"`))) continue
			const record = { schema: 'workpulse.worklog/1', id, at: now, device: cfg.device, from: session.from, to: session.to, text: `Claude Code work · ${safeProject}`, source: 'claude-transcript', ...(opt.job ? { jobId: String(opt.job) } : {}), ...(opt.ticket ? { ticket: String(opt.ticket).toUpperCase() } : {}) }
			changes.set(rel, `${current.replace(/\n*$/, '\n')}${JSON.stringify(record)}\n`)
			added++
		}
		if (!added) return console.log('Claude Code intervals are already queued. Nothing new was logged.')
		for (const [rel, content] of changes) {
			const abs = join(cfg.clone, rel)
			mkdirSync(dirname(abs), { recursive: true })
			writeFileSync(abs, content)
		}
		const pushed = commitAndPush(cfg, [...changes.keys()], `worklog: ${added} Claude Code interval${added === 1 ? '' : 's'}`, !opt['no-push'])
		console.log(`${added} Claude Code interval${added === 1 ? '' : 's'} saved (idle gap ${gapMinutes}m; each no longer than ${maxMinutes}m)${pushed && !opt['no-push'] ? ' · synced to WorkPulse.' : ' · committed locally.'}`)
	},

	brief({ pos, opt }) {
		const cfg = config()
		pull(cfg, { reading: true })
		const key = pos[0]?.toUpperCase()
		const project = typeof opt.project === 'string' ? opt.project : undefined
		const sections = briefSections(cfg, readAll(cfg), key, project, typeof opt.about === 'string' ? opt.about : '')
		console.log(sections.length ? capBrief(sections, { key, project, full: !!opt.full }) : 'Nothing recorded yet.')
	},

	/** One entry in full: what lists and the capped brief leave out (body, root cause, next steps). */
	show({ pos }) {
		const cfg = config()
		pull(cfg, { reading: true })
		const e = pick(readAll(cfg, true), pos[0])
		console.log(showText(e, short(e)))
	},

	/**
	 * For a Claude Code SessionStart hook: reads the hook's JSON on stdin, finds
	 * the ticket key in the git branch (`fix/pay-2433-…` → PAY-2433) and the
	 * project in the remote (`owner/repo`), and prints the brief as context for
	 * the session. Silent — no output, exit 0 — when the brain is not set up, the
	 * folder is not a git repository, or there is nothing recorded to say.
	 */
	hook({ opt }) {
		// --plugin: run from the Claude Code plugin. Quiet when setup already put
		// the same hook in settings.json; while nothing is linked, it asks Claude to
		// offer the link, at most once a day.
		if (opt.plugin && settingsHasHook('wp-brain.mjs hook')) return
		if (!existsSync(CONFIG)) {
			if (!opt.plugin) return
			const stamp = join(dirname(CONFIG), 'nudged-at')
			const last = existsSync(stamp) ? Number(readFileSync(stamp, 'utf8')) : 0
			if (Date.now() - last < DAY) return
			mkdirSync(dirname(stamp), { recursive: true })
			writeFileSync(stamp, String(Date.now()))
			process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: nudgeText(fileURLToPath(import.meta.url)) } }))
			return
		}
		const { cwd, session, branch, key, remote, head, input } = sessionContext()
		// After a compact the rules are no longer in front of Claude, so they may be pointed at again; lessons stay marked.
		if (session && input.source === 'compact') forgetRuleMarks(session)
		if (!branch) return
		// Remember where this session started, so the stop check can tell whether
		// it shipped anything and whether that was recorded.
		if (session) {
			mkdirSync(SESSIONS, { recursive: true })
			writeFileSync(join(SESSIONS, `${session}.json`), JSON.stringify({ at: Date.now(), cwd, branch, key, head }) + '\n')
		}
		const cfg = config()
		pull(cfg, { reading: true })
		const text = sessionBrief(cfg, { branch, key, remote })
		if (!text) return
		process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }))
	},

	/**
	 * For a Claude Code Stop hook: when a session on a ticket branch has
	 * committed since it began, and nothing has been recorded for that ticket
	 * since then, ask Claude — once per session — to record it with the
	 * workpulse-brain skill before stopping. Everything else is silent:
	 * no brain, no ticket branch, no new commits, already recorded, already
	 * asked, or Claude is already answering a stop hook.
	 *
	 * A commit is the line: work that has not been committed is not finished, and
	 * asking at every pause would be nagging.
	 */
	'stop-check'({ opt }) {
		if (opt.plugin && settingsHasHook('wp-brain.mjs stop-check')) return
		if (!existsSync(CONFIG)) return
		const { session, key, head, input } = sessionContext()
		if (!session || !key || input.stop_hook_active) return
		const markPath = join(SESSIONS, `${session}.json`)
		if (!existsSync(markPath)) return
		const mark = JSON.parse(readFileSync(markPath, 'utf8'))
		if (mark.asked || !head || head === mark.head || mark.key !== key) return
		const cfg = config()
		pull(cfg, { reading: true })
		const recorded = readAll(cfg).some((e) => e.ticket === key && e.at >= mark.at)
		if (recorded) return
		writeFileSync(markPath, JSON.stringify({ ...mark, asked: Date.now() }) + '\n')
		process.stdout.write(
			JSON.stringify({
				decision: 'block',
				reason: `This session committed work on ${key} and nothing is recorded in the WorkPulse Brain for it yet. Before stopping, use the workpulse-brain skill: write one ticket entry for ${key} (asked, done, root cause, honest status, next, PR/commits) plus any mistakes and learnings from this session with \`node ${fileURLToPath(import.meta.url)} add --json -\`. If this was trivial, say so in one line instead and stop.`,
			}),
		)
	},

	/**
	 * For a Claude Code UserPromptSubmit hook: the few past lessons (learnings, mistakes, debugs, decisions, skills) that
	 * share real words with this prompt, put in front of Claude before it answers. Reads the local clone only, so it is
	 * fast and works offline (the SessionStart brief pulls). Silent when nothing is close enough, when the Brain is not
	 * set up, and for an entry already shown in this session. `wp-brain recall "words"` prints the same thing.
	 */
	async recall({ pos, opt }) {
		if (opt.plugin && settingsHasHook('wp-brain.mjs recall')) return
		if (!existsSync(CONFIG)) return
		const typed = pos.join(' ').trim()
		const { input, session } = typed ? { input: {}, session: null } : sessionContext()
		const prompt = typed || (typeof input.prompt === 'string' ? input.prompt : '')
		const cfg = config()
		if (!existsSync(cfg.clone)) return
		const markPath = session ? join(SESSIONS, `${session}.recall.json`) : null
		const seen = new Set(markPath && existsSync(markPath) ? JSON.parse(readFileSync(markPath, 'utf8')) : [])
		const got = recallLessons(cfg, prompt, Number(opt.limit) || 3).filter((e) => !seen.has(e.id))
		const { pointers, mark } = await recallPointers(prompt, session)
		if (!got.length && !pointers.length) return typed ? console.log('Nothing recorded is close enough to that.') : undefined
		if (typed) return console.log([...pointers, ...got.map(recallLine)].join('\n'))
		const { text, kept, keptPointers } = recallText(got, pointers)
		if (markPath) {
			// Only what the cap let through counts as shown; the rest can come up on a later prompt.
			mkdirSync(SESSIONS, { recursive: true })
			if (got.length) writeFileSync(markPath, JSON.stringify([...seen, ...got.slice(0, kept).map((e) => e.id)]))
			mark(keptPointers)
		}
		process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }))
	},

	list({ opt }) {
		const cfg = config()
		pull(cfg, { reading: true })
		const all = readAll(cfg, !!opt.archived)
		if (opt.source !== undefined && opt.source !== 'none' && !SOURCE_TYPES.includes(opt.source)) die(`--source must be one of ${SOURCE_TYPES.join(', ')}, or none`)
		const bySource = (e) => opt.source === undefined || (sourceOf(e)?.type ?? 'none') === opt.source
		const got = filter(opt.archived ? all.filter((e) => e.archived) : all, { kind: opt.kind, scope: opt.scope, ticket: opt.ticket?.toUpperCase(), project: opt.project, query: opt.query }).filter(bySource)
		for (const e of got.slice(0, Number(opt.limit) || 30)) console.log(short(e))
		if (!got.length) console.log('Nothing matches.')
	},

	/** Change an entry: wp-brain edit ID --title … --body … --tags a,b --root-cause … --next … --status … --kind … */
	edit({ pos, opt }) {
		const set = {}
		const flag = { title: 'title', subtitle: 'subtitle', body: 'body', kind: 'kind', ticket: 'ticket', project: 'project', asked: 'asked', done: 'done', 'root-cause': 'rootCause', status: 'status' }
		for (const [f, key] of Object.entries(flag)) if (typeof opt[f] === 'string') set[key] = f === 'ticket' ? opt[f].toUpperCase() : opt[f]
		if (opt['body-file']) set.body = readFileSync(opt['body-file'], 'utf8')
		if (typeof opt.tags === 'string') set.tags = opt.tags.split(',').map((t) => t.trim().replace(/^#/, '').toLowerCase()).filter(Boolean)
		if (opt.next) set.next = opt.next.filter((x) => typeof x === 'string')
		const source = sourceFrom(opt)
		if (source) set.source = source
		if (set.kind && !KINDS.includes(set.kind)) die(`--kind must be one of ${KINDS.join(', ')}`)
		if ('title' in set && !set.title.trim()) die('A title cannot be empty.')
		if (!Object.keys(set).length) die('Usage: wp-brain edit ID [--title T] [--subtitle T] [--body T|--body-file F] [--tags a,b] [--root-cause T] [--next T]… [--status S] [--kind K] [--ticket K] [--project P] [--source-type T --source-url U …]')
		amend(pos[0], { set }, opt)
	},

	/** Out of lists, search and briefs; restore brings it back. */
	archive({ pos, opt }) {
		amend(pos[0], { state: 'archived' }, opt)
	},

	restore({ pos, opt }) {
		amend(pos[0], { state: 'active' }, opt)
	},

	/**
	 * Hide an entry everywhere. --purge also removes this machine's own line and
	 * record for good (only its own: every file has one writer); the repository's
	 * history still has them.
	 */
	rm({ pos, opt }) {
		const cfg = config()
		pull(cfg)
		const e = pick(readAll(cfg, true), pos[0])
		if (!opt.purge) return amend(pos[0], { state: 'deleted' }, opt)
		if (e.device !== cfg.device) die(`${shortId(e.id)} was written by ${e.device}; only that device can purge it. Without --purge it is hidden everywhere.`)
		const paths = []
		const dir = join(cfg.clone, ROOT, 'entries')
		for (const month of existsSync(dir) ? readdirSync(dir) : []) {
			const rel = `${ROOT}/entries/${month}/${cfg.device}.jsonl`
			const abs = join(cfg.clone, rel)
			if (!existsSync(abs)) continue
			const lines = readFileSync(abs, 'utf8').split('\n')
			const kept = lines.filter((l) => {
				try {
					const o = JSON.parse(l)
					return o.id !== e.id && o.amends !== e.id
				} catch {
					return true
				}
			})
			if (kept.length !== lines.length) (writeFileSync(abs, kept.join('\n')), paths.push(rel))
		}
		const record = brainRecord(e).path
		// Removed from disk only; commitAndPush stages it as a deletion.
		if (existsSync(join(cfg.clone, record))) (rmSync(join(cfg.clone, record)), paths.push(record))
		const pushed = commitAndPush(cfg, paths, `bridge: purge ${shortId(e.id)}`, !opt['no-push'])
		console.log(`Purged ${shortId(e.id)} from this machine's files${pushed && !opt['no-push'] ? ' and pushed' : ''}. It is gone from every reader; git history keeps the old commits.`)
	},

	search({ pos, opt }) {
		const query = pos.join(' ').trim()
		if (!query) die('Usage: wp-brain search "words ticket:K type:debug status:open has:next-action #tag after:7d" [--limit N]')
		const cfg = config()
		pull(cfg, { reading: true })
		const got = searchEntries(cfg, query)
		for (const { e, folder, score } of got.slice(0, Number(opt.limit) || 20)) {
			if (folder) {
				console.log(`[${score}] library  ${folder}  (${ROOT}/library/${folder})`)
				continue
			}
			console.log('[' + score + '] ' + short(e))
			if (e.subtitle) console.log('    ' + e.subtitle)
			if (e.next?.length) console.log('    next: ' + e.next.join(' · '))
		}
		if (!got.length) console.log('Nothing matches. Fewer words or filters find more; specific titles, tags and next actions are what make entries findable.')
	},

	/** The local database (cli/brain-db.mjs). --background is how a prompt asks for a rebuild it won't wait for. */
	db({ pos, opt }) {
		const [sub] = pos
		if (!['rebuild', 'status'].includes(sub)) die('Usage: wp-brain db rebuild | status')
		const cfg = config()
		const path = brainDb.dbPath()
		if (sub === 'status') return console.log(dbLine(brainDb.dbState(path, { ...dbPlace(cfg), deep: true })))
		const why = brainDb.unavailable()
		if (why) die(`No local database: ${why}. Search and recall work without it.`)
		if (opt.background) {
			// refreshLater took the lock before starting this process.
			try {
				buildDb(cfg, readAll(cfg))
			} finally {
				brainDb.unlockRebuild(path)
			}
			return
		}
		pull(cfg, { reading: true })
		const { entries, files } = buildDb(cfg, readAll(cfg))
		console.log(`${entries} entries and ${files} library file${files === 1 ? '' : 's'} → ${path} (local, never committed, safe to delete).`)
	},

	index({ opt }) {
		const cfg = config()
		pull(cfg)
		const all = readAll(cfg)
		// Only this device's records: every file keeps its one writer.
		const missing = all.filter((e) => e.device === cfg.device && !existsSync(join(cfg.clone, brainRecord(e).path)))
		const paths = missing.map((e) => writeRecord(cfg, e))
		if (paths.length) {
			const pushed = commitAndPush(cfg, paths, `bridge: ${paths.length} readable records`, !opt['no-push'])
			console.log(`${paths.length} record${paths.length === 1 ? '' : 's'} added${pushed && !opt['no-push'] ? ' and pushed' : ' locally'}.`)
		}
		const { index, graph } = brainIndex(all)
		const dir = viewDir(cfg)
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, 'INDEX.md'), index.replaceAll('](records/', `](${join(cfg.clone, ROOT, 'records')}/`))
		writeFileSync(join(dir, 'graph.json'), graph)
		console.log(`${all.length} entries → ${join(dir, 'INDEX.md')} and graph.json (built from every device; not committed).`)
	},

	/** What connects to X. Read-only: pull, read, build in memory; no database and no writes. */
	graph({ pos, opt }) {
		const cfg = config()
		pull(cfg, { reading: true })
		const all = readAll(cfg)
		const types = typeof opt.type === 'string' ? opt.type.split(',').map((t) => t.trim().toLowerCase().replace(/s$/, '')).filter(Boolean) : undefined
		const bad = types?.filter((t) => !['lesson', 'source', 'project', 'ticket', 'tag'].includes(t))
		if (bad?.length) die(`Unknown --type ${bad.join(', ')}. Use lesson, source, project, ticket, tag.`)
		const depth = Number(opt.depth) === 2 ? 2 : 1
		const limit = Number(opt.limit) > 0 ? Math.floor(Number(opt.limit)) : 20
		// `--type` narrows what is shown; the node asked about is found, and walked from, in the whole graph.
		const whole = brainGraph(all)
		const ref = pos.join(' ').trim()
		if (!ref) {
			const shown = types ? narrowGraph(whole, all, { types }) : whole
			if (opt.json) return console.log(JSON.stringify({ counts: Object.fromEntries(['lesson', 'source', 'project', 'ticket', 'tag'].map((t) => [t, shown.nodes.filter((n) => n.type === t).length])), edges: shown.edges.length, top: shown.nodes.filter((n) => n.type !== 'lesson').sort((a, b) => b.degree - a.degree).slice(0, 10) }, null, 2))
			return console.log(overviewLines(shown).join('\n'))
		}
		const { nodes, how } = findNodesHow(whole, ref, all)
		if (!nodes.length) die(`Nothing in the graph matches "${ref}". Try a ticket (PAY-123), '#tag', project:name, a lesson id from \`wp-brain list\`, or other words. \`wp-brain graph\` shows the most connected.`)
		if (how !== 'search' && nodes.length > 1) {
			console.log(`"${ref}" matches ${nodes.length} nodes; ask for one:`)
			for (const n of nodes) console.log(`  ${n.type === 'lesson' ? shortId(n.id) : n.id}   ${nodeLine(n)}`)
			return
		}
		const node = nodes[0]
		if (opt.json) {
			const near = connectionGraph(whole, node.id, { depth, types })
			return console.log(JSON.stringify({ node, how, others: nodes.slice(1), graph: near.graph, distance: near.distance }, null, 2))
		}
		if (how === 'search') {
			console.log(`"${ref}" is not an id or a name; took the closest lesson:`)
			if (nodes.length > 1) console.log(`  (other matches: ${nodes.slice(1).map((n) => `[${shortId(n.id)}]`).join(' ')})`)
		}
		console.log(connectionLines(whole, node, { depth, limit, types }).join('\n'))
	},

	report({ opt }) {
		const cfg = config()
		pull(cfg, { reading: true })
		const days = Number(opt.days) || 7
		const to = Date.now() + 1
		const entries = filter(readAll(cfg), { scope: opt.scope })
		process.stdout.write(reportMarkdown(entries, to - days * DAY, to, days === 7 ? 'Week report' : `Last ${days} days`))
	},

	inbox({ opt }) {
		const cfg = config()
		pull(cfg, { reading: !opt.ack })
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
		const saved = queueCountLine(savedCount(cfg))
		if (!list.length && !saved) console.log('Inbox empty.')
		if (saved) console.log(saved)
	},

	/**
	 * Pages saved from the extension, processed only when asked. `queue` lists; `next` claims one (the ack is pushed
	 * before anything is fetched, and the earliest ack wins); `done`, `fail` and `retry` move this device's own claim.
	 */
	async queue({ pos, opt }) {
		const [sub, id] = pos
		const cfg = config()
		if (!sub) return queueList(cfg)
		if (sub === 'next') return queueNext(cfg, opt)
		if (!['done', 'fail', 'retry'].includes(sub)) die('Usage: wp-brain queue [next [--root DIR] | done ID [--lessons N] | fail ID --why TEXT | retry ID]')
		if (!id) die(`Usage: wp-brain queue ${sub} ID`)
		pull(cfg)
		const row = queueState(cfg).find((r) => r.id === id)
		if (!row) die(`No saved page [${id}] in the queue.`)
		if (row.state === 'refused') die(`[${id}] looks like it holds a secret and is never read.`)
		if (row.owner !== cfg.device) die(row.owner ? `[${id}] belongs to ${row.owner}; only that device can change it.` : `[${id}] is not claimed yet. Run: wp-brain queue next`)
		if (sub === 'retry') {
			if (row.state !== 'failed') die(`[${id}] has not failed (it is ${row.state}).`)
			writeAck(cfg, id, { state: 'claimed' })
			console.log(`[${id}] is back in your queue; run: wp-brain queue next`)
			return
		}
		if (sub === 'fail') {
			if (typeof opt.why !== 'string' || !opt.why.trim()) die('Usage: wp-brain queue fail ID --why TEXT')
			writeAck(cfg, id, { state: 'failed', why: safeWhy(opt.why) })
			console.log(`[${id}] marked failed.`)
			return
		}
		const lessons = Number.parseInt(opt.lessons, 10)
		writeAck(cfg, id, { state: 'done', ...(lessons >= 0 ? { lessons } : {}) })
		console.log(`[${id}] done.`)
	},

	vault: async (args) => (await import(join(here, 'vault.mjs'))).runVaultCli(args, { cfg: config(), configPath: CONFIG }),

	/** Opt-in text backup of a learning folder (cli/library.mjs). */
	library({ pos, opt }) {
		const cfg = config()
		const [sub, folder] = pos
		if (!['add', 'list', 'restore'].includes(sub)) die('Usage: wp-brain library add FOLDER --type TYPE [--no-push] | list | restore [--root DIR] [--force]')
		if (!libraryEnabled(cfg)) die(`The library is off. To turn it on, add "library": true to ${CONFIG}. It then backs up notes and transcripts (text only, secrets refused) to bridge/library/ in ${cfg.repo}.`)
		if (sub === 'add') requirePrivate(cfg)
		pull(cfg, { reading: sub === 'list' })
		const owner = (f) => {
			try {
				return lstatSync(f).isFile() ? readFileSync(f, 'utf8').trim() : '?' // lstat: a link says nothing about the owner
			} catch {
				return '?'
			}
		}
		if (sub === 'list') {
			const rows = listLibrary(cfg.clone, owner)
			for (const r of rows) console.log(`${r.type}/${r.folder}  (${r.owner})`)
			if (!rows.length) console.log('Library empty.')
			return
		}
		if (sub === 'restore') {
			const root = typeof opt.root === 'string' ? opt.root : process.env.YT_LEARN_ROOT || join(homedir(), 'Documents', 'youtube-learning')
			const { copied, kept } = restoreInto(cfg.clone, root, Boolean(opt.force))
			console.log(`restored ${copied.length} file${copied.length === 1 ? '' : 's'} into ${root}`)
			for (const k of kept) console.log(`kept (already there): ${k}`)
			if (kept.length && !opt.force) console.log('use --force to replace the files that were kept')
			return
		}
		if (!folder || !existsSync(folder)) die('Usage: wp-brain library add FOLDER --type TYPE [--no-push]')
		if (!SOURCE_TYPES.includes(opt.type)) die(`--type must be one of ${SOURCE_TYPES.join(', ')}`)
		const abs = resolve(folder)
		if (!basename(abs)) die('Give the learning folder itself, not the root of a disk.')
		const rel = libraryPath(opt.type, basename(abs))
		const dest = join(cfg.clone, rel)
		const ownerFile = join(dest, OWNER_FILE)
		assertNoLinks(cfg.clone, rel)
		const tracked = trackedIn(cfg, rel)
		const links = new Set(tracked.filter((t) => t.link).map((t) => t.path))
		if (isLinkSafe(ownerFile)) links.add(`${rel}/${OWNER_FILE}`)
		if (links.size) die(`Refusing to write ${rel}: it holds a symlink (${[...links].join(', ')}). Nothing was changed. Take the link out of the Brain repository, then run again.`)
		const who = owner(ownerFile)
		if (existsSync(ownerFile) && who !== cfg.device) die(`${rel} is owned by ${who}; nothing changed.${validDevice(who) ? ` If ${who} is this machine under an old name, or a machine you no longer use, go on under that name: wp-brain init ${cfg.repo}${cfg.branch ? ` --branch ${cfg.branch}` : ''} --device ${who} --clone ${cfg.clone}` : ''}`)
		if (existsSync(dest) && !existsSync(ownerFile)) die(`${rel} is already in the Brain but has no ${OWNER_FILE} file, so it is not known to be yours. Nothing was changed; remove it or add the file by hand.`)
		const { keep, skipped } = pickFiles(abs)
		const content = Object.fromEntries(keep.map((name) => [name, readFileSync(join(abs, name))])) // read once: what is scanned is what is written
		const leaked = secretReport(keep.map((name) => ({ rel: name })), (f) => content[f.rel].toString('utf8'))
		if (leaked) die(leaked)
		if (!keep.length) die(`Nothing to back up in ${abs} (allowed: ${LIBRARY_FILES.join(', ')}).`)
		// What is tracked and not written stays in the backup (gone here, or now over the cap); what is untracked stays unpublished.
		const inBackup = tracked.map((t) => t.path.slice(rel.length + 1))
		const written = [...keep, OWNER_FILE]
		const untracked = existsSync(dest) ? readdirSync(dest).filter((n) => !written.includes(n) && !inBackup.some((p) => p === n || p.startsWith(`${n}/`))) : []
		const { unpushed } = writeExact(cfg, rel, { ...content, [OWNER_FILE]: `${cfg.device}\n` }, `bridge: library ${opt.type}/${basename(abs)}`, !opt['no-push'])
		for (const name of inBackup.filter((n) => !written.includes(n))) console.log(`kept in the backup (not copied this time): ${name}`)
		for (const name of untracked) console.log(`not backed up (untracked in the clone, left alone): ${name}`)
		if (unpushed) console.error(`${unpushed} commit${unpushed === 1 ? ' is' : 's are'} not pushed yet (wp-brain sync).`)
		for (const s of skipped) console.log(`skipped ${s.name}: ${s.why}`)
		console.log(`library: ${rel}`)
	},

	/** Old lessons get the source `sourceOf` can tell from them. One commit; dry run unless --yes. */
	'backfill-source'({ opt }) {
		const cfg = config()
		pull(cfg, { reading: !opt.yes })
		// Only an entry with no stored source; one that has it (or got it from an earlier run) is left alone.
		const todo = readAll(cfg, true).filter((e) => !e.source && sourceOf(e))
		if (!opt.yes) {
			for (const e of todo) console.log(`would set <${sourceOf(e).type}>  ${e.title}  [${shortId(e.id)}]`)
			console.log(`${todo.length} lesson${todo.length === 1 ? '' : 's'} would get a source. Run again with --yes to write them.`)
			return
		}
		const files = new Set()
		let done = 0
		for (const e of todo) {
			try {
				files.add(writeChange(cfg, e, { set: { source: sourceOf(e) } }))
				done++
			} catch (err) {
				console.error(`skipped ${shortId(e.id)}: ${err.message}`)
			}
		}
		if (files.size) commitAndPush(cfg, [...files], `bridge: set the source of ${done} older lesson${done === 1 ? '' : 's'}`, !opt['no-push'])
		console.log(`${done} lesson${done === 1 ? '' : 's'} got a source.`)
	},

	/** Opt-in text copy of ~/.claude rules and skills (cli/library.mjs). */
	config({ pos, opt }) {
		const [sub] = pos
		if (!['backup', 'restore', 'scan'].includes(sub)) die('Usage: wp-brain config backup [--no-push] | restore [--from DEVICE] [--force] | scan')
		if (sub === 'scan') {
			// Read-only: the same selection and secret check as backup, nothing written, no clone, no commit, no library switch.
			let skip = []
			try {
				skip = JSON.parse(readFileSync(CONFIG, 'utf8')).configSkip
			} catch {
				/* no config: nothing is left out */
			}
			const dir = typeof opt.home === 'string' ? join(opt.home, '.claude') : claudeDir()
			if (!existsSync(dir)) die(`${dir} doesn't exist, so there is nothing to scan.`)
			const { keep, skipped } = configFilesIn(dir, skip)
			const left = skipped.filter((x) => x.why === SKIPPED_BY_CONFIG).length
			const leaked = secretReport(keep, (f) => readFileSync(f.abs, 'utf8'))
			if (leaked) {
				console.log(leaked.split('\n').filter((l) => l.startsWith('  ')).join('\n'))
				console.log(`${keep.length} file${keep.length === 1 ? '' : 's'} checked${left ? `, ${left} left out by configSkip` : ''}. Take the secret out of each file above (or add its path to "configSkip" in ${CONFIG}).`)
				process.exitCode = 1
			} else console.log(`no secrets found in ${keep.length} file${keep.length === 1 ? '' : 's'}${left ? ` (${left} left out by configSkip)` : ''}.`)
			return
		}
		const cfg = config()
		if (!libraryEnabled(cfg)) die(`Config backup is off. To turn it on, add "library": true to ${CONFIG}. It then backs up your rules and skills (text only, secrets refused) to bridge/config/ in ${cfg.repo}.`)
		pull(cfg)
		if (!validDevice(cfg.device)) die(`The device name "${cfg.device}" in ${CONFIG} is not usable as a folder name (letters, digits, dots, dashes, underscores; not "." or ".."). Fix it, then run again.`)
		// --home DIR means DIR/.claude (tests); otherwise the folder Claude Code itself uses, as setup does.
		const claude = typeof opt.home === 'string' ? join(opt.home, '.claude') : claudeDir()
		if (sub === 'restore') {
			const devices = configDevices(cfg.clone)
			if (!devices.length) die('No config backup in the Brain yet. On the machine that has it, run: wp-brain config backup')
			const from = typeof opt.from === 'string' ? opt.from : devices.includes(cfg.device) ? cfg.device : devices.length === 1 ? devices[0] : null
			if (!from) die(`More than one machine has a backup (${devices.join(', ')}). Choose one with --from DEVICE.`)
			if (!devices.includes(from)) die(`${from} has no config backup (${devices.join(', ')}).`)
			// A CLAUDE.md holding only what setup wrote counts as empty: without this, the documented order (setup, then
			// restore) would keep the stub. The rule goes back in when the backup doesn't have it, so --force can't lose it.
			const mdPath = join(claude, 'CLAUDE.md')
			const before = lstatSync(mdPath, { throwIfNoEntry: false })?.isFile() ? readFileSync(mdPath, 'utf8') : null // a link is never read as ours
			const { copied, kept } = restoreConfig(cfg.clone, from, claude, Boolean(opt.force), before !== null && onlyRule(before) ? ['CLAUDE.md'] : [])
			const rule = before !== null && copied.includes('CLAUDE.md') ? markedRule(before) : null
			// A split moved the rule to rule-files/workpulse-brain.md: keep it there, and leave the restored core as the backup had it.
			const movedFile = join(claude, 'rule-files', 'workpulse-brain.md')
			const inRuleFiles = lstatSync(movedFile, { throwIfNoEntry: false })?.isFile() && markedRule(readFileSync(movedFile, 'utf8')) !== null
			if (rule && inRuleFiles) {
				if (placeRuleIn(claude, rule).changed) console.log('The Brain rule in rule-files/workpulse-brain.md now matches this machine.')
			} else if (rule && !holdsRule(readFileSync(mdPath, 'utf8'))) {
				writeFileSync(mdPath, placeRule(readFileSync(mdPath, 'utf8'), rule))
				console.log('The backup of CLAUDE.md had no WorkPulse Brain rule, so this machine\'s was put back in.')
			}
			console.log(`restored ${copied.length} file${copied.length === 1 ? '' : 's'} into ${claude} from ${from}`)
			for (const k of kept.slice(0, 20)) console.log(`kept (already there): ${k}`)
			if (kept.length > 20) console.log(`kept (already there): …and ${kept.length - 20} more`)
			if (kept.length && !opt.force) console.log('use --force to replace the files that were kept')
			return
		}
		requirePrivate(cfg)
		const { keep, skipped } = configFilesIn(claude, cfg.configSkip)
		// Every file is checked before anything is written; any hit stops it all, and all hits are named at once.
		const leaked = secretReport(keep, (f) => readFileSync(f.abs, 'utf8'))
		if (leaked) die(leaked)
		if (!keep.length) die(`Nothing to back up under ${claude}.`)
		const rel = configPath(cfg.device)
		const dest = join(cfg.clone, rel)
		rebuild(cfg, rel, (stage) => {
			for (const f of keep) {
				mkdirSync(dirname(join(stage, f.rel)), { recursive: true })
				copyFileSync(f.abs, join(stage, f.rel))
			}
		})
		const { changed, unpushed } = commitBackup(cfg, [rel], `bridge: config backup (${keep.length} files)`, !opt['no-push'], () => rollback(cfg, rel))
		const why = Object.entries(countWhy(skipped)).map(([k, n]) => `${n} ${k}`).join(', ')
		console.log(`config: ${rel}`)
		console.log(`kept ${keep.length} file${keep.length === 1 ? '' : 's'}, skipped ${skipped.length}${why ? ` (${why})` : ''}${changed ? '' : '; nothing changed since the last backup'}`)
		const named = skipped.filter((x) => x.why === 'sensitive name')
		for (const x of named.slice(0, 20)) console.log(`skipped (sensitive name): ${x.rel}`)
		if (named.length > 20) console.log(`skipped (sensitive name): …and ${named.length - 20} more`)
		const left = skipped.filter((x) => x.why === SKIPPED_BY_CONFIG)
		for (const x of left.slice(0, 20)) console.log(`${SKIPPED_BY_CONFIG}: ${x.rel}`)
		if (left.length > 20) console.log(`${SKIPPED_BY_CONFIG}: …and ${left.length - 20} more`)
		const leftOut = named.length + left.length
		console.log(`Left out: ${leftOut} file${leftOut === 1 ? '' : 's'} (sensitive names, configSkip)`)
		if (unpushed) console.log(`${unpushed} commit${unpushed === 1 ? ' is' : 's are'} only on this machine, not pushed yet (wp-brain sync).`)
		return { kept: keep.length, leftOut }
	},

	/** Everything, once, each part reporting for itself (cli/auto-backup.mjs). --scheduled prints numbers only; --videos adds the vault's videos. */
	async 'backup-all'({ opt }) {
		const cfg = config()
		const { backupAll } = await import(join(here, 'auto-backup.mjs'))
		const { realParts } = await import(join(here, 'backup-parts.mjs'))
		dieThrows = true
		try {
			const parts = realParts(cfg, {
				videos: opt.videos === true,
				libraryAdd: (folder, type) => commands.library({ pos: ['add', folder], opt: { type } }),
				configBackup: () => commands.config({ pos: ['backup'], opt: {} }),
			})
			const { failed } = await backupAll({ cfg, parts, scheduled: opt.scheduled === true })
			if (failed.length) process.exitCode = 1
		} finally {
			dieThrows = false
		}
	},

	/** What each part of backup-all last did, and the daily schedule. */
	async backup({ pos }) {
		const cliPath = fileURLToPath(import.meta.url)
		if (pos[0] === 'status') {
			const { backupStatusLines } = await import(join(here, 'auto-backup.mjs'))
			for (const line of await backupStatusLines(existsSync(CONFIG) ? config() : {}, { cliPath })) console.log(line)
			return
		}
		if (pos[0] === 'schedule' && pos[1] === 'on') {
			const { path, log } = (await import(join(here, 'backup-schedule.mjs'))).scheduleOn({ cliPath })
			console.log(`Daily backup on: ${path}. It runs at 03:30, or at the next wake, at low priority. Its log, numbers only: ${log}. To stop: wp-brain backup schedule off`)
			return
		}
		if (pos[0] === 'schedule' && pos[1] === 'off') {
			const was = (await import(join(here, 'backup-schedule.mjs'))).scheduleOff()
			console.log(was ? 'Daily backup off. What is already backed up stays.' : 'The daily backup was not on.')
			return
		}
		die('Usage: wp-brain backup status | schedule on|off')
	},

	/** Saves a web article into the learning folder. Needs no Brain config and makes no commit. */
	async learn({ pos, opt }) {
		if (!pos[0]) die('Usage: wp-brain learn <url> [--root DIR]')
		const root = typeof opt.root === 'string' ? opt.root : process.env.YT_LEARN_ROOT || join(homedir(), 'Documents', 'youtube-learning')
		console.log(JSON.stringify(await learn(pos[0], root)))
	},

	sync() {
		const cfg = config()
		pull(cfg)
		try {
			git(cfg, 'push', '--quiet', 'origin', 'HEAD')
		} catch {
			const n = aheadCount(cfg)
			die(`The push to ${cfg.repo} failed${n ? `: ${n} commit${n === 1 ? ' is' : 's are'} only on this machine` : ''}. Not in step; run sync again once the repository accepts pushes.`)
		}
		console.log(`In step with ${cfg.repo}.`)
	},

	/** Asks, then installs the clone, the hooks, the global rule and the skill (cli/setup.mjs). */
	setup({ opt }) {
		return setup({ opt, config: CONFIG, cliPath: fileURLToPath(import.meta.url), skillDir: join(here, '..', 'skills', 'workpulse-brain'), init: commands.init, repoName: bridge.DEFAULT_REPO_NAME, tokenUrl: bridge.tokenUrl })
	},

	/** Session capture on or off (cli/setup.mjs). `off` keeps every row. */
	async memory({ pos, opt }) {
		if (pos[0] === 'on') return memoryOn({ config: CONFIG, hookPath: join(here, 'memory-hook.mjs') })
		if (pos[0] === 'off') return memoryOff({ config: CONFIG })
		if (pos[0] === 'status') return (await import(join(here, 'memory-note.mjs'))).memoryStatus({ config: CONFIG, since: opt.since })
		if (pos[0] === 'summary') {
			const { memorySummary } = await import(join(here, 'memory-note.mjs'))
			console.log(await memorySummary({ config: CONFIG, session: opt.session, next: [].concat(opt.next ?? []).filter((n) => typeof n === 'string').join(' '), text: pos.slice(1).join(' ') }))
			return
		}
		if (pos[0] === 'search') return memorySearchCommand({ pos: pos.slice(1), opt })
		if (pos[0] === 'show') return memoryShowCommand({ pos: pos.slice(1), opt })
		if (pos[0] === 'backfill') return memoryBackfillCommand({ opt })
		if (pos[0] === 'export') return memoryExportCommand({ opt })
		if (pos[0] === 'audit') return memoryAuditCommand()
		if (pos[0] === 'unpack') return memoryUnpackCommand({ pos: pos.slice(1), opt })
		if (pos[0] === 'import-claude-mem') return memoryImportCommand({ opt })
		if (pos[0] === 'compare') return memoryCompareCommand({ opt })
		if (pos[0] === 'promote') return memoryPromoteCommand({ opt })
		die('Usage: wp-brain memory on | off | status [--since 14d] | summary --session ID [--next T] "text" | search "words" [--archive] | show SESSION [--text] | backfill [--yes] | export [--session ID] [--since DATE] | audit | unpack DB --to DIR | import-claude-mem [--db PATH] [--dry-run] | compare [--since 14d] | promote --type decision|bugfix [--project P] [--query Q] [--limit N] | promote --json FILE|- [--no-push]')
	},

	/** Every part of the link, checked. */
	doctor() {
		return doctor({ CONFIG, cliPath: fileURLToPath(import.meta.url), readAll, dbLine: (cfg) => {
			const state = brainDb.dbState(brainDb.dbPath(), { ...dbPlace(cfg), deep: true })
			return { ok: !['corrupt', 'unavailable'].includes(state.state), detail: dbLine(state) }
		} })
	},

	/** What the guard would answer for a command, to try it by hand: `wp-brain guard "git push"`. */
	async guard({ pos }) {
		if (!pos.length) die('Usage: wp-brain guard "<command>"')
		const { decide } = await import(join(here, 'guard.mjs'))
		const d = decide({ tool_name: 'Bash', tool_input: { command: pos.join(' ') }, cwd: process.cwd() })
		console.log(d ? `${d.decision}: ${d.reason}` : 'allow')
	},

	/** What instructions, skills and the Brain cost per session, in tokens. --check exits 1 when a capped row is over its target. */
	async budget({ opt }) {
		const set = existsSync(CONFIG) ? config() : null
		const cfg = set && existsSync(set.clone) ? set : null // a config whose clone is gone is not a Brain to measure
		const cwd = process.cwd()
		const result = budgetOf.measure({
			claudeDir: claudeDir(),
			cwd,
			cfg,
			brief: cfg && (() => {
				const here = sessionContext({ cwd })
				return here.branch ? sessionBrief(cfg, here) : null // the hook stays silent without a branch
			}),
			recall: cfg && ((prompt) => {
				const got = recallLessons(cfg, prompt, 3)
				return got.length ? recallText(got).text : ''
			}),
			memory: set?.memory === true ? await (await import(join(here, 'memory-note.mjs'))).memoryBudget(cwd) : undefined,
		})
		console.log(opt.json ? JSON.stringify(result, null, 2) : budgetOf.render(result))
		if (opt.check && result.over.length) process.exitCode = 1
	},

	/** Split CLAUDE.md into rule files and prove no line was lost (cli/rules.mjs). */
	async rules({ pos, opt }) {
		if (pos[0] === 'test') {
			const { rulesTestCommand } = await import(join(here, 'rules-test.mjs'))
			process.exitCode = rulesTestCommand({ opt, claude: claudeDir() })
			return
		}
		const { rulesCommand } = await import(join(here, 'rules.mjs'))
		process.exitCode = rulesCommand({ pos, opt, claude: claudeDir() })
	},

	help() {
		console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1).join('\n').split(/\n[^/]/)[0].split('\n').map((l) => l.slice(3)).join('\n'))
	},
}

/** The entry `ref` names (its [id] as lists show it), or the reason it cannot be found. */
function pick(all, ref) {
	if (!ref) die('Give the entry id, as lists show it in [brackets]. Find it with: wp-brain search "words"')
	const got = entryByRef(all, ref)
	if (got.error) die(got.error)
	return got
}

/** Writes one change line into this machine's own file, without committing. Returns the file's path in the clone. */
function writeChange(cfg, target, change) {
	const entry = newEntry({ kind: target.kind, scope: target.scope, title: target.title, amends: target.id, ...change }, cfg.device, Date.now()) // refuses secrets
	const rel = entriesPath(entry.at, cfg.device)
	const abs = join(cfg.clone, rel)
	mkdirSync(dirname(abs), { recursive: true })
	writeFileSync(abs, appendLine(existsSync(abs) ? readFileSync(abs, 'utf8') : null, entry))
	return rel
}

/** One change line in this machine's own file, applied by every reader. */
function amend(ref, change, opt) {
	const cfg = config()
	pull(cfg)
	const target = pick(readAll(cfg, true), ref)
	const rel = writeChange(cfg, target, change)
	const what = change.state ?? `edit ${Object.keys(change.set ?? {}).join(', ')}`
	const pushed = commitAndPush(cfg, [rel], `bridge: ${what} ${shortId(target.id)} — ${target.title.slice(0, 50)}`, !opt['no-push'])
	const now = readAll(cfg, true).find((e) => e.id === target.id)
	console.log(`${change.state === 'deleted' ? 'Deleted' : change.state === 'archived' ? 'Archived' : change.state === 'active' ? 'Restored' : 'Edited'}: ${now ? short(now) : target.title}${pushed && !opt['no-push'] ? '  (pushed)' : ''}`)
}

/** Where session markers live: one small file per Claude Code session. */
const SESSIONS = process.env.WP_BRAIN_SESSIONS || join(homedir(), '.workpulse', 'sessions')

/** The rule and skill pointers a prompt calls for (lines), and `mark(n)`, which records the first n as shown in this session. */
async function recallPointers(prompt, session) {
	const none = { pointers: [], mark: () => {} }
	try {
		const claude = claudeDir()
		const rules = await import(join(here, 'rules.mjs'))
		const docs = rules.loadDocs(claude)
		if (!docs.length) return none
		const file = session ? join(SESSIONS, `${session}.rules.json`) : null
		const seen = new Set(file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [])
		const hits = rules.matchDocs(prompt, docs.filter((d) => !seen.has(rules.markOf(d))))
		return {
			pointers: hits.map(rules.pointerLine),
			mark: (n) => file && n > 0 && writeFileSync(file, JSON.stringify([...seen, ...hits.slice(0, n).map((h) => rules.markOf(h.doc))])),
		}
	} catch {
		return none // a broken map or skill never costs the lessons
	}
}

/** Forget which rules were shown in a session (its main agent and its subagents), keeping the lesson marks. */
function forgetRuleMarks(session) {
	try {
		for (const f of readdirSync(SESSIONS)) if (f.startsWith(`${session}.rules.`) && f.endsWith('.json')) rmSync(join(SESSIONS, f), { force: true })
	} catch {
		/* no sessions folder yet */
	}
}

/** The SessionStart brief for a branch, within 400 tokens (`full`: all of it), or null when there is nothing recorded to say. */
function sessionBrief(cfg, { branch, key, remote }, { full = false } = {}) {
	const all = readAll(cfg)
	// Entries name a project either as owner/repo or by the repo alone.
	const project = [remote, remote?.split('/')[1]].find((p) => p && all.some((e) => e.project === p)) ?? remote
	const known = all.filter((e) => (key && (e.ticket === key || e.links?.related?.includes(key))) || (project && e.project === project))
	// The branch's own words (fix/pay-2433-retry-webhook → retry webhook) find
	// what was learned before on the same subject under other tickets.
	const about = branch.replace(/^[^/]*\//, '').replace(/\b[a-z]{2,10}-\d{1,6}\b/i, '').replace(/[-_/]+/g, ' ').trim()
	const learnedBefore = about.length > 2 && searchBrain(all.filter((e) => ['learning', 'mistake', 'debug', 'decision'].includes(e.kind)), about).length > 0
	// A count alone is one line, not a brief: no header in a repository with nothing to say.
	if (!known.length && !pending(cfg).length && !learnedBefore) return queueCountLine(savedCount(cfg))
	const names = [key, project].filter(Boolean).join(' / ')
	const header = `WorkPulse Brain, recorded before${names ? ` for ${names}` : ''} (read before planning):`
	return capBrief(briefSections(cfg, all, key, project, about), { key, project, header, full })
}

/** The hook's stdin (or `given`, for a caller with no stdin), and the git facts of the folder it ran in. */
function sessionContext(given) {
	let input = given ?? {}
	try {
		if (!given) input = JSON.parse(readFileSync(0, 'utf8') || '{}')
	} catch {
		/* no stdin */
	}
	const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd()
	const here = (...a) => {
		try {
			return execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
		} catch {
			return ''
		}
	}
	const branch = here('branch', '--show-current')
	const key = ticketOf(branch)
	const remote = here('remote', 'get-url', 'origin').match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/)?.[1]
	const session = typeof input.session_id === 'string' && /^[\w-]+$/.test(input.session_id) ? input.session_id : null
	return { input, cwd, branch, key, remote, head: here('rev-parse', 'HEAD'), session }
}

/**
 * The brief as sections, in the order they matter (the cap drops from the end): the inbox, the ticket's own entries,
 * open follow-ups, mistakes that keep coming back, what was learned before, the project's last entries.
 * Each section is an array of units: a heading with its first item, then one unit per entry (with its detail lines).
 */
function briefSections(cfg, all, key, project, about = '') {
	const out = []
	// Saved pages are only counted, in one line: nothing is fetched or listed until the person says "process my queue".
	// The line sits with the inbox, the part the cap never drops, so a busy brief cannot push the count out.
	const saved = queueCountLine(savedCount(cfg))
	const asks = section('## Inbox from the extension', pending(cfg).map(inboxItem))
	out.push(saved ? [...asks, saved] : asks)
	if (key) {
		const mine = all.filter((e) => e.ticket === key || e.links?.related?.includes(key))
		const related = new Set(mine.flatMap((e) => e.links?.related ?? []))
		const items = mine.slice(0, 12).map((e) => [`- ${short(e)}`, e.rootCause && `    root cause: ${e.rootCause}`, e.next?.length && `    next: ${e.next.join(' · ')}`].filter(Boolean).join('\n'))
		if (related.size) items.push(`Related: ${[...related].join(', ')}`)
		out.push(section(`## ${key}: ${mine.length ? mine.length + ' earlier entries' : 'nothing recorded yet'}`, items.length ? items : ['(none)']))
	}
	const open = all.filter((e) => e.next?.length && e.status !== 'done' && e.at > Date.now() - 14 * DAY).slice(0, 6)
	out.push(section('## Open follow-ups (14 days)', open.map((e) => `- ${e.ticket ?? e.project ?? ''} ${e.next.join(' · ')}`)))
	const recent = all.filter((e) => e.at > Date.now() - 30 * DAY)
	const { repeats } = summarise(recent)
	out.push(
		section(
			'## Mistakes that keep coming back (30 days)',
			repeats.slice(0, 6).map((r) => {
				const last = recent.find((e) => e.kind === 'mistake' && e.tags?.includes(r.tag))
				return `- #${r.tag} ×${r.count}${last ? ` — last: ${last.title}${last.rootCause ? ' (' + last.rootCause + ')' : ''}` : ''}`
			}),
		),
	)
	// Learned before on the same subject, from other tickets and projects.
	const shown = new Set(all.filter((e) => (key && (e.ticket === key || e.links?.related?.includes(key))) || (project && e.project === project)).map((e) => e.id))
	const learned = about.split(/\s+/).filter((w) => w.length > 2).length
		? searchBrain(all.filter((e) => ['learning', 'mistake', 'debug', 'decision'].includes(e.kind) && !shown.has(e.id)), about).slice(0, 5)
		: []
	out.push(section(`## Learned before about "${about}"`, learned.map(({ e }) => `- ${short(e)}${e.rootCause ? ` (root cause: ${e.rootCause})` : ''}`)))
	const p = project ? all.filter((e) => e.project === project).slice(0, 10) : []
	out.push(section(`## ${project}: last ${p.length}`, p.map((e) => `- ${short(e)}`)))
	const kept = out.filter((s) => s.length)
	kept.inbox = asks.length > 0 || !!saved // the first section is the inbox and the count, and capBrief never drops it
	return kept
}

/** What the database is compared with: this clone, at its current commit. */
function dbPlace(cfg) {
	let head = ''
	try {
		head = git(cfg, 'rev-parse', 'HEAD')
	} catch {
		/* no commit yet: never fresh */
	}
	return { head, clone: cfg.clone }
}

function buildDb(cfg, all) {
	return brainDb.rebuildFile(brainDb.dbPath(), all, join(cfg.clone, ROOT, 'library'), dbPlace(cfg))
}

function dbLine({ state, why, path, entries, files, builtAt }) {
	const built = builtAt ? `${entries} entries, ${files} library files, built ${new Date(builtAt).toISOString().slice(0, 16).replace('T', ' ')}` : ''
	if (state === 'fresh') return `up to date — ${path}: ${built}`
	if (state === 'stale') return `behind the clone, and rebuilds itself on the next search — ${path}: ${built}`
	if (state === 'missing') return `not built yet, and builds itself on the next search — ${path}`
	if (state === 'corrupt') return `the file is unreadable (${why}), so search and recall use the plain word search; fix it with: wp-brain db rebuild — ${path}`
	return `not available (${why}), so search and recall use the plain word search`
}

/**
 * A rebuild no one waits for, at most one at a time: the lock is taken here, before the process starts, so a burst of
 * prompts can't each start one in the time it takes the first to come up. It can't fail here: the next prompt asks again.
 */
function refreshLater() {
	try {
		const path = brainDb.dbPath()
		if (brainDb.unavailable() || !brainDb.lockRebuild(path)) return
		const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'db', 'rebuild', '--background'], { detached: true, stdio: 'ignore' })
		child.on('error', () => brainDb.unlockRebuild(path))
		child.unref()
	} catch {
		/* the next prompt asks again */
	}
}

/**
 * The lessons for a prompt, from the database when it is up to date. This runs on every prompt, so it never waits for
 * a rebuild: when the database is behind, this one prompt is answered from the lessons as the clone has them now, in
 * a throwaway index in memory (same ranking; no notes or transcripts), and the file is rebuilt in the background.
 * If the database can't be used at all, recallFor answers.
 */
function recallLessons(cfg, prompt, limit) {
	const plain = () => recallFor(readAll(cfg), prompt, limit).map(({ e }) => e)
	if (brainDb.unavailable()) return plain()
	const ask = (db) => {
		try {
			return brainDb.entriesFor(db, brainDb.recall(db, prompt, limit).map((x) => x.id))
		} finally {
			db.close()
		}
	}
	try {
		if (brainDb.dbState(brainDb.dbPath(), dbPlace(cfg)).state === 'fresh') return ask(brainDb.openDb(brainDb.dbPath(), { readOnly: true }))
		refreshLater()
		const memory = brainDb.openDb(':memory:')
		brainDb.rebuild(memory, readAll(cfg).filter((e) => LESSON_KINDS.includes(e.kind)), null)
		return ask(memory)
	} catch {
		refreshLater() // an unreadable page only shows when it is read: a rebuild replaces the file
		return plain()
	}
}

/**
 * `search`: the words go to the database, rebuilt first when it is behind the clone (search can wait; a prompt can't),
 * and the filters then apply to the entries. Filters alone list what passes, as they always did. A hit on a library
 * folder has `folder` instead of `e`. If the database can't be used, searchBrain answers.
 */
function searchEntries(cfg, query) {
	const all = readAll(cfg)
	const { text, filters, filtered } = parseBrainQuery(query)
	if (!text.trim() || brainDb.unavailable()) return searchBrain(all, query)
	try {
		const path = brainDb.dbPath()
		if (brainDb.dbState(path, dbPlace(cfg)).state !== 'fresh') buildDb(cfg, all)
		const db = brainDb.openDb(path, { readOnly: true })
		let hits
		try {
			hits = brainDb.query(db, text)
		} finally {
			db.close()
		}
		const byId = new Map(all.map((e) => [e.id, e]))
		return hits.flatMap(({ id, score, matched }) => {
			if (id.startsWith('library:')) return filtered ? [] : [{ folder: id.slice('library:'.length), score, matched }]
			const e = byId.get(id)
			return e && (!filtered || matchBrain(e, filters)) ? [{ e, score, matched }] : []
		})
	} catch {
		refreshLater()
		return searchBrain(all, query)
	}
}

/** Every message in bridge/inbox/to-cli, oldest first. */
function inboxMessages(cfg) {
	const dir = join(cfg.clone, ROOT, 'inbox', 'to-cli')
	if (!existsSync(dir)) return []
	return readdirSync(dir)
		.filter((f) => f.endsWith('.json'))
		.map((f) => {
			try {
				return JSON.parse(readFileSync(join(dir, f), 'utf8'))
			} catch {
				return null
			}
		})
		.filter((m) => m && typeof m.id === 'string')
		.sort((a, b) => a.at - b.at)
}

/** Asks (not saved pages) nobody on this machine has acknowledged. */
function pending(cfg) {
	const ackDir = join(cfg.clone, ROOT, 'inbox', 'acks', cfg.device)
	const acked = new Set(existsSync(ackDir) ? readdirSync(ackDir).map((f) => f.replace(/\.json$/, '')) : [])
	return inboxMessages(cfg).filter((m) => !isSavedUrl(m) && !acked.has(m.id) && !secretsIn(JSON.stringify(m)).length)
}

/** The saved pages with their state across every device. */
function queueState(cfg) {
	const clone = resolve(cfg.clone)
	const msgs = inboxMessages(cfg).filter((m) => isSavedUrl(m) && /^[\w-]+$/.test(m.id))
	return queueRows(msgs, Object.fromEntries(msgs.map((m) => [m.id, ackOf(clone, m.id)])), cfg.device)
}

const savedCount = (cfg) => countable(queueState(cfg), cfg.device).length

/** Why, cut short, and never a secret. */
const safeWhy = (t) => (secretsIn(String(t)).length ? 'could not read this page' : String(t).replace(/\s+/g, ' ').trim().slice(0, 200))

/** Writes this device's ack for `id` with the given state, keeping the first `at`; commits and pushes it. */
function writeAck(cfg, id, patch) {
	const rel = `${ROOT}/inbox/acks/${cfg.device}/${id}.json`
	const file = join(cfg.clone, rel)
	let at = Date.now()
	try {
		at = JSON.parse(readFileSync(file, 'utf8')).at || at
	} catch {
		/* the first ack */
	}
	mkdirSync(dirname(file), { recursive: true })
	writeFileSync(file, JSON.stringify({ id, at, by: cfg.device, ...patch }) + '\n')
	commitAndPush(cfg, [rel], `bridge: ${patch.state} ${id}`)
}

/** Pushes whatever this clone has committed and the remote lacks; dies when it can't, so nothing is fetched on an unpushed claim. */
function pushHead(cfg) {
	for (let i = 0; i < 3; i++) {
		try {
			git(cfg, 'push', '--quiet', 'origin', 'HEAD')
			return
		} catch {
			try {
				pullRebase(cfg)
			} catch {
				/* no upstream yet: the next push says what is wrong */
			}
		}
	}
	die('Your claim is committed here but could not be pushed. Run: wp-brain sync')
}

function queueList(cfg) {
	pull(cfg, { reading: true })
	const rows = queueState(cfg).filter((r) => r.state !== 'done')
	for (const r of rows) {
		if (r.state === 'refused') console.log(`[${r.id}] refused (it looks like it holds a secret; never read)`)
		else {
			const who = r.owner ? (r.owner === cfg.device ? ' by this device' : ` by ${r.owner}`) : ''
			const what = r.state === 'claimed' && r.owner !== cfg.device ? `claimed${who}` : r.state === 'failed' ? `failed${who}${r.why ? `: ${r.why}` : ''}` : r.state
			console.log(`[${r.id}] ${day(r.at)} ${what}${r.route === 'video' ? ' (video)' : ''} ${r.url}${r.title ? ` — ${r.title}` : ''}`)
		}
	}
	if (!rows.length) console.log('Queue empty.')
}

/** Claims, then reads, one saved page. The claim is pushed before the page is fetched; the earliest ack owns it. */
async function queueNext(cfg, opt) {
	const root = typeof opt.root === 'string' ? opt.root : process.env.YT_LEARN_ROOT || join(homedir(), 'Documents', 'youtube-learning')
	let row
	for (;;) {
		pull(cfg)
		const rows = queueState(cfg)
		// A claim another device beat is given back, whatever happened to its row since.
		const lost = rows.filter((r) => r.state !== 'refused' && r.owner && r.owner !== cfg.device && existsSync(join(cfg.clone, ROOT, 'inbox', 'acks', cfg.device, `${r.id}.json`)))
		const lostPaths = lost.map((r) => `${ROOT}/inbox/acks/${cfg.device}/${r.id}.json`).filter((rel) => {
			try {
				return JSON.parse(readFileSync(join(cfg.clone, rel), 'utf8')).state === 'claimed'
			} catch {
				return false
			}
		})
		if (lostPaths.length) {
			for (const rel of lostPaths) rmSync(join(cfg.clone, rel), { force: true })
			commitAndPush(cfg, lostPaths, `bridge: give back ${lostPaths.length} claim${lostPaths.length === 1 ? '' : 's'} another device made first`)
		}
		row = rows.find((r) => r.state === 'claimed' && r.owner === cfg.device)
		if (row) {
			// A resumed claim may have been committed here but never pushed: it must be on the remote before anything is fetched.
			pushHead(cfg)
			break
		}
		row = rows.find((r) => r.state === 'waiting')
		if (!row) {
			console.log(JSON.stringify({ empty: true }))
			return
		}
		writeAck(cfg, row.id, { state: 'claimed' })
		pull(cfg)
		if (ownerOf(ackOf(resolve(cfg.clone), row.id)) === cfg.device) break
	}
	if (row.route === 'video') {
		console.log(JSON.stringify({ id: row.id, url: row.url, title: row.title, route: 'video' }))
		return
	}
	try {
		const got = await learn(row.url, root)
		console.log(JSON.stringify({ id: row.id, url: row.url, ...got, route: 'site' }))
	} catch (e) {
		const why = safeWhy(e.message)
		writeAck(cfg, row.id, { state: 'failed', why })
		console.error(`Could not read [${row.id}] ${row.url}: ${why}`)
		console.log(JSON.stringify({ id: row.id, url: row.url, route: 'site', failed: true, why }))
	}
}

const [cmd = 'help', ...rest] = process.argv.slice(2)
const run = commands[cmd]
if (!run) die(`Unknown command "${cmd}". Try: wp-brain help`)
try {
	await run(parseArgs(rest))
} catch (e) {
	die(e.message)
}

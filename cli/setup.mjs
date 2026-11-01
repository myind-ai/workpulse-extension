// wp-brain setup and wp-brain doctor: link this machine's Claude Code to the
// Brain, asking rather than assuming, and check that every part of the link
// works.
//
// setup installs, each only if you say yes:
//   - the clone of your Brain repository and branch (wp-brain init)
//   - a SessionStart hook: the brief for the branch's ticket, as context
//   - a Stop hook: once per session, after a commit, ask to record the work
//   - the "WorkPulse Brain" rule in ~/.claude/CLAUDE.md (between markers, so a
//     re-run replaces it instead of adding a second copy)
//   - the workpulse-brain skill, linked into ~/.claude/skills
//   - the text backup of lessons, skills and rules ("library": true in brain.json; off unless you say yes)
//   - the guard (cli/guard.mjs as a PreToolUse hook, ask rules for deploys and destructive git, no Claude attribution
//     in commits and PRs). Off unless you say yes with --guard yes; a re-run without --guard keeps what is there.
//   - session memory (cli/memory-hook.mjs on SessionStart, Stop and SessionEnd, the full text of your sessions in a local
//     database). Off unless you say yes with --memory yes; a re-run without --memory keeps what is there.
// Settings files are backed up before they are written, and every step can be
// re-run safely. Answers can be given as flags for a non-interactive run:
//   --repo owner/repo --create yes --branch brain --device cli-mac --brief yes --record yes --rule yes --skill yes --library no --guard no --memory no
// A repository that doesn't exist yet is created private with gh (after asking).
//
// CLAUDE_HOME (or Claude Code's own CLAUDE_CONFIG_DIR) overrides ~/.claude.

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { claudeDir, memoryDbPath, placeHook, removeHook, settingsHasHook, settingsRunHook } from './claude-files.mjs'
import { checkHookShape, makeMemoryDb, memoryOff, memoryOn, memoryPlace, memoryRow, placeMemoryHooks, readMemory, writeMemoryFlag, brainConfig } from './memory-setup.mjs'
import { listLibrary, repoVisibility, validDevice } from './library.mjs'
import { ruleMapState } from './rules.mjs'

/** These live in claude-files.mjs, which hooks can load cheaply, and memory-setup.mjs; re-exported for the callers here. */
export { claudeDir, memoryOff, memoryOn, placeHook, placeMemoryHooks, removeHook, settingsHasHook, settingsRunHook }
const START = '<!-- workpulse-brain:start -->'
const END = '<!-- workpulse-brain:end -->'
const STARTER = '# Global Claude Code Rules\n' // what setup starts a missing CLAUDE.md with

const yes = (v) => /^(y|yes|true|1|on)$/i.test(String(v ?? '').trim())

/** Asks on the terminal, or takes the flag; with neither (no terminal), the default. */
async function ask(rl, flag, question, fallback) {
	if (flag !== undefined && flag !== true) return String(flag)
	if (!rl) return fallback
	const got = (await rl.question(`${question}${fallback ? ` [${fallback}]` : ''}: `)).trim()
	return got || fallback
}

/** Runs a command and returns its output, or null when it fails or is missing. */
const run = (cmd, args) => {
	try {
		return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim()
	} catch {
		return null
	}
}

/**
 * Makes sure the Brain repository exists, creating it private when asked to.
 * Returns 'exists', 'created', or throws with what to do instead. `sh` is
 * injectable for tests.
 */
export function ensureRepo({ repo, create, sh = run }) {
	if (sh('gh', ['repo', 'view', repo, '--json', 'name']) != null) return 'exists'
	if (sh('gh', ['--version']) == null) throw new Error(`Can't check ${repo}: the GitHub CLI is missing. Install https://cli.github.com, run gh auth login, then run setup again.`)
	if (!create) throw new Error(`${repo} doesn't exist (or this gh login can't see it). Create it private on GitHub, or run setup again with --create yes.`)
	const made = sh('gh', ['repo', 'create', repo, '--private', '--description', 'My WorkPulse backup and Brain — learnings, tickets and time logs.'])
	if (made == null) throw new Error(`Couldn't create ${repo}. Check gh auth status, or create it on GitHub and run setup again.`)
	return 'created'
}

/** Doctor's rows on where the learning lives: private, not sharing a repository with code, and nothing still pointing at a repository it left. */
export function repoRows({ cfg, heads, visibility, claude }) {
	const rows = [{ ok: visibility !== 'public', what: 'Private', detail: visibility === 'public' ? `${cfg.repo} is public: anyone can read your learning. wp-brain move owner/private-repo` : visibility === 'private' ? `${cfg.repo} is private` : `could not tell whether ${cfg.repo} is private (is gh signed in?)` }]
	const others = (heads ?? '').split('\n').map((l) => l.split('refs/heads/')[1]).filter((b) => b && b !== cfg.branch)
	if (cfg.branch && others.length) rows.push({ ok: false, what: 'Own repository', detail: `${cfg.repo} also has ${others.slice(0, 3).join(', ')}. If that is code, give your learning its own repository: wp-brain move ${cfg.repo.split('/')[0]}/workpulse-notes` })
	if (cfg.movedFrom?.repo) {
		const old = cfg.movedFrom.repo
		const names = new RegExp(`(?<![\\w.-])${old.replace(/[.\\/]/g, '\\$&')}(?![\\w.-])`, 'i') // me/code, not me/code-notes
		const stale = ['CLAUDE.md', join('rule-files', 'workpulse-brain.md')].filter((f) => existsSync(join(claude, f)) && names.test(readFileSync(join(claude, f), 'utf8')))
		rows.push({ ok: !stale.length, what: 'Moved', detail: `from ${old} on ${String(cfg.movedFrom.at).slice(0, 10)}. wp-brain move --catch-up brings across anything written there since${stale.length ? `. ${stale.join(' and ')} still name${stale.length === 1 ? 's' : ''} ${old}` : ''}` })
	}
	return rows
}

/** What is left to do in the browser, with the token page pre-filled. */
export function extensionSteps({ repo, branch, tokenUrl }) {
	return [
		'Now the extension (Chrome → WorkPulse → Settings → Backup):',
		`  1. Branch: ${branch || '(leave empty — the default branch)'}${branch === 'brain' ? ' (already the default from WorkPulse 1.6.0)' : ''}`,
		`  2. Make a token — this page is pre-filled; pick only ${repo} under Repository access:`,
		`     ${tokenUrl(repo.split('/')[0])}`,
		`  3. Paste the token, pick ${repo}, press Back up now.`,
	].join('\n')
}

function report(rows) {
	for (const r of rows) console.log(`${r.ok ? '✓' : r.critical ? '✗' : '!'} ${r.what.padEnd(18)} ${r.detail}`)
	const bad = rows.filter((r) => !r.ok && r.critical)
	console.log(bad.length ? `\n${bad.length} problem(s) to fix.` : '\nLinked.')
	if (bad.length) process.exitCode = 1
}

/** "workpulse-brain@<marketplace>" when the plugin is installed and not switched off, else null. */
export function viaPlugin(claude, settings) {
	try {
		const p = join(claude, 'plugins', 'installed_plugins.json')
		const id = Object.keys(JSON.parse(readFileSync(p, 'utf8')).plugins ?? {}).find((k) => k.startsWith('workpulse-brain@'))
		return id && settings.enabledPlugins?.[id] !== false ? id : null
	} catch {
		return null
	}
}

/** What the plugin's SessionStart hook tells Claude while the Brain is not linked yet. */
export function nudgeText(cli = 'wp-brain.mjs') {
	return [
		'The WorkPulse Brain plugin is installed but not linked to a repository yet.',
		'In your first reply, before the task, follow the "Setup" section of the workpulse-brain skill: ask with',
		`AskUserQuestion how the user wants to use it and which private repository holds it, then run node "${cli}" connect.`,
		'If they choose Not now, carry on with the task and do not ask again in this session; /workpulse-brain:connect asks later.',
	].join(' ')
}

/** The global rule, filled in for this machine. */
export function ruleText({ repo, branch, cli }) {
	const where = branch ? `branch **\`${branch}\`** of the private repo **\`${repo}\`**` : `the private repo **\`${repo}\`**`
	return `${START}
## WorkPulse Brain — Record Every Ticket, Mistake and Learning (MANDATORY — All Repos)

One private place for what was asked, what was done, what went wrong and what was learned, for work tickets and
side projects: the \`bridge/\` folder on ${where}. The WorkPulse extension (Brain page, Learnings, each ticket's
page) and Claude Code (skill \`workpulse-brain\`, CLI \`wp-brain\`) both read and write it.

\`\`\`bash
WP=${cli}     # Node ≥ 22.18
\`\`\`

**When to record (without asking; pushing Brain entries to this branch is pre-authorised):**

| Moment | Command |
|---|---|
| Start of a ticket or side-project task (or read the SessionStart brief if it ran) | \`node $WP brief KEY --project owner/repo\` |
| A mistake, wrong assumption or failed fix, **as it happens** | \`node $WP add mistake "… #tag" --ticket KEY --root-cause "…"\` |
| A bug diagnosed | \`node $WP add debug "symptom" --ticket KEY --root-cause "…" --body "fix + proof"\` |
| Something reusable learned / a tool set up | \`node $WP add learning "… #tag"\` / \`node $WP add skill "…"\` |
| Work committed, PR opened, or the session ends on a ticket (the Stop hook asks once) | one \`ticket\` entry + its mistakes/learnings: \`node $WP add --json -\` |
| Side project instead of a work ticket | the same, with \`--scope personal --project <name>\` |

**What to record:** one-line titles; asked / done / root cause / honest status (\`done\` only when verified) / next;
PR and commit links; related keys; \`#tags\`.
**Never record:** secrets, tokens, keys, passwords, customer or personal data, logs, source code, \`.env\` contents.

**Setup and linking:** \`node $WP setup\` asks (repository, branch, device, hooks, this rule, the skill) and installs;
\`node $WP doctor\` checks every part. In the extension: Settings → Backup (repository, **Branch first**, token) and
Settings → Claude Code & the Brain (state of the link, copyable commands). The GitHub token is a **fine-grained**
token for that one repository, **Contents: Read and write**, with an expiry, and lives only in the extension;
the CLI uses the user's own git login. Never put a token in a repo, \`.env\`, chat or a Brain entry.

**Rules:** read the brief before planning and say in one line what you take from it; record mistakes when they
happen; write only under \`bridge/\` (never the extension's backup folder); if \`wp-brain\` fails, keep working and say
what was not recorded; answer and acknowledge inbox requests (\`node $WP inbox --ack ID\`). Check the link: \`node $WP doctor\`.
${END}`
}

/** Puts the rule in CLAUDE.md: replaces the marked block, or an unmarked section of the same name, or appends. */
export function placeRule(markdown, rule) {
	if (markdown.includes(START) && markdown.includes(END)) {
		return markdown.slice(0, markdown.indexOf(START)) + rule + markdown.slice(markdown.indexOf(END) + END.length)
	}
	const head = markdown.indexOf('\n## WorkPulse Brain')
	if (head >= 0) {
		const next = markdown.indexOf('\n## ', head + 4)
		return markdown.slice(0, head + 1) + rule + '\n' + (next >= 0 ? markdown.slice(next) : '')
	}
	return `${markdown.replace(/\s*$/, '')}\n\n${rule}\n`
}

/**
 * Puts the rule where it lives: in `rule-files/workpulse-brain.md` when that file holds the marked block (a split moved it there,
 * so the core gets nothing), else in CLAUDE.md as `placeRule` does. Returns { path, changed }.
 */
export function placeRuleIn(claude, rule) {
	const moved = join(claude, 'rule-files', 'workpulse-brain.md')
	const target = hasBlock(moved) ? moved : join(claude, 'CLAUDE.md')
	const before = existsSync(target) ? readFileSync(target, 'utf8') : STARTER
	const next = placeRule(before, rule)
	if (next === before) return { path: target, changed: false }
	if (target !== moved && existsSync(target)) copyFileSync(target, `${target}.wp-brain.bak`)
	writeFileSync(target, next)
	return { path: target, changed: true }
}

const hasBlock = (file) => existsSync(file) && readFileSync(file, 'utf8').includes(START) && readFileSync(file, 'utf8').includes(END)

/** Where the rule is installed, for `doctor`. */
export function ruleState(claude) {
	if (hasBlock(join(claude, 'rule-files', 'workpulse-brain.md'))) return { ok: true, detail: 'installed (rule-files/workpulse-brain.md)' }
	const md = existsSync(join(claude, 'CLAUDE.md')) ? readFileSync(join(claude, 'CLAUDE.md'), 'utf8') : ''
	if (md.includes(START)) return { ok: true, detail: 'installed' }
	if (md.includes('## WorkPulse Brain')) return { ok: true, detail: 'present (hand-written; setup will replace it with the managed copy)' }
	return { ok: false, detail: 'not in CLAUDE.md (setup → question 6)' }
}


/** The marked rule in a CLAUDE.md, or null. */
export function markedRule(markdown) {
	const from = markdown.indexOf(START)
	const to = markdown.indexOf(END)
	return from >= 0 && to > from ? markdown.slice(from, to + END.length) : null
}

/** Whether a CLAUDE.md is only what setup wrote, nothing of the owner's: the marked rule, with or without the starter heading. */
export function onlyRule(markdown) {
	const rule = markedRule(markdown)
	if (!rule) return false
	const rest = markdown.replace(rule, '').trim()
	return rest === '' || rest === STARTER.trim()
}

/** Whether a CLAUDE.md has the rule, marked or as a hand-written section (the same test as doctor's). */
export const holdsRule = (markdown) => markdown.includes(START) || markdown.includes('## WorkPulse Brain')

// ---- the guard -------------------------------------------------------------------------------------

const GUARD_MARK = 'guard.mjs'
const both = (c) => [`Bash(${c} *)`, `Bash(${c})`]
/** Ask rules for the hook's gates, so they hold even where the hook cannot run. `vercel env ls` and `supabase db diff` stay free. */
export const GUARD_ASK_RULES = [
	...both('git push'),
	...both('gh pr create'),
	...both('gh pr merge'),
	'Bash(vercel)',
	...both('vercel deploy'),
	...both('vercel --prod'),
	...both('supabase functions deploy'),
	...both('supabase db push'),
	...both('asc builds upload'),
	...both('asc publish'),
	...both('npm publish'),
	...both('firebase deploy'),
	...both('git reset --hard'),
	...both('git checkout -f'),
	...both('git checkout --force'),
	'Bash(git clean -f*)',
	...both('git branch -f'),
]
// The files recall and the guard point at, so reading them never prompts: the moved rules, the rules that load on demand, RTK.md.
export const GUARD_ALLOW = ['Read(~/.claude/rule-files/**)', 'Read(~/.claude/rules/**)', 'Read(~/.claude/RTK.md)']
// The record keeps the allow rules guardSettings added; an older record held `true` for the first one only.
const recordedAllow = (rec) => (Array.isArray(rec?.allow) ? rec.allow : rec?.allow ? [GUARD_ALLOW[0]] : [])
const GUARD_ATTRIBUTION = { commit: '', pr: '', sessionUrl: false }

// What guardSettings added is written down under this key, so removeGuard takes off only that and the owner's own entries stay.
const GUARD_RECORD = 'workpulseGuard'
const isOurs = (a) => !!a && a.commit === '' && a.pr === '' && a.sessionUrl === false && Object.keys(a).length === 3

/**
 * Installs the guard in a settings object: PreToolUse hook on Bash|Artifact, ask rules, the rule-files read, and no attribution
 * when the owner has none. An `attribution` the owner already has is kept as it is (`doctor` warns when it still shows a trailer,
 * and the guard denies one). What was added is recorded in `workpulseGuard`. Idempotent; touches nothing else.
 */
export function guardSettings(settings, guardPath) {
	// No record but our hook is there: an install from before the record (or a lost key). What matches is ours, not the owner's.
	const legacy = settings[GUARD_RECORD] === undefined && !!guardHook(settings)
	const rec = settings[GUARD_RECORD] ?? (legacy ? { ask: GUARD_ASK_RULES.filter((r) => (settings.permissions?.ask ?? []).includes(r)), allow: GUARD_ALLOW.filter((r) => (settings.permissions?.allow ?? []).includes(r)), attribution: isOurs(settings.attribution) ? 'ours' : 'owner' } : {})
	removeHook(settings, 'PreToolUse', GUARD_MARK)
	;(settings.hooks ??= {}).PreToolUse ??= []
	settings.hooks.PreToolUse.push({ matcher: 'Bash|Artifact', hooks: [{ type: 'command', command: `node "${guardPath}"`, timeout: 5 }] })
	const perms = (settings.permissions ??= {})
	const ask = perms.ask ?? []
	const addedAsk = GUARD_ASK_RULES.filter((r) => !ask.includes(r))
	perms.ask = [...ask, ...addedAsk]
	const allow = (perms.allow ??= [])
	const addedAllow = GUARD_ALLOW.filter((r) => !allow.includes(r))
	allow.push(...addedAllow)
	let attribution = 'owner'
	if (settings.attribution === undefined) {
		settings.attribution = { ...GUARD_ATTRIBUTION }
		attribution = 'ours'
	} else if (rec.attribution === 'ours' && isOurs(settings.attribution)) attribution = 'ours'
	settings[GUARD_RECORD] = {
		ask: [...new Set([...(rec.ask ?? []).filter((r) => perms.ask.includes(r)), ...addedAsk])],
		allow: [...new Set([...recordedAllow(rec).filter((r) => perms.allow.includes(r)), ...addedAllow])],
		attribution,
	}
	return settings
}

/** Takes off what guardSettings added (as it recorded), and any container it leaves empty. */
export function removeGuard(settings) {
	const rec = settings[GUARD_RECORD]
	delete settings[GUARD_RECORD]
	removeHook(settings, 'PreToolUse', GUARD_MARK)
	if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks
	const perms = settings.permissions
	if (perms) {
		// No record means an install from before it existed: take off every rule we would have added.
		const ours = rec ? rec.ask ?? [] : GUARD_ASK_RULES
		if (perms.ask) perms.ask = perms.ask.filter((r) => !ours.includes(r))
		const ourAllow = rec ? recordedAllow(rec) : GUARD_ALLOW
		if (perms.allow) perms.allow = perms.allow.filter((r) => !ourAllow.includes(r))
		for (const k of ['ask', 'allow']) if (perms[k] && !perms[k].length) delete perms[k]
		if (!Object.keys(perms).length) delete settings.permissions
	}
	if (isOurs(settings.attribution) && rec?.attribution !== 'owner') delete settings.attribution
	return settings
}

/** The script path in a guard hook command (`node "/path with space/guard.mjs"` or the older unquoted form). */
export const guardPathOf = (command) => String(command).replace(/^node\s+/, '').replace(/^"(.*)"$/, '$1')

/** The installed guard hook's command, or undefined. */
const guardHook = (settings) => (settings.hooks?.PreToolUse ?? []).flatMap((g) => g.hooks ?? []).find((h) => String(h.command ?? '').includes(GUARD_MARK))

export async function setup({ opt, config, cliPath, skillDir, init, repoName = 'workpulse-notes', tokenUrl = () => 'https://github.com/settings/personal-access-tokens/new' }) {
	const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null
	try {
		console.log('Link Claude Code on this machine to the WorkPulse Brain. Enter keeps the [default].\n')
		const login = opt.repo ? null : run('gh', ['api', 'user', '--jq', '.login'])
		// Eight questions whose defaults are what almost everyone wants: say them once and take one Enter.
		// `--yes` takes them without asking; "n" walks the eight as before. Flags given still win.
		const libraryNow = readLibrary(config)
		const guardNow = guardOn(claudeDir())
		const memoryNow = readMemory(config)
		const scheduleNow = (await import('./backup-schedule.mjs')).scheduleState().on
		const device0 = `cli-${hostname().split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '')}`
		const repo0 = opt.repo && opt.repo !== true ? String(opt.repo) : login ? `${login}/${repoName}` : ''
		// --repo and --branch (what the extension's copy line passes) fill the summary; any other flag means
		// the person is choosing for themselves, so they get the questions.
		const branch0 = opt.branch && opt.branch !== true ? String(opt.branch) : 'brain'
		const asked = ['device', 'brief', 'record', 'rule', 'skill', 'create', 'library'].some((k) => opt[k] !== undefined)
		if (repo0 && !asked) {
			console.log(`Recommended:\n  repository  ${repo0} (created private if it doesn't exist)\n  branch      ${branch0 === '-' ? 'the default branch' : branch0}\n  this machine ${device0}\n  hooks       brief at session start, ask once to record after a commit\n  also        the Brain rule in ~/.claude/CLAUDE.md and the workpulse-brain skill\n  text backup  ${libraryNow ? 'on' : 'off'} (notes, transcripts, skills and rules in your private repo; ask again with --library yes)\n  session memory ${(opt.memory !== undefined && opt.memory !== true ? yes(opt.memory) : memoryNow) ? 'on' : 'off'} (the full text of your sessions in a local database; choose with --memory yes or no)\n  daily backup ${(opt.schedule !== undefined && opt.schedule !== true ? yes(opt.schedule) : scheduleNow) ? 'on' : 'off'} (everything once a day with a LaunchAgent; choose with --schedule yes or no)\n`)
			const take = opt.yes || opt.defaults || !rl || yes(await ask(rl, undefined, 'Use the recommended setup? (n = answer each question) Y/n', 'y'))
			if (take) opt = { create: 'y', device: device0, brief: 'y', record: 'y', rule: 'y', skill: 'y', library: libraryNow ? 'y' : 'n', guard: guardNow ? 'y' : 'n', memory: memoryNow ? 'y' : 'n', schedule: scheduleNow ? 'y' : 'n', ...opt, repo: repo0, branch: branch0 }
			console.log('')
		}
		const repo = await ask(rl, opt.repo, '1. Brain repository (owner/repo — the one set in the extension’s Settings → Backup; a new one is created private)', login ? `${login}/${repoName}` : '')
		if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('A repository is needed, as owner/repo.')
		const branch = await ask(rl, opt.branch, '2. Branch (the same as the extension’s Backup → Branch; "-" for the default branch)', 'brain')
		const device = await ask(rl, opt.device, '3. This machine’s name in the Brain', `cli-${hostname().split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '')}`)
		const brief = yes(await ask(rl, opt.brief, '4. Brief Claude at the start of every session on a ticket branch, and put relevant past lessons in front of each prompt? (SessionStart + UserPromptSubmit hooks) y/n', 'y'))
		const record = yes(await ask(rl, opt.record, '5. Ask Claude once to record the session after a commit? (Stop hook) y/n', 'y'))
		const rule = yes(await ask(rl, opt.rule, '6. Add the WorkPulse Brain rule to ~/.claude/CLAUDE.md? y/n', 'y'))
		const skill = yes(await ask(rl, opt.skill, '7. Link the workpulse-brain skill into ~/.claude/skills? y/n', 'y'))
		const library = yes(await ask(rl, opt.library, '8. Back up your learning notes and transcripts, and your ~/.claude skills and rules, as text in this private repository, so a new machine can restore them? (secrets are refused; media is never uploaded) y/n', libraryNow ? 'y' : 'n'))
		const guard = yes(await ask(rl, opt.guard, '9. Install the guard? Claude asks before git push, deploys, publishing and commands that discard work, and commit and PR text carries no Claude attribution (PreToolUse hook + ask rules in settings.json) y/n', guardNow ? 'y' : 'n'))
		const memory = yes(await ask(rl, opt.memory, '10. Keep the full text of your prompts and answers in a local database, secrets masked, so past sessions can be searched? It stays on this machine, and if you use the vault it also goes into its encrypted backups. (SessionStart, Stop and SessionEnd hooks; turn off any time with wp-brain memory off) y/n', memoryNow ? 'y' : 'n'))
		const schedule = yes(await ask(rl, opt.schedule, '11. Back up everything once a day on this Mac? (a LaunchAgent runs wp-brain backup-all at low priority, at the next wake if asleep; plain session text only ever leaves encrypted; turn off any time with wp-brain backup schedule off) y/n', scheduleNow ? 'y' : 'n'))
		if (!validDevice(device)) throw new Error(`The machine name must be letters, digits, dots, dashes or underscores (not "." or ".."), got "${device}".`)
		if (!opt['no-push']) {
			let made = 'exists'
			if (run('gh', ['repo', 'view', repo, '--json', 'name']) == null) {
				const create = yes(await ask(rl, opt.create, `   ${repo} doesn't exist yet. Create it as a private repository? y/n`, 'y'))
				made = ensureRepo({ repo, create })
			}
			console.log(`   ✓ ${repo} ${made === 'created' ? 'created (private)' : 'found'}`)
		}
		const br = branch === '-' ? '' : branch
		console.log('')

		// 1–3: the clone and the config.
		init({ pos: [repo], opt: { ...(br ? { branch: br } : {}), device, ...(opt.clone ? { clone: opt.clone } : {}), ...(opt['no-push'] ? { 'no-push': true } : {}) } })

		writeLibrary(config, library)
		console.log(`${library ? '✓' : '–'} Text backup of lessons, skills and rules: ${library ? 'on' : 'off'}`)

		// 4–5: hooks, merged into settings.json, with a backup first.
		const claude = claudeDir()
		mkdirSync(claude, { recursive: true })
		const settingsPath = join(claude, 'settings.json')
		const before = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : '{}'
		const settings = JSON.parse(before || '{}')
		const node = `node ${cliPath}`
		if (brief) placeHook(settings, 'SessionStart', `${node} hook 2>/dev/null || true`, 'wp-brain.mjs hook', { statusMessage: 'WorkPulse Brain brief…' })
		else removeHook(settings, 'SessionStart', 'wp-brain.mjs hook')
		// Recall goes with the brief: one is the start of a session, the other each prompt in it.
		if (brief) placeHook(settings, 'UserPromptSubmit', `${node} recall 2>/dev/null || true`, 'wp-brain.mjs recall')
		else removeHook(settings, 'UserPromptSubmit', 'wp-brain.mjs recall')
		if (record) placeHook(settings, 'Stop', `${node} stop-check 2>/dev/null || true`, 'wp-brain.mjs stop-check')
		else removeHook(settings, 'Stop', 'wp-brain.mjs stop-check')
		if (guard) guardSettings(settings, join(dirname(cliPath), 'guard.mjs'))
		else if (guardNow) removeGuard(settings)
		// The database first and the flag after the settings, so a failure on the way changes nothing. One settings write, so the
		// backup is of what was there. A database or hooks that can't be used don't stop the rest of setup: say so and carry on.
		let memoryProblem = null
		if (memory) {
			try {
				checkHookShape(settings, settingsPath)
				await makeMemoryDb()
				placeMemoryHooks(settings, join(dirname(cliPath), 'memory-hook.mjs'))
			} catch (e) {
				memoryProblem = e.message
			}
		}
		const after = JSON.stringify(settings, null, 2) + '\n'
		if (after !== before) {
			if (existsSync(settingsPath)) copyFileSync(settingsPath, `${settingsPath}.wp-brain.bak`)
			writeFileSync(settingsPath, after)
		}
		console.log(`${brief ? '✓' : '–'} SessionStart brief + prompt recall   ${record ? '✓' : '–'} Stop record   ${guard ? '✓' : '–'} Guard   → ${settingsPath}${after !== before ? ' (backup: settings.json.wp-brain.bak)' : ' (unchanged)'}`)
		if (memoryProblem) console.log(`! ${memoryProblem}`)
		else {
			if (memory || memoryNow) writeMemoryFlag(config, memory)
			console.log(memory ? `✓ Session memory on, in ${memoryDbPath()}. ${memoryPlace(brainConfig(config))}.` : '– Session memory: off')
		}

		// The schedule: only on a yes, and a launchctl that refuses doesn't stop the rest of setup.
		if (schedule || scheduleNow) {
			const { scheduleOff, scheduleOn } = await import('./backup-schedule.mjs')
			try {
				if (schedule) scheduleOn({ cliPath })
				else scheduleOff()
				console.log(`${schedule ? '✓' : '–'} Daily backup: ${schedule ? 'on' : 'off'}`)
			} catch (e) {
				console.log(`! ${e.message}`)
			}
		} else console.log('– Daily backup: off')

		// 6: the global rule.
		if (rule) {
			const placed = placeRuleIn(claude, ruleText({ repo, branch: br, cli: cliPath }))
			console.log(`✓ Rule in ${placed.path}${placed.changed ? (placed.path.endsWith('CLAUDE.md') ? ' (backup: CLAUDE.md.wp-brain.bak)' : '') : ' (unchanged)'}`)
		}

		// 7: the skill.
		if (skill) {
			const target = join(claude, 'skills', 'workpulse-brain')
			mkdirSync(dirname(target), { recursive: true })
			let state = 'linked'
			if (existsSync(target) || isLink(target)) {
				if (!isLink(target)) state = 'kept (a real folder is there; not replaced)'
				else if (resolve(dirname(target), readlinkSync(target)) === resolve(skillDir)) state = 'already linked'
				else rmSync(target)
			}
			if (state === 'linked') symlinkSync(skillDir, target)
			console.log(`✓ Skill ${state}: ${target}`)
		}

		console.log(`\nClaude Code is linked.\n\n${extensionSteps({ repo, branch: br, tokenUrl })}\n\nThen Settings → Claude Code & the Brain shows this machine. Check every part: node ${cliPath} doctor`)
	} finally {
		rl?.close()
	}
}

/** Whether settings.json in this Claude folder runs the guard hook. */
function guardOn(claude) {
	try {
		return !!guardHook(JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8')))
	} catch {
		return false
	}
}

/** Whether brain.json says "library": true; a missing or unreadable file means off. */
function readLibrary(path) {
	try {
		return JSON.parse(readFileSync(path, 'utf8')).library === true
	} catch {
		return false
	}
}

/** Sets or removes "library" in brain.json (init has written it by now); throws when it can't, so setup never says "on" falsely. */
function writeLibrary(path, on) {
	try {
		const cfg = JSON.parse(readFileSync(path, 'utf8'))
		if (on) cfg.library = true
		else delete cfg.library
		writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n')
	} catch (e) {
		throw new Error(`Could not ${on ? 'turn on' : 'turn off'} the text backup in ${path}: ${e.message}`)
	}
}

const isLink = (p) => {
	try {
		return lstatSync(p).isSymbolicLink()
	} catch {
		return false
	}
}

/**
 * What the extension's backup left on this branch. Its restorable half is `index.json` + `data/`, the only part the brief
 * reads. A folder holding other files is not "not on this branch": say what is there, here and on the remote.
 */
function backupState(git, cfg) {
	const dir = cfg.backupDir || 'workpulse'
	const inRef = (ref) => (git('ls-tree', '-r', '--name-only', ref, '--', `${dir}/`) ?? '').split('\n').filter(Boolean)
	const here = inRef('HEAD')
	const there = cfg.branch ? inRef(`origin/${cfg.branch}`) : git('rev-parse', '--abbrev-ref', '@{u}') ? inRef('@{u}') : []
	const manifest = `${dir}/index.json`
	const count = Math.max(here.length, there.length)
	if (existsSync(join(cfg.clone, manifest))) return { ok: true, detail: `${dir}/ present, ${count} files (its Learnings reach the brief)` }
	if (there.includes(manifest)) return { ok: true, detail: `${dir}/ is on the remote, ${there.length} files, not pulled here yet: wp-brain sync` }
	if (count) return { ok: false, detail: `${dir}/ holds ${count} files, but no backup data yet (no index.json), so Learnings written in the extension don't reach the brief — Settings → Backup → Back up now` }
	return { ok: false, detail: 'not on this branch yet — Settings → Backup → Back up now' }
}

/** The vault's rows. The vault's modules load only when it is on, and these rows never hold the key, only its fingerprint. */
async function vaultRows(cfg) {
	const row = (ok, what, detail, critical = false) => ({ ok, what, detail, critical })
	if (!cfg.vault) return [row(true, 'Vault', 'off — videos and databases have no backup (wp-brain vault init)')]
	const { parseVaultConfig } = await import('./vault-manifest.mjs')
	let v
	try {
		v = parseVaultConfig(cfg)
	} catch (e) {
		return [row(false, 'Vault', `the "vault" section of brain.json is wrong: ${e.message}`, true)]
	}
	const { ageAvailable, fingerprint, keystore } = await import('./vault-crypto.mjs')
	const { accountOf, copyRecorded, list, vaultClone } = await import('./vault.mjs')
	const rows = [row(true, 'Vault', `on — device ${v.device}`)]
	const age = ageAvailable()
	rows.push(row(age, 'Vault age', age ? 'present' : 'not installed: brew install age'))
	let key = null
	try {
		key = keystore.get(accountOf(v))
		rows.push(row(key !== null, 'Vault key', key !== null ? `present, fingerprint ${fingerprint(key)}` : 'not on this Mac: wp-brain vault key import'))
	} catch (e) {
		rows.push(row(false, 'Vault key', e.message))
	}
	const copied = key === null ? !!v.keyBackedUpAt : copyRecorded(v, key)
	rows.push(row(copied, 'Vault key copy', copied ? `offline copy recorded ${v.keyBackedUpAt}` : 'no offline copy of this key recorded, so encrypted backups refuse: wp-brain vault key export, then confirm'))
	const visibility = repoVisibility(v.repo)
	rows.push(row(visibility === 'private', 'Vault repo', `${v.repo} is ${visibility === 'unknown' ? 'of unknown visibility (login? network?)' : visibility}`, visibility === 'public'))
	const clone = vaultClone()
	if (!existsSync(join(clone, '.git'))) rows.push(row(false, 'Vault snapshot', `no clone at ${clone}: wp-brain vault init`))
	else {
		try {
			const last = list({ cfg: v, clone }).filter((i) => i.kind === 'database').map((i) => i.verifiedAt).filter(Boolean).sort().at(-1)
			rows.push(row(!!last, 'Vault snapshot', last ? `last verified ${last}` : 'none verified yet'))
		} catch (e) {
			rows.push(row(false, 'Vault snapshot', `the manifests could not be read: ${e.message}`))
		}
	}
	return rows
}

/** Every part of the link, checked; exit 1 when something that matters is missing. */
export async function doctor({ CONFIG, cliPath, readAll, dbLine }) {
	const rows = []
	const check = (ok, what, detail, critical = true) => rows.push({ ok, what, detail, critical })

	const [maj, min] = process.versions.node.split('.').map(Number)
	check(maj > 22 || (maj === 22 && min >= 18), 'Node', process.versions.node + (maj > 22 || (maj === 22 && min >= 18) ? '' : ' — needs 22.18 or newer'))

	const cfg = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8')) : null
	check(!!cfg, 'Config', cfg ? `${CONFIG} → ${cfg.repo}${cfg.branch ? ` (branch ${cfg.branch})` : ''}, device ${cfg.device}` : `${CONFIG} missing — run: node ${cliPath} setup`)
	if (cfg) {
		const git = (...a) => {
			try {
				return execFileSync('git', ['-C', cfg.clone, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
			} catch {
				return null
			}
		}
		const cloned = existsSync(join(cfg.clone, '.git'))
		check(cloned, 'Clone', cloned ? cfg.clone : `${cfg.clone} missing`)
		if (cloned) {
			const current = git('branch', '--show-current')
			check(!cfg.branch || current === cfg.branch, 'Branch', current ?? '?')
			const remote = git('ls-remote', '--heads', 'origin', ...(cfg.branch ? [cfg.branch] : []))
			for (const r of repoRows({ cfg, heads: git('ls-remote', '--heads', 'origin'), visibility: repoVisibility(cfg.repo), claude: claudeDir() })) check(r.ok, r.what, r.detail, false)
			check(remote !== null && remote !== '', 'GitHub', remote === null ? 'cannot reach the repository (login? network?)' : remote === '' ? 'branch not on GitHub yet — it appears with the first entry' : 'reachable', remote === null)
			const all = readAll(cfg)
			const byDevice = {}
			for (const e of all) byDevice[e.device] = Math.max(byDevice[e.device] ?? 0, e.at)
			const exts = Object.keys(byDevice).filter((d) => d.startsWith('ext-'))
			const day = (t) => new Date(t).toISOString().slice(0, 10)
			check(all.length > 0, 'Entries', `${all.length} (${Object.keys(byDevice).length} writers)`, false)
			check(exts.length > 0, 'Extension seen', exts.length ? exts.map((d) => `${d} ${day(byDevice[d])}`).join(', ') : 'no browser has written yet — Brain page → + Add, or check Settings → Backup', false)
			const folders = listLibrary(cfg.clone, () => '').length
			check(true, 'Library', cfg.library === true ? `on — ${folders} learning folder${folders === 1 ? '' : 's'} in bridge/library` : `off — notes, transcripts, skills and rules stay on this machine (setup → question 8, or "library": true in brain.json)`, false)
			const backup = backupState(git, cfg)
			check(backup.ok, 'Extension backup', backup.detail, false)
			const db = dbLine(cfg)
			check(db.ok, 'Local database', db.detail, false)
		}
		for (const r of await vaultRows(cfg)) check(r.ok, r.what, r.detail, r.critical)
	}

	const claude = claudeDir()
	const settingsPath = join(claude, 'settings.json')
	const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {}
	const has = (event, mark) => (settings.hooks?.[event] ?? []).flatMap((g) => g.hooks ?? []).find((h) => String(h.command ?? '').includes(mark))
	const start = has('SessionStart', 'wp-brain.mjs hook')
	const stop = has('Stop', 'wp-brain.mjs stop-check')
	const recall = has('UserPromptSubmit', 'wp-brain.mjs recall')
	const points = (h) => !h || String(h.command).includes(cliPath)
	const g = guardHook(settings)
	if (!g) check(true, 'Guard', 'off — asks before push, deploys and discards are not enforced (setup --guard yes)', false)
	else {
		const path = guardPathOf(g.command)
		check(existsSync(path), 'Guard', existsSync(path) ? `on — ${path}` : `on, but ${path} does not exist; run setup --guard yes again`, false)
		const att = settings.attribution
		check(!!att && att.commit === '' && att.pr === '', 'Guard attribution', att && !(att.commit === '' && att.pr === '') ? 'your own attribution setting still adds a trailer to commits or PRs; the guard denies one, but set commit and pr to "" to stop it' : att ? 'commits and PRs carry no attribution' : 'attribution is not switched off in settings.json (setup --guard yes)', false)
	}
	const rm = ruleMapState(claude)
	if (rm.exists) check(rm.ok, 'Rule map', rm.detail, false)
	// Installed as a Claude Code plugin: the hooks and the skill come from it.
	const plugin = viaPlugin(claude, settings)
	const memoryState = memoryRow(cfg, settings, plugin, claude)
	check(memoryState.ok, memoryState.what, memoryState.detail, memoryState.critical)
	for (const r of await (await import('./auto-backup.mjs')).backupRows({ cfg, cliPath })) check(r.ok, r.what, r.detail, r.critical)
	if (plugin) {
		check(true, 'Plugin', `${plugin} — brings the skill and the hooks`, false)
		if (start || stop || recall) check(true, 'Hooks', 'settings.json has its own copy too; the plugin’s stay quiet, so nothing runs twice', false)
		return report(rows)
	}
	check(!!start && points(start), 'SessionStart hook', start ? (points(start) ? 'installed' : `points at another copy: ${start.command}`) : 'not installed (setup → question 4)', false)
	check(!!stop && points(stop), 'Stop hook', stop ? (points(stop) ? 'installed' : `points at another copy: ${stop.command}`) : 'not installed (setup → question 5)', false)
	check(!!recall && points(recall), 'Prompt recall hook', recall ? (points(recall) ? 'installed' : `points at another copy: ${recall.command}`) : 'not installed (setup → question 4; relevant lessons are not shown per prompt)', false)
	const ruleNow = ruleState(claude)
	check(ruleNow.ok, 'Global rule', ruleNow.detail, false)
	const skill = join(claude, 'skills', 'workpulse-brain', 'SKILL.md')
	check(existsSync(skill), 'Skill', existsSync(skill) ? skill : 'not linked (setup → question 7)', false)

	report(rows)
}

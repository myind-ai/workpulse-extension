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
// Settings files are backed up before they are written, and every step can be
// re-run safely. Answers can be given as flags for a non-interactive run:
//   --repo owner/repo --create yes --branch brain --device cli-mac --brief yes --record yes --rule yes --skill yes
// A repository that doesn't exist yet is created private with gh (after asking).
//
// CLAUDE_HOME (or Claude Code's own CLAUDE_CONFIG_DIR) overrides ~/.claude.

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'

const CLAUDE = () => process.env.CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const START = '<!-- workpulse-brain:start -->'
const END = '<!-- workpulse-brain:end -->'

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

/**
 * True when ~/.claude/settings.json already runs this wp-brain hook itself (from
 * `setup`). The plugin's copy of the hook then stays quiet, so nothing runs twice.
 */
export function settingsRunHook(settingsText, mark) {
	try {
		const hooks = JSON.parse(settingsText || '{}').hooks ?? {}
		return Object.values(hooks).some((groups) => groups?.some?.((g) => g.hooks?.some((h) => String(h.command ?? '').includes(mark))))
	} catch {
		return false
	}
}

export const settingsHasHook = (mark) => {
	const p = join(CLAUDE(), 'settings.json')
	return existsSync(p) && settingsRunHook(readFileSync(p, 'utf8'), mark)
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
export function nudgeText() {
	return [
		'The WorkPulse Brain plugin is installed but not linked to a repository yet.',
		'Early in this session, offer the user once, in one line, to link it now; if they say yes, follow the',
		'"Setup" section of the workpulse-brain skill (it asks the repository with AskUserQuestion, creates it',
		'private if missing, and prints the browser steps for the extension). If they decline, do not ask again',
		'in this session.',
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

/** Adds or replaces our hook on one event, leaving every other hook alone. */
export function placeHook(settings, event, command, mark, extra = {}) {
	const hooks = (settings.hooks ??= {})
	const list = (hooks[event] ?? []).map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !String(h.command ?? '').includes(mark)) })).filter((g) => g.hooks.length)
	list.push({ hooks: [{ type: 'command', command, timeout: 15, ...extra }] })
	hooks[event] = list
	return settings
}

/** Takes our hook off one event (when you answer no on a re-run). */
export function removeHook(settings, event, mark) {
	if (!settings.hooks?.[event]) return settings
	const list = settings.hooks[event].map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !String(h.command ?? '').includes(mark)) })).filter((g) => g.hooks.length)
	if (list.length) settings.hooks[event] = list
	else delete settings.hooks[event]
	return settings
}

export async function setup({ opt, cliPath, skillDir, init, repoName = 'workpulse-notes', tokenUrl = () => 'https://github.com/settings/personal-access-tokens/new' }) {
	const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null
	try {
		console.log('Link Claude Code on this machine to the WorkPulse Brain. Enter keeps the [default].\n')
		const login = opt.repo ? null : run('gh', ['api', 'user', '--jq', '.login'])
		// Seven questions whose defaults are what almost everyone wants: say them once and take one Enter.
		// `--yes` takes them without asking; "n" walks the seven as before. Flags given still win.
		const device0 = `cli-${hostname().split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '')}`
		const repo0 = opt.repo && opt.repo !== true ? String(opt.repo) : login ? `${login}/${repoName}` : ''
		// --repo and --branch (what the extension's copy line passes) fill the summary; any other flag means
		// the person is choosing for themselves, so they get the questions.
		const branch0 = opt.branch && opt.branch !== true ? String(opt.branch) : 'brain'
		const asked = ['device', 'brief', 'record', 'rule', 'skill', 'create'].some((k) => opt[k] !== undefined)
		if (repo0 && !asked) {
			console.log(`Recommended:\n  repository  ${repo0} (created private if it doesn't exist)\n  branch      ${branch0 === '-' ? 'the default branch' : branch0}\n  this machine ${device0}\n  hooks       brief at session start, ask once to record after a commit\n  also        the Brain rule in ~/.claude/CLAUDE.md and the workpulse-brain skill\n`)
			const take = opt.yes || !rl || yes(await ask(rl, undefined, 'Use the recommended setup? (n = answer each question) Y/n', 'y'))
			if (take) opt = { create: 'y', device: device0, brief: 'y', record: 'y', rule: 'y', skill: 'y', ...opt, repo: repo0, branch: branch0 }
			console.log('')
		}
		const repo = await ask(rl, opt.repo, '1. Brain repository (owner/repo — the one set in the extension’s Settings → Backup; a new one is created private)', login ? `${login}/${repoName}` : '')
		if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('A repository is needed, as owner/repo.')
		if (!opt['no-push']) {
			let made = 'exists'
			if (run('gh', ['repo', 'view', repo, '--json', 'name']) == null) {
				const create = yes(await ask(rl, opt.create, `   ${repo} doesn't exist yet. Create it as a private repository? y/n`, 'y'))
				made = ensureRepo({ repo, create })
			}
			console.log(`   ✓ ${repo} ${made === 'created' ? 'created (private)' : 'found'}`)
		}
		const branch = await ask(rl, opt.branch, '2. Branch (the same as the extension’s Backup → Branch; "-" for the default branch)', 'brain')
		const device = await ask(rl, opt.device, '3. This machine’s name in the Brain', `cli-${hostname().split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '')}`)
		const brief = yes(await ask(rl, opt.brief, '4. Brief Claude at the start of every session on a ticket branch, and put relevant past lessons in front of each prompt? (SessionStart + UserPromptSubmit hooks) y/n', 'y'))
		const record = yes(await ask(rl, opt.record, '5. Ask Claude once to record the session after a commit? (Stop hook) y/n', 'y'))
		const rule = yes(await ask(rl, opt.rule, '6. Add the WorkPulse Brain rule to ~/.claude/CLAUDE.md? y/n', 'y'))
		const skill = yes(await ask(rl, opt.skill, '7. Link the workpulse-brain skill into ~/.claude/skills? y/n', 'y'))
		const br = branch === '-' ? '' : branch
		console.log('')

		// 1–3: the clone and the config.
		init({ pos: [repo], opt: { ...(br ? { branch: br } : {}), device, ...(opt.clone ? { clone: opt.clone } : {}), ...(opt['no-push'] ? { 'no-push': true } : {}) } })

		// 4–5: hooks, merged into settings.json, with a backup first.
		const claude = CLAUDE()
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
		const after = JSON.stringify(settings, null, 2) + '\n'
		if (after !== before) {
			if (existsSync(settingsPath)) copyFileSync(settingsPath, `${settingsPath}.wp-brain.bak`)
			writeFileSync(settingsPath, after)
		}
		console.log(`${brief ? '✓' : '–'} SessionStart brief + prompt recall   ${record ? '✓' : '–'} Stop record   → ${settingsPath}${after !== before ? ' (backup: settings.json.wp-brain.bak)' : ' (unchanged)'}`)

		// 6: the global rule.
		if (rule) {
			const mdPath = join(claude, 'CLAUDE.md')
			const md = existsSync(mdPath) ? readFileSync(mdPath, 'utf8') : '# Global Claude Code Rules\n'
			const next = placeRule(md, ruleText({ repo, branch: br, cli: cliPath }))
			if (next !== md) {
				if (existsSync(mdPath)) copyFileSync(mdPath, `${mdPath}.wp-brain.bak`)
				writeFileSync(mdPath, next)
			}
			console.log(`✓ Rule in ${mdPath}${next !== md ? ' (backup: CLAUDE.md.wp-brain.bak)' : ' (unchanged)'}`)
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

const isLink = (p) => {
	try {
		return lstatSync(p).isSymbolicLink()
	} catch {
		return false
	}
}

/** Every part of the link, checked; exit 1 when something that matters is missing. */
export function doctor({ CONFIG, cliPath, readAll }) {
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
			check(remote !== null && remote !== '', 'GitHub', remote === null ? 'cannot reach the repository (login? network?)' : remote === '' ? 'branch not on GitHub yet — it appears with the first entry' : 'reachable', remote === null)
			const all = readAll(cfg)
			const byDevice = {}
			for (const e of all) byDevice[e.device] = Math.max(byDevice[e.device] ?? 0, e.at)
			const exts = Object.keys(byDevice).filter((d) => d.startsWith('ext-'))
			const day = (t) => new Date(t).toISOString().slice(0, 10)
			check(all.length > 0, 'Entries', `${all.length} (${Object.keys(byDevice).length} writers)`, false)
			check(exts.length > 0, 'Extension seen', exts.length ? exts.map((d) => `${d} ${day(byDevice[d])}`).join(', ') : 'no browser has written yet — Brain page → + Add, or check Settings → Backup', false)
			const backup = existsSync(join(cfg.clone, cfg.backupDir || 'workpulse', 'index.json'))
			check(backup, 'Extension backup', backup ? `${cfg.backupDir || 'workpulse'}/ present (its Learnings reach the brief)` : 'not on this branch yet — Settings → Backup → Back up now', false)
		}
	}

	const claude = CLAUDE()
	const settingsPath = join(claude, 'settings.json')
	const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {}
	const has = (event, mark) => (settings.hooks?.[event] ?? []).flatMap((g) => g.hooks ?? []).find((h) => String(h.command ?? '').includes(mark))
	const start = has('SessionStart', 'wp-brain.mjs hook')
	const stop = has('Stop', 'wp-brain.mjs stop-check')
	const recall = has('UserPromptSubmit', 'wp-brain.mjs recall')
	const points = (h) => !h || String(h.command).includes(cliPath)
	// Installed as a Claude Code plugin: the hooks and the skill come from it.
	const plugin = viaPlugin(claude, settings)
	if (plugin) {
		check(true, 'Plugin', `${plugin} — brings the skill and the three hooks`, false)
		if (start || stop || recall) check(true, 'Hooks', 'settings.json has its own copy too; the plugin’s stay quiet, so nothing runs twice', false)
		return report(rows)
	}
	check(!!start && points(start), 'SessionStart hook', start ? (points(start) ? 'installed' : `points at another copy: ${start.command}`) : 'not installed (setup → question 4)', false)
	check(!!stop && points(stop), 'Stop hook', stop ? (points(stop) ? 'installed' : `points at another copy: ${stop.command}`) : 'not installed (setup → question 5)', false)
	check(!!recall && points(recall), 'Prompt recall hook', recall ? (points(recall) ? 'installed' : `points at another copy: ${recall.command}`) : 'not installed (setup → question 4; relevant lessons are not shown per prompt)', false)
	const md = existsSync(join(claude, 'CLAUDE.md')) ? readFileSync(join(claude, 'CLAUDE.md'), 'utf8') : ''
	check(md.includes(START) || md.includes('## WorkPulse Brain'), 'Global rule', md.includes(START) ? 'installed' : md.includes('## WorkPulse Brain') ? 'present (hand-written; setup will replace it with the managed copy)' : 'not in CLAUDE.md (setup → question 6)', false)
	const skill = join(claude, 'skills', 'workpulse-brain', 'SKILL.md')
	check(existsSync(skill), 'Skill', existsSync(skill) ? skill : 'not linked (setup → question 7)', false)

	report(rows)
}

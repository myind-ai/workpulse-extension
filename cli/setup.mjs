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
//   --repo owner/repo --branch brain --device cli-mac --brief yes --record yes --rule yes --skill yes
//
// CLAUDE_HOME overrides ~/.claude (for trying it without touching the real one).

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'

const CLAUDE = () => process.env.CLAUDE_HOME || join(homedir(), '.claude')
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

export async function setup({ opt, cliPath, skillDir, init }) {
	const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null
	try {
		console.log('Link Claude Code on this machine to the WorkPulse Brain. Enter keeps the [default].\n')
		const repo = await ask(rl, opt.repo, '1. Brain repository (owner/repo — the one set in the extension’s Settings → Backup)', '')
		if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('A repository is needed, as owner/repo.')
		const branch = await ask(rl, opt.branch, '2. Branch (the same as the extension’s Backup → Branch; "-" for the default branch)', 'brain')
		const device = await ask(rl, opt.device, '3. This machine’s name in the Brain', `cli-${hostname().split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '')}`)
		const brief = yes(await ask(rl, opt.brief, '4. Brief Claude at the start of every session on a ticket branch? (SessionStart hook) y/n', 'y'))
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
		if (record) placeHook(settings, 'Stop', `${node} stop-check 2>/dev/null || true`, 'wp-brain.mjs stop-check')
		else removeHook(settings, 'Stop', 'wp-brain.mjs stop-check')
		const after = JSON.stringify(settings, null, 2) + '\n'
		if (after !== before) {
			if (existsSync(settingsPath)) copyFileSync(settingsPath, `${settingsPath}.wp-brain.bak`)
			writeFileSync(settingsPath, after)
		}
		console.log(`${brief ? '✓' : '–'} SessionStart brief   ${record ? '✓' : '–'} Stop record   → ${settingsPath}${after !== before ? ' (backup: settings.json.wp-brain.bak)' : ' (unchanged)'}`)

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

		console.log(`\nDone. In Chrome: WorkPulse → Settings → Backup → Branch "${br || '(default)'}", repository ${repo}, then Claude Code & the Brain shows this machine once it writes.\nCheck everything: node ${cliPath} doctor`)
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
	const points = (h) => !h || String(h.command).includes(cliPath)
	check(!!start && points(start), 'SessionStart hook', start ? (points(start) ? 'installed' : `points at another copy: ${start.command}`) : 'not installed (setup → question 4)', false)
	check(!!stop && points(stop), 'Stop hook', stop ? (points(stop) ? 'installed' : `points at another copy: ${stop.command}`) : 'not installed (setup → question 5)', false)
	const md = existsSync(join(claude, 'CLAUDE.md')) ? readFileSync(join(claude, 'CLAUDE.md'), 'utf8') : ''
	check(md.includes(START) || md.includes('## WorkPulse Brain'), 'Global rule', md.includes(START) ? 'installed' : md.includes('## WorkPulse Brain') ? 'present (hand-written; setup will replace it with the managed copy)' : 'not in CLAUDE.md (setup → question 6)', false)
	const skill = join(claude, 'skills', 'workpulse-brain', 'SKILL.md')
	check(existsSync(skill), 'Skill', existsSync(skill) ? skill : 'not linked (setup → question 7)', false)

	for (const r of rows) console.log(`${r.ok ? '✓' : r.critical ? '✗' : '!'} ${r.what.padEnd(18)} ${r.detail}`)
	const bad = rows.filter((r) => !r.ok && r.critical)
	console.log(bad.length ? `\n${bad.length} problem(s) to fix.` : '\nLinked.')
	if (bad.length) process.exitCode = 1
}

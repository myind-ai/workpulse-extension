// First run after installing the plugin: `wp-brain connect` takes the two answers the skill asks for (how it is used, which repository),
// and does the rest. It writes only ~/.config/workpulse and ~/.workpulse, so Claude may run it: hooks come from the plugin.
// Reused: init (wp-brain.mjs) for the repository and clone, config backup for the skills, makeMemoryDb and writeMemoryFlag for session memory.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { configFilesIn, fileSecretsIn } from './library.mjs'
import { makeMemoryDb, pluginRunsMemory, writeMemoryFlag } from './memory-setup.mjs'
import { claudeDir, extensionSteps, viaPlugin } from './setup.mjs'

export const USES = ['brain', 'skills', 'sessions']
const USAGE = `Usage: wp-brain connect [--repo NAME|owner/name] [--use ${USES.join('|')}]`

const readJson = (path, empty) => {
	try {
		return JSON.parse(readFileSync(path, 'utf8'))
	} catch {
		return empty
	}
}

/** owner/name from what was answered: nothing means the default name, a bare name goes under this login. */
export function repoFrom(answer, login, defaultName) {
	const name = typeof answer === 'string' && answer ? answer : defaultName
	if (/^[\w.-]+\/[\w.-]+$/.test(name)) return name
	if (!/^[\w.-]+$/.test(name)) throw new Error(`"${name}" is not a repository name. ${USAGE}`)
	if (!login) throw new Error('GitHub is not signed in, so a new repository cannot be made. Run: gh auth login, then ask again.')
	return `${login}/${name}`
}

/** The files to store and the ones left out for looking like they hold a secret, named without their values. */
export function sortSkills(claude, skip) {
	const { keep } = configFilesIn(claude, skip)
	const flagged = keep.filter((f) => fileSecretsIn(readFileSync(f.abs, 'utf8')).length).map((f) => f.rel)
	return { stored: keep.length - flagged.length, flagged }
}

export async function connect({ opt, config, init, backupSkills, defaultName, tokenUrl, gh = (...a) => execFileSync('gh', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() }) {
	const use = typeof opt.use === 'string' ? opt.use : 'skills'
	if (!USES.includes(use)) throw new Error(USAGE)
	let login = null
	try {
		login = gh('api', 'user', '--jq', '.login')
	} catch {
		/* said below, if it matters */
	}
	const repo = repoFrom(opt.repo, login, defaultName)
	const linked = readJson(config, null)
	if (linked?.repo && linked.repo.toLowerCase() !== repo.toLowerCase()) throw new Error(`This computer already uses ${linked.repo}. To change repository and keep the history: wp-brain move ${repo}`)

	// init would keep a leftover clone's remote and only change the config, so this computer would look linked to one repository and write to another.
	const clone = process.env.WP_BRAIN_CLONE || join(homedir(), '.workpulse', 'brain')
	if (!linked && existsSync(join(clone, '.git'))) {
		const origin = execFileSync('git', ['-C', clone, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim()
		if (!origin.toLowerCase().includes(repo.toLowerCase())) throw new Error(`${clone} is a clone of ${origin}, not ${repo}. Move that folder aside and run this again. Nothing was changed.`)
	}

	init({ pos: [repo], opt: { branch: 'brain', create: true, ...(typeof opt.device === 'string' ? { device: opt.device } : {}) } })
	const said = [`Your Brain is ${repo} (private, branch brain). Lessons and tickets are saved there and read back from there.`]

	if (use !== 'brain') {
		const cfg = readJson(config, {})
		cfg.library = true
		const claude = claudeDir()
		const { stored, flagged } = existsSync(claude) ? sortSkills(claude, cfg.configSkip) : { stored: 0, flagged: [] }
		if (flagged.length) cfg.configSkip = [...new Set([...(cfg.configSkip ?? []), ...flagged])]
		writeFileSync(config, JSON.stringify(cfg, null, 2) + '\n')
		if (stored) backupSkills()
		said.push(stored ? `Skills and rules: ${stored} files stored. Run wp-brain config backup to store later changes; a new computer gets them with wp-brain config restore.` : 'Skills and rules: none on this computer yet.')
		if (flagged.length) said.push(`Left out because they look like they hold a secret (${flagged.length}), so check them:\n${flagged.slice(0, 20).map((f) => `  ${f}`).join('\n')}${flagged.length > 20 ? `\n  …and ${flagged.length - 20} more` : ''}`)
	}

	if (use === 'sessions') {
		const claude = claudeDir()
		const plugin = viaPlugin(claude, readJson(join(claude, 'settings.json'), {}))
		if (plugin && pluginRunsMemory(claude, plugin)) {
			await makeMemoryDb()
			writeMemoryFlag(config, true)
			said.push('Session memory: on. Prompts and answers stay on this computer, secrets masked, searchable with wp-brain memory search.')
		} else said.push('Session memory: not on yet. It needs a hook in settings.json, which is yours to allow: ! node <this CLI> memory on')
	}

	said.push('', extensionSteps({ repo, branch: 'brain', tokenUrl }))
	return said.join('\n')
}

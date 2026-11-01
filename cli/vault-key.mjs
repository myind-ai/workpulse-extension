// wp-brain vault init and vault key export | confirm | import.
// init turns the vault on: a private repository with a first commit, its clone, a key made only for a new repository, and "vault" in brain.json.
// The key is never printed except by `key export` in the owner's own terminal; it is pasted in only through hidden input.
// Outside things come in through ctx, as in vault.mjs: { gh, keystore, clone, configPath, repoVisibility, cloneRepo, isTTY, prompt, promptHidden, log, now }.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'

import { USAGE, accountOf, allManifests, copyRecorded, git, prepare, pullRebase, requireCloneOfRepo, requirePrivate, shown, vaultClone } from './vault.mjs'
import { NO_AGE, ageAvailable, fingerprint, keystore as macKeystore, newKey, validateKey } from './vault-crypto.mjs'
import { parseVaultConfig } from './vault-manifest.mjs'

const REPO_NAME = 'workpulse-vault'
const OFFLINE_COPY = 'Write it down or print it, and keep it somewhere that is not this Mac, such as a password manager and a paper copy. Never paste it into a chat.'
const NEXT_EXPORT = 'Encrypted backups stay refused until the key has an offline copy, because losing the key loses them. In your own terminal, run `wp-brain vault key export`, keep the copy off this Mac, then run `wp-brain vault key confirm`.'
const NEXT_IMPORT = 'Then, in your own terminal, run `wp-brain vault key import` and paste the key from your offline copy.'
const NO_COPY_WAY_OUT = 'If no copy of a key exists and the repository holds no encrypted items, delete the empty repository and run this again.'
const NO_KEY = 'There is no vault key on this Mac: run `wp-brain vault key import`.'

/** gh's output stays here: `gh auth status` can name a token, and nothing it says goes further unless asked for. */
function realGh(args) {
	const r = spawnSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 })
	return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

const ownerOf = (repo) => (typeof repo === 'string' && repo.includes('/') ? repo.split('/')[0] : null)
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase() // GitHub names ignore case

/**
 * Whether gh's account is the one the vault should use. { stop } refuses --yes until the owner settles it; { note } is a difference
 * already settled, by naming vault.repo under this account on purpose. A vault under the wrong account means a key and backups
 * nobody looks for, so this is said out loud rather than shown only as a repository name in the plan.
 */
function accountCheck(login, rawCfg, configPath) {
	const chosen = ownerOf(rawCfg.vault?.repo)
	const brain = ownerOf(rawCfg.repo)
	if (chosen && !sameName(chosen, login)) return { stop: `gh is logged in as ${login}, but vault.repo in ${configPath} is ${rawCfg.vault.repo}. Run \`gh auth switch --user ${chosen}\`, or correct vault.repo, then run this again.` }
	if (!brain || sameName(brain, login)) return {}
	if (chosen) return { note: `Note: the vault is under ${login}, and the Brain repository belongs to ${brain}. vault.repo in ${configPath} says so, so this is taken as your choice.` }
	return { stop: `gh is logged in as ${login}, but the Brain repository belongs to ${brain}, so the vault would be made under ${login}. Run \`gh auth switch --user ${brain}\`; or, to keep it under ${login} on purpose, add "vault": { "repo": "${login}/${REPO_NAME}" } to ${configPath}. Then run this again.` }
}

/** Merges into "vault" in brain.json, read fresh, keeping every other key. Written whole or not at all; a link stays a link. */
function updateVaultConfig(path, patch) {
	const target = realpathSync(path)
	const cfg = JSON.parse(readFileSync(target, 'utf8'))
	cfg.vault = { ...cfg.vault, ...patch }
	parseVaultConfig(cfg)
	const tmp = `${target}.${process.pid}.partial`
	try {
		writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: statSync(target).mode & 0o777 })
		renameSync(tmp, target)
	} catch (e) {
		rmSync(tmp, { force: true })
		throw e
	}
}

/** 'exists' or 'missing'. gh saying anything else means nobody knows, and that refuses. So does a repository that answers to another name. */
function repoState(gh, repo) {
	const r = gh(['repo', 'view', repo, '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
	if (r.ok && r.out.toLowerCase() === repo.toLowerCase()) return 'exists'
	if (r.ok) throw new Error(`${repo} now answers as ${r.out}: it was renamed or moved. Nothing was changed.`)
	if (/could not resolve to a repository/i.test(r.err)) return 'missing'
	throw new Error(`gh could not say whether ${repo} exists, so nothing was changed.${shown(r.err)}`)
}

/** A clone made before the repository had a commit takes the remote's default branch, so adding a README on GitHub is all it needs. */
function takeRemoteBranch(ctx) {
	const stuck = `The clone at ${ctx.clone} has no commit and could not take one from ${ctx.cfg.repo}. Check that gh and git can reach it; if this keeps happening, move that folder aside, then run this again.`
	let heads
	try {
		heads = git(ctx, 'ls-remote', '--symref', 'origin', 'HEAD')
	} catch {
		throw new Error(stuck)
	}
	const branch = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(heads)?.[1]
	if (!branch || !/^[0-9a-f]{40,}\s+HEAD$/m.test(heads)) throw new Error(`${ctx.cfg.repo} has no first commit on a branch yet, and every vault run pulls. Add a README to it on GitHub, then run this again.`)
	try {
		git(ctx, 'fetch', '-q', 'origin')
		git(ctx, 'checkout', '-q', '-B', branch, '--track', `origin/${branch}`)
	} catch {
		throw new Error(stuck)
	}
}

/** Every real run pulls, which needs a branch with a commit. */
function requireFirstCommit(ctx) {
	try {
		git(ctx, 'rev-parse', '--verify', '-q', 'HEAD')
	} catch {
		takeRemoteBranch(ctx)
	}
	try {
		git(ctx, 'symbolic-ref', '-q', 'HEAD')
	} catch {
		throw new Error(`The clone at ${ctx.clone} is not on a branch, and every vault run pulls. Switch it to its branch with git, then run this again.`)
	}
}

/** The fingerprints of the keys the manifests in the clone were encrypted with. */
const keysListed = (ctx) => new Set(allManifests(ctx).flatMap((m) => m.items).map((i) => i.keyFp).filter(Boolean))

const pullClone = (ctx) => {
	const branch = git(ctx, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
	if (branch === 'HEAD') throw new Error('the clone is not on a branch')
	pullRebase(ctx, branch)
}

/**
 * Says what it will do; with opts.yes, does it. A second run finds everything in place and changes nothing.
 * A repository that already exists never gets a new key, or the old backups would be orphaned, with one exception: the run that
 * created it stopped before making one. A marker beside the clone, written before the create, tells those apart, and even then
 * manifests listing an encrypted item mean the repository is in use, so they win over the marker.
 */
export async function init(rawCtx, { yes = false } = {}) {
	const ctx = prepare(rawCtx)
	const { log, clone, configPath, rawCfg } = ctx
	const gh = ctx.gh ?? realGh
	if (!(ctx.ageAvailable ?? ageAvailable)()) throw new Error(`${NO_AGE}. Nothing was changed.`)
	// The account comes from the API alone. `gh auth status` can exit non-zero over a stale second account, so it only picks the wording here.
	const statusOk = gh(['auth', 'status']).ok
	const asked = gh(['api', 'user', '--jq', '.login'])
	const login = asked.ok && /^[\w.-]+$/.test(asked.out) ? asked.out : null
	if (!login) throw new Error(statusOk ? 'gh could not say who is logged in, so nothing was changed.' : 'gh is not installed or not logged in: run `gh auth login`. Nothing was changed.')

	const repo = rawCfg.vault?.repo ?? `${login}/${REPO_NAME}`
	const cfg = parseVaultConfig({ ...rawCfg, vault: { ...rawCfg.vault, repo } })
	const c = { ...ctx, cfg }
	const account = accountOf(cfg)
	const { stop, note } = accountCheck(login, rawCfg, configPath)
	if (stop && yes) throw new Error(`${stop} Nothing was changed.`)
	if (stop || note) log(stop ?? note)

	const state = repoState(gh, repo)
	const cloned = existsSync(join(clone, '.git'))
	if (state === 'missing' && cloned) throw new Error(`${repo} does not exist, but a clone of a vault is at ${clone}. Move that clone aside first, so a new repository does not take its place. Nothing was changed.`)
	if (state === 'exists') requirePrivate(c)
	if (cloned) requireCloneOfRepo(c)

	const marker = `${clone}.init-pending`
	const interrupted = state === 'exists' && existsSync(marker) && readFileSync(marker, 'utf8') === repo
	const mayMakeKey = state === 'missing' || interrupted
	const existingKey = ctx.keystore.get(account)
	const hadKey = existingKey != null // a Keychain that cannot be read throws here, before anything exists

	if (!yes) {
		log('wp-brain vault init would:')
		log(state === 'missing' ? `  create the private GitHub repository ${repo} (gh repo create ${repo} --private --add-readme), then check that it is private` : `  use the private repository ${repo}, which already exists; no new repository`)
		log(cloned ? `  use the clone at ${clone}` : `  clone it to ${clone}`)
		log(hadKey ? '  keep the vault key already in the macOS Keychain; no new key' : mayMakeKey ? `  make a new vault key in the macOS Keychain, without printing it${interrupted ? ', unless the manifests already list encrypted items' : ''}` : '  make no new key, because the repository already exists and a new key would orphan its backups')
		log(`  write "vault" into ${configPath}`)
		log(stop ? 'Nothing was changed, and --yes refuses until the account is sorted out.' : 'Nothing was changed. Add --yes to do this.')
		return { changed: false }
	}

	if (state === 'missing') {
		mkdirSync(dirname(clone), { recursive: true })
		writeFileSync(marker, repo)
		const made = gh(['repo', 'create', repo, '--private', '--add-readme'])
		if (!made.ok) {
			rmSync(marker, { force: true })
			throw new Error(`gh could not create ${repo}.${shown(made.err)} If GitHub made it anyway, the next run finds no key it may make. ${NO_COPY_WAY_OUT}`)
		}
		const visibility = ctx.repoVisibility(repo)
		if (visibility !== 'private') throw new Error(`${repo} was created, but ${visibility === 'public' ? 'GitHub reports it as public' : 'its visibility could not be told'}. The vault only uses a private repository, so there is no clone, key or config. Make it private on GitHub, then run again.`)
	}
	if (!cloned) {
		mkdirSync(dirname(clone), { recursive: true })
		const got = gh(['repo', 'clone', repo, clone, '--', '--quiet'])
		if (!got.ok) throw new Error(`gh could not clone ${repo} to ${clone}.${shown(got.err)}`)
	}
	requireCloneOfRepo(c)
	requireFirstCommit(c)

	// Read once more right before writing: a set replaces, and an existing key is never replaced.
	let makeKey = !hadKey && mayMakeKey && ctx.keystore.get(account) == null
	if (makeKey && cloned) {
		try {
			pullClone(c)
		} catch {
			throw new Error(`The clone at ${clone} could not be brought up to date with ${repo}, so no key was made: its manifests may list backups under another key. Run this again when it can pull.`)
		}
	}
	if (makeKey && keysListed(c).size) makeKey = false
	if (makeKey) ctx.keystore.set(account, await newKey())
	// A record of an offline copy belongs to the old key: the new one has none yet, and backup must stop until it does.
	const oldRecord = makeKey && (rawCfg.vault?.keyBackedUpAt || rawCfg.vault?.keyBackedUpFp)
	if (rawCfg.vault?.repo !== repo || oldRecord) updateVaultConfig(configPath, { repo, ...(oldRecord ? { keyBackedUpAt: null, keyBackedUpFp: null } : {}) })
	rmSync(marker, { force: true })

	log(state === 'missing' ? `Created the private repository ${repo}.` : `Using the private repository ${repo}.`)
	log(`Clone: ${clone}`)
	log(`Config: ${configPath}`)
	if (makeKey) log('Made a new vault key in the Keychain. It was not printed.')
	else if (hadKey) log('The vault key already in the Keychain was kept.')
	else {
		let inUse = true // a manifest that cannot be read counts as in use
		try {
			inUse = keysListed(c).size > 0
		} catch {}
		log(`No new key was made: this repository already exists, and a new key would orphan its backups. ${NEXT_IMPORT}${inUse ? '' : ` ${NO_COPY_WAY_OUT}`}`)
	}
	if (makeKey || (hadKey && !copyRecorded(cfg, existingKey))) log(NEXT_EXPORT)
	if (!cfg.videos.length && !cfg.databases.length) log('To choose what goes in, list absolute paths under "videos" and "databases" in "vault" in that config.')
	return { changed: true }
}

/** Prints the key once, for the owner's eyes. Refuses before reading the Keychain when the output is not a terminal. */
export function keyExport(rawCtx) {
	const ctx = prepare(rawCtx)
	if (!ctx.isTTY) throw new Error('`vault key export` prints the key, so it runs only in your own terminal, with its output going to the screen. Nothing was printed.')
	const key = ctx.keystore.get(accountOf(ctx.cfg))
	if (key == null) throw new Error(NO_KEY)
	ctx.log(`Your vault key, an age key. It is the only thing that opens your encrypted backups:\n\n${key}\n`)
	ctx.log(OFFLINE_COPY)
	ctx.log('Then run `wp-brain vault key confirm`.')
}

/** Records the offline copy after the owner types the key's last 4 characters from it, which shows the copy can be read. */
export async function keyConfirm(rawCtx) {
	const ctx = prepare(rawCtx)
	const key = ctx.keystore.get(accountOf(ctx.cfg))
	if (key == null) throw new Error(NO_KEY)
	const typed = await ctx.prompt('Type the last 4 characters of the key, reading them from your offline copy: ')
	if (String(typed).trim() !== key.slice(-4)) throw new Error('Those are not the last 4 characters of the vault key, so nothing was recorded. Check your copy, or make a new one with `wp-brain vault key export`.')
	const at = new Date(ctx.nowMs()).toISOString()
	updateVaultConfig(ctx.configPath, { keyBackedUpAt: at, keyBackedUpFp: fingerprint(key) })
	ctx.log(`Recorded the offline copy of the vault key at ${at}.`)
}

/** Saves a pasted key on a new Mac, once its fingerprint is checked against what the manifests list. Never replaces a different key. */
export async function keyImport(rawCtx) {
	const ctx = prepare(rawCtx)
	requireCloneOfRepo(ctx)
	try {
		pullClone(ctx)
	} catch {
		ctx.log('Could not refresh the manifests from the vault repository, so the key is checked against this clone as it stands.')
	}
	const listed = keysListed(ctx)
	const key = await validateKey(await ctx.promptHidden('Paste the vault key (it is not shown): '))
	const fp = fingerprint(key)
	const account = accountOf(ctx.cfg)
	const stored = ctx.keystore.get(account)
	if (stored != null && stored !== key) throw new Error(`A different vault key is already on this Mac (fingerprint ${fingerprint(stored)}; the pasted one is ${fp}). The Keychain was not changed.`)
	if (listed.size && !listed.has(fp)) throw new Error(`The pasted key has fingerprint ${fp}, and the manifests list ${[...listed].join(', ')}, so it would not open these backups. The Keychain was not changed.`)
	if (stored == null) ctx.keystore.set(account, key)
	// Nothing ties an old record of an offline copy to this key, so it can't stand. Import itself never makes a record.
	const dropRecord = stored == null && !listed.size && (ctx.cfg.keyBackedUpAt || ctx.cfg.keyBackedUpFp)
	if (dropRecord) updateVaultConfig(ctx.configPath, { keyBackedUpAt: null, keyBackedUpFp: null })
	ctx.log(stored == null ? `Saved the vault key in the Keychain (fingerprint ${fp}).` : `This key is already in the Keychain (fingerprint ${fp}).`)
	ctx.log(listed.size ? 'Its fingerprint matches the manifests.' : 'The manifests list no encrypted item yet, so its fingerprint could not be checked.')
	if (dropRecord || !copyRecorded(ctx.cfg, key)) ctx.log('To back up from this Mac too, run `wp-brain vault key confirm`, reading from your offline copy.')
}

/** One line from the terminal. Hidden: nothing typed is echoed. Ctrl-C or a closed input is a cancel, never an empty answer. */
export function readLine(question, { input = process.stdin, output = process.stdout, hidden = false } = {}) {
	return new Promise((resolve, reject) => {
		output.write(question)
		const echo = hidden ? new Writable({ write: (_chunk, _enc, done) => done() }) : output
		const rl = createInterface({ input, output: echo, terminal: true, historySize: 0 })
		let answered = false
		rl.on('line', (line) => {
			answered = true
			rl.close()
			if (hidden) output.write('\n')
			resolve(line)
		})
		rl.on('SIGINT', () => rl.close())
		rl.on('close', () => {
			if (!answered) reject(new Error('Cancelled: nothing was changed.'))
		})
	})
}

/** Asks only someone at a terminal; a pipe would mean the answer passed through whatever is piping it. */
const fromTerminal = (hidden) => (question) => {
	if (!process.stdin.isTTY) throw new Error('This asks you to type at your own terminal, so it cannot run here. Nothing was changed.')
	return readLine(question, { hidden })
}

/** `wp-brain vault init` and `wp-brain vault key <sub>`. deps.cfg is brain.json, deps.configPath its path. */
export async function runKeyCli({ pos, opt }, deps) {
	const [sub, what] = pos
	const allowed = sub === 'init' ? ['yes'] : []
	const unknown = Object.keys(opt).filter((k) => !allowed.includes(k))
	if (unknown.length) throw new Error(`Unknown option --${unknown[0]}. ${USAGE}`)
	if (pos.length > (sub === 'init' ? 1 : 2)) throw new Error(USAGE)
	// The usual parser lets `--yes` swallow a following word; a repository is created only on the flag exactly.
	if (opt.yes !== undefined && opt.yes !== true) throw new Error(`--yes takes no value: it was followed by a word, so nothing was changed. ${USAGE}`)
	const { cfg: rawCfg, ...rest } = deps
	const ctx = {
		keystore: macKeystore,
		clone: vaultClone(),
		isTTY: !!process.stdout.isTTY,
		prompt: fromTerminal(false),
		promptHidden: fromTerminal(true),
		...rest,
	}
	if (sub === 'init') return init({ ...ctx, rawCfg }, { yes: opt.yes === true })
	if (!['export', 'confirm', 'import'].includes(what)) throw new Error(USAGE)
	const cfg = parseVaultConfig(rawCfg)
	if (!cfg) throw new Error('The vault is off: run `wp-brain vault init`.')
	const withCfg = { ...ctx, cfg }
	if (what === 'export') return keyExport(withCfg)
	return what === 'confirm' ? keyConfirm(withCfg) : keyImport(withCfg)
}

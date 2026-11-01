// Moves the Brain to its own repository, history and all, for anyone whose learning started out inside another repository.
// Only ever adds: nothing is force-pushed, and the old repository is left as it was until its owner removes it by hand.
// Reused: ensureRepo (setup.mjs) to create the repository, repoVisibility (library.mjs) to check it. Git comes in as `git(...args)`.
import { ensureRepo } from './setup.mjs'
import { repoVisibility } from './library.mjs'

const REPO = /^[\w.-]+\/[\w.-]+$/
const TARGET_REF = 'refs/wp-brain/move-target'
const OLD_REF = 'refs/wp-brain/move-old'
// What setup, the extension's first run or GitHub's "add a README" leave in a repository nobody has used yet.
const SCAFFOLD = new Set(['bridge/SCHEMA.md', 'README.md', 'LICENSE', '.gitignore'])

const sameRepo = (a, b) => a.toLowerCase() === b.toLowerCase()

/** The target's address, in the form this clone stores (https or ssh; read from config, as `remote get-url` applies insteadOf), so the same login keeps working. */
export function repoUrl(current, oldRepo, repo) {
	const at = current.toLowerCase().indexOf(oldRepo.toLowerCase())
	return at < 0 ? `https://github.com/${repo}.git` : current.slice(0, at) + repo + current.slice(at + oldRepo.length)
}

/** What the target's branch means for a move: 'none' (no branch), 'ours' (it only has our commits), 'scaffold' (unused) or 'other' (someone's data). */
function targetState(git, url, branch) {
	if (!git('ls-remote', '--heads', url, branch)) return { state: 'none', paths: [] }
	git('fetch', '-q', url, `+refs/heads/${branch}:${TARGET_REF}`)
	const paths = git('ls-tree', '-r', '--name-only', TARGET_REF).split('\n').filter(Boolean)
	try {
		git('merge-base', '--is-ancestor', TARGET_REF, 'HEAD')
		return { state: 'ours', paths }
	} catch {
		return { state: paths.every((p) => SCAFFOLD.has(p)) ? 'scaffold' : 'other', paths }
	}
}

/**
 * Looks at both sides and changes nothing. `exists` says whether GitHub knows the target; a repository that doesn't exist yet has nothing to look at.
 * Throws with the reason when the move must not happen.
 */
export function planMove({ cfg, target, git, exists, visibility = repoVisibility }) {
	if (!REPO.test(target ?? '')) throw new Error('Usage: wp-brain move owner/repo [--yes], or wp-brain move --catch-up')
	if (sameRepo(target, cfg.repo)) throw new Error(`The Brain is already in ${cfg.repo}.`)
	const branch = cfg.branch || git('branch', '--show-current')
	const url = repoUrl(git('config', '--get', 'remote.origin.url'), cfg.repo, target)
	const shown = visibility(target)
	if (exists && shown !== 'private') throw new Error(shown === 'public' ? `${target} is a public repository, and your learning does not go in one. Nothing was changed.` : `Could not tell whether ${target} is private (is the GitHub CLI signed in?). Nothing was changed.`)
	const found = exists ? targetState(git, url, branch) : { state: 'none', paths: [] }
	if (found.state === 'other') throw new Error(`${target} already holds other files on ${branch} (${found.paths.length}, such as ${found.paths.slice(0, 3).join(', ')}). They are not mixed with your Brain or written over. Pick an empty repository. Nothing was changed.`)
	const others = exists ? git('ls-remote', '--heads', url).split('\n').filter(Boolean).map((l) => l.split('refs/heads/')[1]).filter((b) => b && b !== branch) : []
	return { target, branch, url, exists, state: found.state, others, commits: Number(git('rev-list', '--count', 'HEAD')), files: git('ls-files').split('\n').filter(Boolean).length }
}

export function describePlan(plan, cfg) {
	const there = !plan.exists ? 'does not exist yet, and will be created private' : plan.state === 'scaffold' ? 'is private and unused; its few starter files are kept in the history' : plan.state === 'ours' ? 'is private and already has part of this history' : 'is private and has no Brain yet'
	return [
		`Move the Brain from ${cfg.repo} to ${plan.target} (branch ${plan.branch}).`,
		`  ${plan.commits} commits and ${plan.files} files go across, with their history.`,
		`  ${plan.target} ${there}.`,
		...(plan.others.length ? [`  Note: ${plan.target} also has ${plan.others.join(', ')}. If that holds code, a repository of its own is the better choice.`] : []),
		`  ${cfg.repo} is not changed. Its copy stays until you remove it.`,
		'Nothing has changed yet. Run again with --yes to do it.',
	].join('\n')
}

/** Does the move. Nothing here touches this machine until GitHub has the commits and shows the right tip. */
export function runMove({ plan, cfg, git, ensure = ensureRepo, visibility = repoVisibility, saveConfig, now = () => new Date().toISOString() }) {
	if (!plan.exists) {
		ensure({ repo: plan.target, create: true })
		const shown = visibility(plan.target)
		if (shown !== 'private') throw new Error(`${plan.target} was created, but GitHub reports it as ${shown}. Nothing was pushed. Make it private and run again.`)
	}
	let tip = git('rev-parse', 'HEAD')
	// Two unrelated histories join with a merge that keeps our files. Built without touching the clone, so a failed push leaves nothing behind.
	if (plan.state === 'scaffold') tip = git('commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-p', TARGET_REF, '-m', 'bridge: move the Brain here')
	git('push', '-q', plan.url, `${tip}:refs/heads/${plan.branch}`)
	const landed = git('ls-remote', plan.url, `refs/heads/${plan.branch}`).split(/\s/)[0]
	if (landed !== tip) throw new Error(`${plan.target} shows ${landed || 'nothing'} on ${plan.branch} after the push, not ${tip}. This machine still uses ${cfg.repo}.`)

	const from = cfg.repo
	git('remote', 'set-url', 'origin', plan.url)
	saveConfig({ ...cfg, repo: plan.target, movedFrom: { repo: from, at: now() } })
	git('fetch', '-q', '--prune', 'origin')
	git('merge', '-q', '--ff-only', tip)
	git('branch', `--set-upstream-to=origin/${plan.branch}`, plan.branch)
	try {
		git('update-ref', '-d', TARGET_REF)
	} catch {
		/* only tidiness */
	}
	return { from, to: plan.target, tip }
}

/** Brings across what was written to the old repository after the move: the extension keeps writing there until its settings change. */
export function catchUp({ cfg, git }) {
	const from = cfg.movedFrom?.repo
	if (!from) throw new Error('This Brain was not moved, so there is nothing to catch up on.')
	const branch = cfg.branch || git('branch', '--show-current')
	git('fetch', '-q', '--prune', 'origin')
	git('merge', '-q', '--ff-only', `origin/${branch}`)
	const oldUrl = repoUrl(git('config', '--get', 'remote.origin.url'), cfg.repo, from)
	if (!git('ls-remote', '--heads', oldUrl, branch)) return { from, brought: 0 }
	git('fetch', '-q', oldUrl, `+refs/heads/${branch}:${OLD_REF}`)
	const brought = Number(git('rev-list', '--count', `HEAD..${OLD_REF}`))
	if (!brought) return { from, brought: 0 }
	try {
		git('merge', '-q', '--no-edit', '-m', `bridge: catch up with ${from}`, OLD_REF)
	} catch (e) {
		const clashes = git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean)
		git('merge', '--abort')
		throw new Error(`Both repositories changed ${clashes.length ? clashes.slice(0, 5).join(', ') : 'the same files'}, so nothing was brought across and this clone is as it was.${clashes.length ? '' : ` ${e.message}`}`, { cause: e })
	}
	git('push', '-q', 'origin', `HEAD:refs/heads/${branch}`)
	return { from, brought }
}

/** What is left for a person after a move. */
export const afterMove = ({ from, to, branch }) =>
	[
		`The Brain now lives in ${to}. This machine reads and writes there.`,
		'',
		'Left for you:',
		'  1. In the extension (Settings → Backup → Change repository, token or schedule):',
		`     point a token at ${to} (Contents: Read and write), choose ${to}${branch ? `, branch ${branch}` : ''}, and press Back up over it.`,
		`  2. Then bring across anything the extension wrote in between: wp-brain move --catch-up`,
		`  3. Any other computer: wp-brain init ${to}${branch ? ` --branch ${branch}` : ''}`,
		`  4. If your CLAUDE.md names ${from}, change it to ${to}. wp-brain doctor says whether it does.`,
		`  5. Once wp-brain doctor is happy, remove the old copy yourself: git -C <a clone of ${from}> push origin --delete ${branch || 'BRANCH'}`,
	].join('\n')

// Test fixtures for rules and skills: a temp Claude folder with a rule map, rule files and skills. Never touches ~/.claude.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const RULES = [
	{ slug: 'git-push-rule', from: ['Push'], load: 'file', triggers: ['push', 'deploy'], not: ['push notification'], onCommand: ['git push'], title: 'Local-first: ask before push' },
	{ slug: 'commit-hygiene', from: ['Commit'], load: 'file', triggers: ['commit message', 'commit hygiene'], onCommand: ['git commit', 'gh pr create'], title: 'Commit hygiene' },
	{ slug: 'core-rules', from: ['Core'], load: 'always', triggers: ['core'], title: 'Core' },
]

export const skillText = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\nSKILLBODYTEXT\n`

export const SKILLS = {
	'flutter-paywall-audit': 'Audit a Flutter paywall and the subscription purchase flow before launch',
	'tailwindcss': 'Utility-first styling with Tailwind classes',
	'asc-cli': 'App Store Connect command line',
}

/** { claude, index, mapPath } with the map, a rule file for every non-core rule, and the skills. `map: false` writes no map. */
export function claudeFixture({ rules = RULES, skills = SKILLS, map = true, extra = 0 } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'wp-claude-'))
	const claude = join(root, 'claude')
	mkdirSync(join(claude, 'rule-files'), { recursive: true })
	mkdirSync(join(claude, 'skills'), { recursive: true })
	const mapPath = join(claude, 'rule-files', 'rule-map.json')
	if (map) writeFileSync(mapPath, JSON.stringify({ rules }))
	for (const r of rules) if (r.load !== 'always') writeFileSync(join(claude, 'rule-files', `${r.slug}.md`), `RULEBODYTEXT ${r.slug}\n`)
	for (const [name, desc] of Object.entries(skills)) {
		mkdirSync(join(claude, 'skills', name))
		writeFileSync(join(claude, 'skills', name, 'SKILL.md'), skillText(name, desc))
	}
	const filler = 'quartz nebula harbor lantern meadow orchid pebble ripple saddle timber velvet willow'.split(' ')
	for (let i = 0; i < extra; i++) {
		const name = `filler-skill-${i}`
		mkdirSync(join(claude, 'skills', name))
		writeFileSync(join(claude, 'skills', name, 'SKILL.md'), skillText(name, `Handles ${filler[i % 12]} and ${filler[(i * 5 + 1) % 12]} work number ${i} for ${filler[(i * 7 + 2) % 12]}`))
	}
	return { root, claude, mapPath, index: join(root, 'rule-index.json') }
}

/** A skill folder living outside the skills folder, linked in (as ~/.claude/skills entries often are). */
export function linkedSkill({ root, claude }, name, description) {
	const real = join(root, 'elsewhere', name)
	mkdirSync(real, { recursive: true })
	writeFileSync(join(real, 'SKILL.md'), skillText(name, description))
	symlinkSync(real, join(claude, 'skills', name))
}

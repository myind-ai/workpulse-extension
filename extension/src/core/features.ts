// Build-time switches. The official Zoho API path is complete and tested, but
// it needs a role your org may not grant — and a half-available feature that
// answers every click with "session expired" is worse than no feature. Ship it
// off, turn it on with WXT_ENABLE_API=true once API access exists.
//
// Everything newer is on by default and can be switched off the same way, one
// line in `.env` (or the shell) per feature: WXT_FEATURE_TICK=false. A switched-off
// feature is not hidden behind a setting — it is simply not there: no page, no
// alarm, no request.

const viteEnv = (import.meta as { env?: Record<string, string | undefined> }).env ?? {}
// Vitest sets process.env rather than import.meta.env, and the extension bundle
// has no process at all: read whichever exists.
const nodeEnv = typeof process !== 'undefined' && process.env ? process.env : {}

const read = (key: string): string | undefined => viteEnv[key] ?? nodeEnv[key]

/** The documented Zoho API: OAuth sign-in, Self Client, scopes, token refresh. */
export const API_ENABLED = read('WXT_ENABLE_API') === 'true'

/** Every feature that can be switched off from the environment, and what it is. */
export const FEATURES = {
	TICK: 'Tick, the cat, on cards, empty pages and while something runs',
	BRAIN: 'The Brain page: tickets, learnings, debugging, reports and projects from the bridge',
	BRIDGE_SYNC: 'Reading and writing the bridge/ folder of your backup repository',
	PERSONAL: 'Personal side projects alongside work in the Brain',
} as const

export type Feature = keyof typeof FEATURES

/** On unless WXT_FEATURE_<NAME> says false, 0 or off. */
export function enabled(feature: Feature): boolean {
	const v = read(`WXT_FEATURE_${feature}`)?.trim().toLowerCase()
	return !(v === 'false' || v === '0' || v === 'off')
}

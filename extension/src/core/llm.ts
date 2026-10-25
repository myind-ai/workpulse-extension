// Bring your own key.
//
// WorkPulse never ships a model and never relays a request: the key is yours,
// the account is yours, and the bill is yours. That is not a limitation, it is
// the only arrangement that keeps the promise the rest of the app makes — the
// most sensitive text in here is what you did and what you got wrong, and it
// is nobody's business but the provider you chose.
//
// Almost every provider now speaks the OpenAI chat shape, so there are exactly
// two request bodies to build rather than one per vendor. Anthropic is the one
// that differs, and it differs in three places: the header, the system prompt's
// position, and where the text comes back.
//
// Pure on purpose. What gets sent, and what is understood from what comes back,
// is decided here and tested without a network.

export type Shape = 'openai' | 'anthropic'

export interface Provider {
	id: string
	label: string
	/** Where the requests go. Empty means you type your own. */
	baseUrl: string
	shape: Shape
	/** A model that exists and is cheap, so the first run works. */
	suggested: string
	/** Where somebody gets a key, said plainly. */
	keyFrom: string
	/** Nothing leaves the machine. The honest reason to choose it. */
	local?: boolean
}

export const PROVIDERS: Provider[] = [
	{ id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', shape: 'openai', suggested: 'anthropic/claude-sonnet-5', keyFrom: 'openrouter.ai/keys' },
	{ id: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', shape: 'anthropic', suggested: 'claude-sonnet-5', keyFrom: 'console.anthropic.com' },
	{ id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', shape: 'openai', suggested: 'gpt-4o-mini', keyFrom: 'platform.openai.com/api-keys' },
	{ id: 'together', label: 'Together', baseUrl: 'https://api.together.xyz/v1', shape: 'openai', suggested: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', keyFrom: 'api.together.ai/settings/api-keys' },
	{ id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', shape: 'openai', suggested: 'llama-3.3-70b-versatile', keyFrom: 'console.groq.com/keys' },
	// The only option where the sensitive text does not leave the machine at
	// all. Worth listing first in spirit, even though it asks the most setup.
	{ id: 'ollama', label: 'Ollama (on this machine)', baseUrl: 'http://localhost:11434/v1', shape: 'openai', suggested: 'llama3.2', keyFrom: 'ollama.com — no key needed', local: true },
	{ id: 'lmstudio', label: 'LM Studio (on this machine)', baseUrl: 'http://localhost:1234/v1', shape: 'openai', suggested: 'local-model', keyFrom: 'lmstudio.ai — no key needed', local: true },
	{ id: 'custom', label: 'Anything OpenAI-compatible', baseUrl: '', shape: 'openai', suggested: '', keyFrom: 'whatever you are running' },
]

export const providerById = (id: string): Provider | undefined => PROVIDERS.find((p) => p.id === id)

export interface LlmConfig {
	provider: string
	/** Overrides the provider's own, and is the whole address for `custom`. */
	baseUrl: string
	model: string
}

export interface Message {
	role: 'system' | 'user' | 'assistant'
	content: string
}

/** Where a config's requests actually go, trailing slash and all handled. */
export function endpoint(cfg: LlmConfig): string {
	const p = providerById(cfg.provider)
	const base = (cfg.baseUrl.trim() || p?.baseUrl || '').replace(/\/+$/, '')
	if (!base) return ''
	return p?.shape === 'anthropic' ? `${base}/messages` : `${base}/chat/completions`
}

/**
 * What is wrong with this setup, said to the person who has to fix it — or
 * null when there is nothing wrong. Checked before a request rather than
 * after, because "401" is not an explanation.
 */
export function configProblem(cfg: LlmConfig, key: string): string | null {
	const p = providerById(cfg.provider)
	if (!p) return 'Pick where the model runs first.'
	if (!endpoint(cfg)) return 'That provider needs an address — paste the one your server is listening on.'
	if (!cfg.model.trim()) return `Name a model. For ${p.label}, ${p.suggested || 'whatever you have loaded'} is a safe first choice.`
	// A model on your own machine has nothing to authenticate against.
	if (!p.local && !key.trim()) return `${p.label} needs a key. Get one at ${p.keyFrom}.`
	return null
}

export function headersFor(cfg: LlmConfig, key: string): Record<string, string> {
	const p = providerById(cfg.provider)
	const h: Record<string, string> = { 'Content-Type': 'application/json' }
	if (!key.trim()) return h
	if (p?.shape === 'anthropic') {
		h['x-api-key'] = key.trim()
		h['anthropic-version'] = '2023-06-01'
		// Without this the browser refuses the request outright rather than
		// failing on the response, which reads as a network error and is not one.
		h['anthropic-dangerous-direct-browser-access'] = 'true'
	} else {
		h.Authorization = `Bearer ${key.trim()}`
	}
	return h
}

export function bodyFor(cfg: LlmConfig, messages: Message[], maxTokens = 1024): string {
	const p = providerById(cfg.provider)
	const model = cfg.model.trim()
	if (p?.shape === 'anthropic') {
		// Anthropic takes the system prompt beside the turns, not inside them.
		const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
		const turns = messages.filter((m) => m.role !== 'system')
		return JSON.stringify({ model, max_tokens: maxTokens, ...(system ? { system } : {}), messages: turns })
	}
	return JSON.stringify({ model, max_tokens: maxTokens, messages })
}

/** The answer, out of whichever envelope it arrived in. */
export function textFrom(shape: Shape, json: unknown): string {
	const j = json as Record<string, any>
	if (shape === 'anthropic') {
		const parts = Array.isArray(j?.content) ? j.content : []
		return parts.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('').trim()
	}
	return String(j?.choices?.[0]?.message?.content ?? '').trim()
}

/**
 * What a failure actually means, for somebody who is not going to read the
 * provider's docs. The status alone is never the answer.
 */
export function errorFor(status: number, body: string, cfg: LlmConfig): string {
	const p = providerById(cfg.provider)
	const name = p?.label ?? 'The provider'
	if (status === 401 || status === 403) return `${name} refused the key. Check it was copied in full and has not expired.`
	if (status === 404) return `${name} does not know the model “${cfg.model}”. Check the spelling against their model list.`
	if (status === 429) return `${name} is rate-limiting you, or the account is out of credit.`
	if (status === 400) return `${name} rejected the request: ${body.slice(0, 160)}`
	if (status >= 500) return `${name} is having trouble. Nothing is wrong at this end — try again shortly.`
	return `${name} returned ${status}: ${body.slice(0, 160)}`
}

/**
 * The one line shown wherever AI is offered, so the arrangement is never a
 * surprise. Named here so every surface says exactly the same thing.
 */
export function whereItGoes(cfg: LlmConfig): string {
	const p = providerById(cfg.provider)
	if (!p) return 'Nothing is sent anywhere until you choose a provider.'
	if (p.local) return 'Runs on this machine. Nothing leaves it.'
	return `Sent to ${p.label} with your own key. WorkPulse never sees it, and never relays it.`
}

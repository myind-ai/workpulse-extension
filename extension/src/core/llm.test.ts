import { describe, expect, it } from 'vitest'

import { bodyFor, configProblem, endpoint, errorFor, headersFor, PROVIDERS, providerById, textFrom, whereItGoes, type LlmConfig } from './llm'

const cfg = (over: Partial<LlmConfig> = {}): LlmConfig => ({ provider: 'openrouter', baseUrl: '', model: 'anthropic/claude-sonnet-5', ...over })

describe('bring your own key', () => {
	it('should send every openai-compatible provider to the same path', () => {
		expect(endpoint(cfg())).toBe('https://openrouter.ai/api/v1/chat/completions')
		expect(endpoint(cfg({ provider: 'groq' }))).toBe('https://api.groq.com/openai/v1/chat/completions')
	})

	it('should send anthropic to its own path', () => {
		expect(endpoint(cfg({ provider: 'anthropic' }))).toBe('https://api.anthropic.com/v1/messages')
	})

	it('should let a typed address win, trailing slash and all', () => {
		expect(endpoint(cfg({ provider: 'custom', baseUrl: 'http://127.0.0.1:8080/v1/' }))).toBe('http://127.0.0.1:8080/v1/chat/completions')
	})

	it('should not ask a model running on this machine for a key', () => {
		expect(configProblem(cfg({ provider: 'ollama', model: 'llama3.2' }), '')).toBeNull()
	})

	it('should name the place a key comes from rather than only refusing', () => {
		expect(configProblem(cfg(), '')).toContain('openrouter.ai/keys')
	})

	it('should ask for a model before it asks for anything else about it', () => {
		expect(configProblem(cfg({ model: '  ' }), 'k')).toContain('safe first choice')
	})

	it('should put the system prompt beside the turns for anthropic, and inside them elsewhere', () => {
		const msgs = [{ role: 'system' as const, content: 'be brief' }, { role: 'user' as const, content: 'hello' }]
		const a = JSON.parse(bodyFor(cfg({ provider: 'anthropic', model: 'claude-sonnet-5' }), msgs))
		expect(a.system).toBe('be brief')
		expect(a.messages).toHaveLength(1)
		const o = JSON.parse(bodyFor(cfg(), msgs))
		expect(o.messages).toHaveLength(2)
	})

	it('should authenticate each shape the way that shape expects', () => {
		expect(headersFor(cfg(), 'k').Authorization).toBe('Bearer k')
		const a = headersFor(cfg({ provider: 'anthropic' }), 'k')
		expect(a['x-api-key']).toBe('k')
		// Without this header the browser refuses before the request is even made.
		expect(a['anthropic-dangerous-direct-browser-access']).toBe('true')
	})

	it('should read the answer out of either envelope', () => {
		expect(textFrom('openai', { choices: [{ message: { content: ' hi ' } }] })).toBe('hi')
		expect(textFrom('anthropic', { content: [{ text: 'hi' }, { text: ' there' }] })).toBe('hi there')
	})

	it('should survive an envelope that is not the shape it expected', () => {
		expect(textFrom('openai', {})).toBe('')
		expect(textFrom('anthropic', { content: 'not an array' })).toBe('')
	})

	it('should explain a failure rather than quote a status code', () => {
		expect(errorFor(401, '', cfg())).toContain('refused the key')
		expect(errorFor(404, '', cfg())).toContain('claude-sonnet-5')
		expect(errorFor(429, '', cfg())).toContain('out of credit')
		expect(errorFor(503, '', cfg())).toContain('Nothing is wrong at this end')
	})

	it('should say where the text goes, in the same words everywhere', () => {
		expect(whereItGoes(cfg())).toContain('never relays it')
		expect(whereItGoes(cfg({ provider: 'ollama' }))).toBe('Runs on this machine. Nothing leaves it.')
	})

	it('should offer a local option, because that is the only zero-leak one', () => {
		expect(PROVIDERS.some((p) => p.local)).toBe(true)
		expect(providerById('ollama')?.local).toBe(true)
	})
})

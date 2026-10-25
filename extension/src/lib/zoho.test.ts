import { describe, expect, it } from 'vitest'

import { memoryKV, Store } from './store'
import { ZohoClient } from './zoho'

function client(reply: unknown, seen: { url?: string; body?: string } = {}) {
	const store = new Store(memoryKV())
	const fetchFake = (async (url: string, init?: RequestInit) => {
		seen.url = url
		seen.body = String(init?.body)
		return new Response(JSON.stringify(reply), { status: 200 })
	}) as unknown as typeof fetch
	return { store, zoho: new ZohoClient({ store, fetch: fetchFake, now: () => 1_000, redirectUrl: () => 'https://abc.chromiumapp.org/' }) }
}

describe('Self Client code exchange', () => {
	it('trades the code for a refresh token and stores it', async () => {
		const seen: { url?: string; body?: string } = {}
		const { store, zoho } = client({ access_token: '1000.at', refresh_token: '1000.rt', expires_in: 3600 }, seen)
		await zoho.exchangeSelfClientCode(' 1000.ID ', 'secret', 'code123')
		expect(seen.url).toBe('https://accounts.zoho.in/oauth/v2/token')
		expect(seen.body).toContain('grant_type=authorization_code')
		expect(seen.body).toContain('code=code123')
		expect(await store.auth()).toMatchObject({ kind: 'self', clientId: '1000.ID', refreshToken: '1000.rt', accessToken: '1000.at', expiresAt: 3_601_000 })
	})

	it('explains an expired code', async () => {
		const { zoho } = client({ error: 'invalid_code' })
		await expect(zoho.exchangeSelfClientCode('1000.ID', 'secret', 'old')).rejects.toThrow('expired or was already used')
	})

	it('exposes the redirect URI', () => {
		expect(client({}).zoho.redirectUri()).toBe('https://abc.chromiumapp.org/')
	})
})

describe('attendance read', () => {
	it('should scope the read to the email in settings', async () => {
		const seen: { url?: string } = {}
		const { store, zoho } = client({ firstIn: '-', lastOut: '-', totalHrs: '00:00', entries: [] }, seen)
		await store.saveSettings({ email: 'you@acme.com' })
		await store.setAuth({ kind: 'self', clientId: 'c', clientSecret: 's', refreshToken: 'r', accessToken: 'at', expiresAt: 10_000_000 })
		await zoho.attendance('2026-10-12')
		expect(seen.url).toContain('emailId=you%40acme.com')
	})

	it('should omit emailId while no email is set', async () => {
		const seen: { url?: string } = {}
		const { store, zoho } = client({ firstIn: '-', lastOut: '-', totalHrs: '00:00', entries: [] }, seen)
		await store.setAuth({ kind: 'self', clientId: 'c', clientSecret: 's', refreshToken: 'r', accessToken: 'at', expiresAt: 10_000_000 })
		await zoho.attendance('2026-10-12')
		expect(seen.url).not.toContain('emailId')
	})
})

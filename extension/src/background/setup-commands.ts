// Guided Zoho setup: open the right Zoho page in one click, let the helper on
// that page fill the client form and hand back the Client ID, sign in, test,
// and capture the attendance page address. Also the Self Client exchange.

import { clientFormValues, consoleUrl, dcFromHost, isClientId, isPeopleUrl, peopleUrl } from '@/core/setup'
import { DEFAULT_SETTINGS, scopesFor } from '@/core/types'

import { SettingsCommands } from './settings-commands'

export class SetupCommands extends SettingsCommands {
	async setupInfo() {
		const [s, auth, flags] = await Promise.all([this.store.settings(), this.store.auth(), this.store.setupFlags()])
		const redirectUrl = this.zoho.redirectUri()
		return {
			dataCenter: s.dataCenter,
			email: s.email,
			consoleUrl: consoleUrl(s.dataCenter),
			peopleUrl: peopleUrl(s.dataCenter),
			redirectUrl,
			formValues: clientFormValues(redirectUrl, s.dataCenter).map(({ label, value }) => ({ label, value })),
			clientId: s.oauthClientId,
			/** What a Self Client code must be generated with for the current write mode. */
			scopes: scopesFor(s.zohoMode),
			auth: auth ? auth.kind : null,
			attendanceUrl: s.attendanceUrl,
			attendanceSet: isPeopleUrl(s.attendanceUrl) && s.attendanceUrl !== DEFAULT_SETTINGS.attendanceUrl && s.attendanceUrl !== peopleUrl(s.dataCenter),
			flags,
		}
	}

	/** One click: opens the Zoho page for this step and turns its helper on. */
	async startSetup(step: 'client' | 'self' | 'attendance'): Promise<void> {
		const s = await this.store.settings()
		if (step === 'attendance') {
			await this.store.setSetupFlags({ attendance: true })
			await this.env.ui.openUrl(peopleUrl(s.dataCenter))
		} else {
			await this.store.setSetupFlags({ client: step === 'client' })
			await this.env.ui.openUrl(consoleUrl(s.dataCenter))
		}
		// openUrl reuses an already-open Zoho tab without navigating, so the
		// load-time injection never fires for it: inject here as well.
		await this.env.ui.injectSetupHelper?.()
		this.env.ui.changed()
	}

	async cancelSetup(): Promise<void> {
		await this.store.setSetupFlags({ client: false, attendance: false })
		this.env.ui.changed()
	}

	/** What the helper on a Zoho page should offer. */
	async setupState() {
		const info = await this.setupInfo()
		return { flags: info.flags, formValues: info.formValues, clientId: info.clientId, connected: info.auth != null }
	}

	async saveClientId(id: string): Promise<string> {
		const clean = id.trim()
		if (!isClientId(clean)) throw new Error('That does not look like a Zoho Client ID (it starts with 1000.).')
		await this.store.saveSettings({ oauthClientId: clean })
		this.env.ui.changed()
		return clean
	}

	/** Save the Client ID (if given), sign in with Zoho, then run the connection test. */
	async connectWithClientId(id?: string) {
		if (id) await this.saveClientId(id)
		await this.zoho.signIn(true)
		await this.store.setSetupFlags({ client: false })
		const test = await this.testConnection()
		this.env.ui.changed()
		return test
	}

	/** Self Client without curl: paste id, secret and the generated code. */
	async connectSelfClient(clientId: string, clientSecret: string, code: string) {
		await this.zoho.exchangeSelfClientCode(clientId, clientSecret, code)
		await this.store.setSetupFlags({ client: false })
		const test = await this.testConnection()
		this.env.ui.changed()
		return test
	}

	/** "Use this page" on Zoho People: saves it as the page reminders open. */
	async captureAttendanceUrl(url: string): Promise<string> {
		if (!isPeopleUrl(url)) throw new Error('Open a Zoho People page first (people.zoho.in/…).')
		const dc = dcFromHost(new URL(url).hostname)
		await this.store.saveSettings({ attendanceUrl: url, ...(dc ? { dataCenter: dc } : {}) })
		await this.store.setSetupFlags({ attendance: false })
		this.env.ui.changed()
		return url
	}
}

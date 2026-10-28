// The one place that turns the reminder preference into a real interval.
// Smart retains the existing meeting/focus/away-aware scheduler; its baseline
// is one hour so it stays predictable rather than becoming another alarm.

import type { Settings } from './types'

export function promptEvery(settings: Pick<Settings, 'promptCadence' | 'promptInterval'>): number {
	if (settings.promptCadence === 'interval') return settings.promptInterval
	return 60
}

export function promptCadenceLabel(settings: Pick<Settings, 'promptCadence' | 'promptInterval'>): string {
	if (settings.promptCadence === 'interval') return `every ${settings.promptInterval} minutes`
	if (settings.promptCadence === 'smart') return 'smart timing'
	return 'every hour'
}

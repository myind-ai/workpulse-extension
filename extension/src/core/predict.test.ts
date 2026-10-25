import { describe, expect, it } from 'vitest'

import { badMoment, captured, deskKey, predict, predictPrompt, usablePrediction } from './predict'

const tab = (title: string, url = 'https://jira.acme.com/x') => ({ title, url })

describe('never an empty box', () => {
	it('should take what you said the block was for over anything else', () => {
		const p = predict({ focusIntent: 'finish the webhook retry', lastText: 'something else', tabs: [] })
		expect(p.text).toBe('finish the webhook retry')
		expect(p.why).toBe('what you said the block was for')
	})

	it('should let a meeting beat even that, because it beat the hour', () => {
		const p = predict({ meeting: 'Sprint review', focusIntent: 'the webhook', tabs: [] })
		expect(p.text).toBe('Meeting: Sprint review')
	})

	it('should repeat the last entry when the desk agrees with it', () => {
		const p = predict({ lastText: 'LEAP-19 webhook retry', tabs: [tab('LEAP-19 a'), tab('LEAP-19 b')] })
		expect(p.text).toBe('LEAP-19 webhook retry')
		expect(p.why).toBe('still on LEAP-19')
		expect(p.strong).toBe(true)
	})

	it('should name the new ticket when the desk moved, and nothing more', () => {
		// Inventing what was done on it would be putting words in somebody's mouth.
		const p = predict({ lastText: 'LEAP-19 webhook', tabs: [tab('PAY-2433 a'), tab('PAY-2433 b')] })
		expect(p.text).toBe('PAY-2433 — ')
		expect(p.why).toContain('moved to PAY-2433')
	})

	it('should fall back to the last entry, and admit that is all it is', () => {
		const p = predict({ lastText: 'reading the spec', tabs: [tab('MDN', 'https://developer.mozilla.org/x')] })
		expect(p.text).toBe('reading the spec')
		expect(p.why).toBe('same as last hour')
		expect(p.strong).toBe(false)
	})

	it('should have nothing to say on a first ever slot, rather than invent one', () => {
		expect(predict({ tabs: [] }).text).toBe('')
	})

	it('should not call one tab a desk', () => {
		expect(deskKey([tab('LEAP-19 only')])).toBeNull()
		expect(deskKey([tab('LEAP-19 a'), tab('LEAP-19 b')])).toBe('LEAP-19')
	})
})

describe('the model rung', () => {
	it('should forbid invention in the instructions, as everywhere else', () => {
		const p = predictPrompt({ tabs: [tab('LEAP-19 pull request')] }, ['webhook retry'])
		expect(p).toContain('LEAP-19 pull request')
		expect(p).toContain('webhook retry')
	})

	it('should leave out a section it has nothing for', () => {
		expect(predictPrompt({ tabs: [] }, [])).toBe('')
	})

	it('should strip the preface models add instead of rejecting the answer', () => {
		expect(usablePrediction('Suggestion: fixed the retry')).toBe('fixed the retry')
		expect(usablePrediction('"fixed the retry"')).toBe('fixed the retry')
	})

	it('should refuse anything that is not a log line', () => {
		expect(usablePrediction('')).toBeNull()
		expect(usablePrediction('x')).toBeNull()
		expect(usablePrediction('y'.repeat(200))).toBeNull()
	})

	it('should take only the first line when it rambles', () => {
		expect(usablePrediction('fixed the retry\nAlso, I think you should...')).toBe('fixed the retry')
	})
})

describe('the streak, which must never become a scold', () => {
	const e = (date: string, minutes = 60) => ({ date, minutes, kind: 'work' })

	it('should count what was captured, never what was missed', () => {
		const got = captured([e('2026-10-14'), e('2026-10-14'), e('2026-10-15')], ['2026-10-14', '2026-10-15'])
		expect(got.hours).toBe(3)
		expect(got.line).toContain('3 hours captured this week')
	})

	it('should stay silent until there is something worth saying', () => {
		expect(captured([e('2026-10-15', 30)], ['2026-10-15']).line).toBeNull()
	})

	it('should mention a run only once it is actually a run', () => {
		const days = ['2026-10-13', '2026-10-14', '2026-10-15']
		expect(captured(days.map((d) => e(d, 120)), days).line).toContain('3 days running')
		expect(captured([e('2026-10-15', 180)], ['2026-10-15']).line).not.toContain('running')
	})

	it('should break the run on a day with nothing, without saying so', () => {
		const days = ['2026-10-13', '2026-10-14', '2026-10-15']
		const got = captured([e('2026-10-13', 120), e('2026-10-15', 120)], days)
		expect(got.days).toBe(1)
		expect(got.line).not.toContain('missed')
	})
})

describe('when not to ask at all', () => {
	it('should never land on a presentation', () => {
		expect(badMoment({ fullscreen: true })).toContain('presentation')
	})

	it('should never land in front of other people on a call', () => {
		expect(badMoment({ activeUrl: 'https://meet.google.com/abc-defg' })).toBe('on a call')
		expect(badMoment({ activeUrl: 'https://zoom.us/j/123' })).toBe('on a call')
	})

	it('should not mistake a page that merely mentions a call host', () => {
		expect(badMoment({ activeUrl: 'https://blog.example.com/zoom.us-review' })).toBeNull()
	})

	it('should leave an ordinary moment alone', () => {
		expect(badMoment({ activeUrl: 'https://github.com/acme/api' })).toBeNull()
		expect(badMoment({})).toBeNull()
	})
})

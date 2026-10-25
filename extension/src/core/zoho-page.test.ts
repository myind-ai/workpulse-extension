import { beforeEach, describe, expect, it } from 'vitest'

import { parseIst } from './time'
import { allProjects, classifyRequest, datedForm, datedUrl, readAttendance, readJobList, readJobs, readJson, readProjects, savedTimelog, timeOn, timesheetBody, usable, valueFor, withProject, writeLooking } from './zoho-page'

// Three shapes Zoho's attendance widgets come in: label and value in one node,
// value in the next node, and value elsewhere under a shared wrapper.
beforeEach(() => {
	document.body.innerHTML = `
	<div class="widget">
		<div class="tile"><span>First In</span><span class="v">09:12 AM</span></div>
		<div class="tile"><label>Last Out</label><div><div class="v">06:45 PM</div></div></div>
		<div class="tile">Total Hours 09:33</div>
		<div class="tile"><span>Shift Name</span><span>General</span></div>
	</div>`
})

describe('reading your own attendance off the page', () => {
	it('should find values beside, under and inside the label', () => {
		expect(valueFor(/first\s*in\b/i)).toBe('09:12 AM')
		expect(valueFor(/last\s*out\b/i)).toBe('06:45 PM')
		expect(valueFor(/total\s*(hours|hrs)\b/i)).toBe('09:33')
	})

	it('should report every value it found', () => {
		expect(readAttendance()).toEqual({ firstIn: '09:12 AM', lastOut: '06:45 PM', totalHours: '09:33', missing: [] })
	})

	it('should name what it could not find instead of guessing', () => {
		document.body.innerHTML = '<div><span>First In</span><span>09:12 AM</span></div>'
		const a = readAttendance()
		expect(a.firstIn).toBe('09:12 AM')
		expect(a.missing).toEqual(['Last Out', 'Total Hours'])
	})

	it('should ignore a label with no time next to it', () => {
		document.body.innerHTML = '<div><span>First In</span><span>-</span></div>'
		expect(readAttendance().firstIn).toBeNull()
	})

	it('should count a read as usable only once a check-in is on the page', () => {
		expect(usable(readAttendance())).toBe(true)
		expect(usable({ firstIn: null, lastOut: null, totalHours: '00:00', missing: [] })).toBe(false)
		expect(usable(null)).toBe(false)
	})
})

describe('turning a page clock time into an instant', () => {
	it('should read 12-hour and 24-hour times against the given day', () => {
		expect(timeOn('2026-10-12', '09:12 AM')).toBe(parseIst('2026-10-12T09:12:00'))
		expect(timeOn('2026-10-12', '6:45 PM')).toBe(parseIst('2026-10-12T18:45:00'))
		expect(timeOn('2026-10-12', '12:30 AM')).toBe(parseIst('2026-10-12T00:30:00'))
		expect(timeOn('2026-10-12', '12:30 PM')).toBe(parseIst('2026-10-12T12:30:00'))
		expect(timeOn('2026-10-12', '18:40:05')).toBe(parseIst('2026-10-12T18:40:00'))
	})

	it('should still accept the full date-times the API returns', () => {
		expect(timeOn('2026-10-12', '12-10-2026 09:12:05')).toBe(parseIst('2026-10-12T09:12:05'))
	})

	it('should refuse nonsense rather than invent a time', () => {
		expect(timeOn('2026-10-12', '-')).toBeNull()
		expect(timeOn('2026-10-12', null)).toBeNull()
		expect(timeOn('2026-10-12', '27:99')).toBeNull()
	})
})

describe('reading an internal endpoint reply', () => {
	it('should find the documented field names at any depth', () => {
		const reply = { response: { result: { firstIn: '12-10-2026 09:12:05', lastOut: '-', totalHrs: '03:10' } } }
		expect(readJson(reply, '2026-10-12')).toEqual({ firstIn: '12-10-2026 09:12:05', lastOut: null, totalHours: '03:10', missing: ['Last Out'] })
	})

	it('should answer for today when the reply is keyed by date', () => {
		const reply = {
			'11-10-2026': { Status: 'Present', FirstIn: '11-Oct-2026 08:00 AM', LastOut: '11-Oct-2026 05:00 PM', TotalHours: '09:00' },
			'12-10-2026': { Status: 'Present', FirstIn: '12-Oct-2026 09:12 AM', LastOut: '', TotalHours: '03:10' },
		}
		const a = readJson(reply, '2026-10-12')
		expect(a.firstIn).toBe('12-Oct-2026 09:12 AM')
		expect(a.lastOut).toBeNull()
	})

	it('should report everything missing for a reply that holds no attendance', () => {
		expect(readJson({ response: { message: 'no data', status: 0 } }, '2026-10-12').missing).toHaveLength(3)
		expect(readJson(null, '2026-10-12').firstIn).toBeNull()
	})
})

describe('reusing a captured endpoint on later days', () => {
	it('should rewrite each date-looking query value in its own layout', () => {
		const url = 'https://people.zoho.in/people/zp/attendance?date=05-10-2026&sdate=2026-10-05&edate=05/10/2026&from=05-Oct-2026&zpid=7'
		const out = new URL(datedUrl(url, '2026-10-12'))
		expect(out.searchParams.get('date')).toBe('12-10-2026')
		expect(out.searchParams.get('sdate')).toBe('2026-10-12')
		expect(out.searchParams.get('edate')).toBe('12/10/2026')
		expect(out.searchParams.get('from')).toBe('12-Oct-2026')
		expect(out.searchParams.get('zpid')).toBe('7') // not a date: left alone
	})

	it('should leave epochs and unparseable urls alone', () => {
		expect(datedUrl('https://people.zoho.in/x?t=1791776520000', '2026-10-12')).toContain('t=1791776520000')
		expect(datedUrl('not a url', '2026-10-12')).toBe('not a url')
	})
})

// The real list captured from Zoho People's own web app.
const CAPTURED = [
	'POST https://people.zoho.in/logiciel/timesheet.zp',
	'POST https://people.zoho.in/logiciel/timesheetDispAction.zp',
	'POST https://people.zoho.in/logiciel/formAction.zp',
	'POST https://people.zoho.in/logiciel/commonAction/getWeekendDefinition',
	'POST https://people.zoho.in/logiciel/gettabdetails/initpage',
	'POST https://people.zoho.in/logiciel/AttendanceAction.zp',
	'POST https://people.zoho.in/logiciel/commonAction/getUserStatus',
]

describe('never replaying a write', () => {
	it('should refuse the punch endpoints', () => {
		expect(writeLooking('https://people.zoho.in/logiciel/AttendanceAction.zp?mode=punchIn')).toBeTruthy()
		expect(writeLooking('https://people.zoho.in/logiciel/AttendanceAction.zp?mode=punchOut')).toBeTruthy()
	})

	it('should refuse a punch hidden in the body', () => {
		expect(writeLooking('https://people.zoho.in/logiciel/AttendanceAction.zp', 'mode=punchIn&date=12-10-2026')).toBeTruthy()
		expect(writeLooking('https://people.zoho.in/logiciel/formAction.zp', 'action=save&formLinkName=attendance')).toBeTruthy()
	})

	it('should allow the read endpoints from the capture', () => {
		for (const line of CAPTURED) {
			const [, url] = line.split(' ')
			expect(writeLooking(url), url).toBeNull()
		}
	})
})

describe('replaying a form-encoded POST on a later day', () => {
	it('should rewrite dates in the body, in their own layout', () => {
		expect(datedForm('mode=getData&date=05-10-2026&sdate=2026-10-05', '2026-10-12')).toBe('mode=getData&date=12-10-2026&sdate=2026-10-12')
	})

	it('should leave a json body and an empty body alone', () => {
		expect(datedForm('{"date":"05-10-2026"}', '2026-10-12')).toBe('{"date":"05-10-2026"}')
		expect(datedForm(undefined, '2026-10-12')).toBeUndefined()
	})
})

// Captured from Zoho People's own web app, 2026-10-12. Tokens redacted.
describe('the captured internal endpoints', () => {
	const CSR = 'conreqcsr=REDACTED'
	const reads: [string, string, string][] = [
		['attendance status', 'https://people.zoho.in/logiciel/AttendanceAction.zp', `mode=getStatus&${CSR}`],
		['user status', 'https://people.zoho.in/logiciel/commonAction/getUserStatus', ''],
		['projects', 'https://people.zoho.in/logiciel/timetracker/projects', `mode=getTimesheetProjectList&projectStatus=0&${CSR}&sIndex=0&limit=24`],
		['jobs', 'https://people.zoho.in/logiciel/timesheet.zp', `mode=getJobs&erecno=ID&getCurUserJobs=true&jobStatus=0&${CSR}&limit=25`],
		['weekend definition', 'https://people.zoho.in/logiciel/commonAction/getWeekendDefinition', ''],
	]
	const writes: [string, string, string][] = [
		['punch in', 'https://people.zoho.in/logiciel/AttendanceAction.zp?mode=punchIn', 'urlMode=myspace&latitude=20.7&longitude=76.5'],
		['punch out', 'https://people.zoho.in/logiciel/AttendanceAction.zp?mode=punchOut', 'urlMode=myspace&latitude=20.7&longitude=76.5'],
		['timesheet save', 'https://people.zoho.in/logiciel/addUpdateRecord.zp', `zp_tableName=P_Timesheet&zp_mode=addRecord&loggedHrs=03%3A00&${CSR}`],
	]

	it.each(reads)('should let the reader replay the %s call', (_name, url, body) => {
		expect(writeLooking(url, body)).toBeNull()
	})

	it.each(writes)('should block the %s call', (_name, url, body) => {
		expect(writeLooking(url, body)).toBeTruthy()
	})

	it('should keep a replayed read on today, token and ids untouched', () => {
		const body = datedForm('mode=getJobs&erecno=ID&Date=09-10-2026&conreqcsr=TOKEN', '2026-10-12')
		expect(body).toContain('Date=12-10-2026')
		expect(body).toContain('conreqcsr=TOKEN')
		expect(body).toContain('erecno=ID')
	})
})

describe('the project and task catalogue', () => {
	it('should read projects and jobs out of whatever wrapper Zoho used', () => {
		const projects = { response: { result: [{ projectId: '68447000007024272', projectName: 'LeapPay', clientName: 'Internal' }] } }
		expect(readProjects(projects)).toEqual([{ id: '68447000007024272', name: 'LeapPay' }])

		const jobs = { result: { jobs: [{ jobId: '68447000008734366', jobName: 'PAY-2952', projectName: 'LeapPay' }, { jobId: '2', jobName: 'Code review' }] } }
		expect(readJobs(jobs)).toEqual([
			{ id: '68447000008734366', name: 'PAY-2952' },
			{ id: '2', name: 'Code review' },
		])
	})

	it('should skip entries with no name and never repeat an id', () => {
		expect(readJobs({ r: [{ jobId: '1' }, { jobId: '1', jobName: 'A' }, { jobId: '1', jobName: 'A again' }] })).toEqual([{ id: '1', name: 'A' }])
	})

	it('should tell the recorded calls apart by their mode', () => {
		const c = classifyRequest
		expect(c('https://people.zoho.in/logiciel/AttendanceAction.zp', 'mode=getStatus&conreqcsr=x')).toBe('attendance')
		expect(c('https://people.zoho.in/logiciel/timetracker/projects', 'mode=getTimesheetProjectList&limit=24')).toBe('projects')
		expect(c('https://people.zoho.in/logiciel/timesheet.zp', 'mode=getJobs&projectId=7')).toBe('jobs')
		expect(c('https://people.zoho.in/logiciel/timesheetDispAction.zp', 'mode=getTimesheet&fromDate=11-10-2026')).toBe('timesheet')
		expect(c('https://people.zoho.in/logiciel/AttendanceAction.zp?mode=punchIn', 'urlMode=myspace')).toBeNull()
		expect(c('https://people.zoho.in/logiciel/addUpdateRecord.zp', 'zp_mode=addRecord&zp_tableName=P_Timesheet')).toBeNull()
		expect(c('https://people.zoho.in/_chat/useractive.do')).toBeNull()
	})

	it('should ask the jobs call about another project', () => {
		const body = 'mode=getJobs&erecno=ID&projectId=68447000007024272&limit=25'
		expect(withProject(body, '999')).toBe('mode=getJobs&erecno=ID&projectId=999&limit=25')
		expect(withProject('mode=getJobs&erecno=ID', '999')).toBe('mode=getJobs&erecno=ID') // nothing to swap
	})
})

describe('molding a captured timesheet save into ours', () => {
	// The real capture, with the ids that identify the org and the person.
	const TEMPLATE =
		'isPicklistIdEnabled=true&Work_Item=Work+on+PAY-2952&Date=09-10-2026&Attachment=&zp_tableName=P_Timesheet&loginUserZUID=ZUID&conreqcsr=TOKEN' +
		'&zp_formId=FORM&zp_mode=addRecord&isFromNewUI=true&JobId=JOB&Project=PROJ&Billable_Status=0&User_Name=EREC&timelogtype=0&loggedHrs=03%3A00&Description=&isDraft=false'

	const row = { date: '2026-10-12', minutes: 95, workItem: 'PAY-3001', description: 'Webhook retries; code review', jobId: 'JOB2', projectId: 'PROJ2' }

	it('should replace what describes the work and keep what identifies you', () => {
		const out = new URLSearchParams(timesheetBody(TEMPLATE, row)!)
		expect(out.get('Date')).toBe('12-10-2026')
		expect(out.get('loggedHrs')).toBe('01:35') // 95 minutes exactly, not 1.58 hours
		expect(out.get('Work_Item')).toBe('PAY-3001')
		expect(out.get('Description')).toBe('Webhook retries; code review')
		expect(out.get('JobId')).toBe('JOB2')
		expect(out.get('Project')).toBe('PROJ2')
		// kept from the capture
		expect(out.get('zp_formId')).toBe('FORM')
		expect(out.get('User_Name')).toBe('EREC')
		expect(out.get('loginUserZUID')).toBe('ZUID')
		expect(out.get('zp_tableName')).toBe('P_Timesheet')
		expect(out.get('timelogtype')).toBe('0')
		expect(out.get('isFromNewUI')).toBe('true')
	})

	it('should keep the captured billable status until we are told the mapping', () => {
		expect(new URLSearchParams(timesheetBody(TEMPLATE, row)!).get('Billable_Status')).toBe('0')
		expect(new URLSearchParams(timesheetBody(TEMPLATE, { ...row, billableStatus: '1' })!).get('Billable_Status')).toBe('1')
	})

	it('should never save a draft, which would not count towards your hours', () => {
		const draft = TEMPLATE.replace('isDraft=false', 'isDraft=true')
		expect(new URLSearchParams(timesheetBody(draft, row)!).get('isDraft')).toBe('false')
	})

	it('should refuse anything that is not a timesheet save', () => {
		expect(timesheetBody('mode=getStatus&conreqcsr=TOKEN', row)).toBeNull()
		expect(timesheetBody(TEMPLATE.replace('P_Timesheet', 'P_Leave'), row)).toBeNull()
		expect(timesheetBody(TEMPLATE.replace('zp_mode=addRecord', 'zp_mode=deleteRecord'), row)).toBeNull()
		expect(timesheetBody(undefined, row)).toBeNull()
	})

	it('should round minutes to the clock Zoho expects', () => {
		const hrs = (minutes: number) => new URLSearchParams(timesheetBody(TEMPLATE, { ...row, minutes })!).get('loggedHrs')
		expect(hrs(50)).toBe('00:50') // the decimal path would have sent 0.83
		expect(hrs(60)).toBe('01:00')
		expect(hrs(480)).toBe('08:00')
		expect(hrs(0)).toBe('00:00')
	})
})

describe('one call for every job', () => {
	it('should pair each job with its project from a single reply', () => {
		const reply = {
			response: {
				result: [
					{ jobId: '1', jobName: 'PAY-2952', projectName: 'LeapPay', clientName: 'Internal' },
					{ jobId: '2', jobName: 'Code review', projectName: 'LeapPay' },
					{ jobId: '3', jobName: 'Onboarding', projectName: 'HR Tools' },
				],
			},
		}
		expect(readJobList(reply)).toEqual([
			{ id: '1', name: 'PAY-2952', project: 'LeapPay' },
			{ id: '2', name: 'Code review', project: 'LeapPay' },
			{ id: '3', name: 'Onboarding', project: 'HR Tools' },
		])
	})

	it('should leave the project blank rather than invent one', () => {
		expect(readJobList({ r: [{ jobId: '9', jobName: 'Loose job' }] })).toEqual([{ id: '9', name: 'Loose job', project: '' }])
	})

	it('should ask the captured call for every project at once', () => {
		const body = 'mode=getJobs&erecno=ID&projectId=68447000007024272&jobStatus=0&limit=24'
		const out = new URLSearchParams(allProjects(body)!)
		expect(out.get('projectId')).toBe('0')
		expect(out.get('getCurUserJobs')).toBe('true')
		expect(out.get('erecno')).toBe('ID')
	})
})

describe('whether Zoho accepted a timesheet row', () => {
	it('should accept its own success code', () => {
		expect(savedTimelog(200, '{"pkId":"68447000014521402","code":7000,"message":"Successfully Added"}')).toEqual({ ok: true })
	})

	it('should refuse any other code, and pass on what Zoho said', () => {
		// The dangerous case: 200 OK with a refusal inside it.
		expect(savedTimelog(200, '{"code":7003,"message":"Time log exceeds the allowed hours"}')).toEqual({ ok: false, message: 'Time log exceeds the allowed hours' })
	})

	it('should refuse a bad status whatever the body says', () => {
		expect(savedTimelog(400, '{"code":7000}')).toMatchObject({ ok: false, message: 'HTTP 400' })
	})

	it('should read a message with no code', () => {
		expect(savedTimelog(200, '{"message":"Successfully updated"}')).toEqual({ ok: true, message: 'Successfully updated' })
		expect(savedTimelog(200, '{"message":"Invalid form"}')).toEqual({ ok: false, message: 'Invalid form' })
	})

	it('should fall back to reading prose when the answer is not JSON', () => {
		expect(savedTimelog(200, '<html><body>Session expired</body></html>').ok).toBe(true) // nothing refusing in it
		expect(savedTimelog(200, '<html>Invalid CSRF token</html>')).toMatchObject({ ok: false })
		expect(savedTimelog(200, '')).toEqual({ ok: true })
	})
})

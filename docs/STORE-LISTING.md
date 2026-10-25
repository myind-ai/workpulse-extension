# Chrome Web Store listing — copy and answers

Updated: 2026-10-25 (v1.1.0: Tick, Brain, GitHub backup disclosed)
Paste-ready text for the submission form. Keep it truthful: review rejects overstatement, and
users punish it harder. Related: [PRIVACY.md](PRIVACY.md) · public source https://github.com/myind-ai/workpulse-extension

## Name
```text
WorkPulse — hourly work log for Zoho People
```

## Summary (132 characters max)
```text
Hourly reminders that keep your Zoho People timesheet and attendance complete, written while you still remember the work.
```
(121 characters)

## Category
Workflow & Planning

## Single purpose (required)
```text
WorkPulse keeps a record of your workday as it happens: it reminds you to check in, asks what you worked on each hour, and turns those answers into your Zoho People timesheet, your notes and your learnings.
```

## Detailed description

```text
You do the work. The record of it goes missing.

You forget to check in. You work three hours and write nothing down. On Friday you stare at an empty timesheet trying to remember Tuesday. Then a day turns up with no check-out and someone from HR asks about it.

WorkPulse fixes the one thing that causes all of it: the record is made later, from memory.

HOW IT WORKS
• A check-in reminder that follows you across tabs until you answer it, and clears itself if Zoho already shows you checked in.
• An hourly card for the hour you just worked, with your real Zoho projects and tasks, the last thing you wrote, and the time it noticed you were away from the computer.
• One number that matters: how much of your day is not written down yet.
• At the end of the day, your entries grouped by job: send them to Zoho, or copy them into Zoho's timesheet grid.
• Days that need regularising, named, with the reason written for you from what you actually logged.
• Breaks that are off until you want them: look away, stand up, water, posture, a minute of slow breathing, with Tick the cat on each card.
• Tickets and their links, learnings and mistakes, notes on pages, and a weekly report.

WORKS WITHOUT API ACCESS
Most Zoho roles are refused API access. WorkPulse does not need it: it works from the Zoho People tab you are already signed in to. No admin approval, no account to create.

YOUR DATA STAYS YOURS
No WorkPulse account, no server, no analytics. Everything lives in your browser. If you choose to, it can back up to a private GitHub repository you own, and share a "Brain" there with the open-source wp-brain command-line tool (for example with Claude Code). Nothing is sent anywhere until you set that up.

Open source: https://github.com/myind-ai/workpulse-extension
```

## Permission justifications

| Permission | Paste into the form |
|---|---|
| Host access to all sites | The reminder card is drawn over whatever page you are reading, so it cannot be missed, and Tick's clips are shown on it. The page's content is never read, stored or transmitted. |
| Zoho hosts (`*.zoho.in/com/eu/com.au`) | Reading your attendance and sending your time logs from your own signed-in Zoho People tab. |
| `127.0.0.1` / `localhost` | Talking to the optional WorkPulse desktop app, and to a local AI model (Ollama, LM Studio) if the user picks one. |
| `tabs` | Finding your Zoho People tab, and prefilling a saved link with the page you are on. |
| `scripting` | Placing the reminder card on the current page, and running the reader on your Zoho tab so requests carry your own session. |
| `storage`, `unlimitedStorage` | Your settings, entries, tasks and notes, stored locally. |
| `alarms`, `idle` | The once-a-minute scheduler, and noticing when you are away so breaks are not logged as work. |
| `notifications` | Check-in, reminder and regularisation alerts. |
| `offscreen` | Playing the reminder chime; a service worker cannot play audio. |
| `contextMenus` | Right-click "note this page…" and converting a selected time into your time zone. |
| `webRequest` (optional) | Requested only when you press "Set it up for me": observes which addresses Zoho's own pages request, scoped to `*.zoho.*`, blocks nothing, stops after ten minutes. |
| `tabGroups` (optional) | Reopening a saved ticket's links as one named tab group, when you ask. |
| `history` (optional) | Suggesting what you worked on in an hour you cannot remember, from that hour's pages only; never saved unless accepted, never sent. |
| `desktopCapture` (optional) | Recording a short screen clip for a page note, only when you press record. |

**Remote code:** No. All code is in the package. Tick's clips are packaged files (`art/*.webm`, `art/*.webp`).

## Data use declarations

- Personally identifiable information: **No**, not collected or transmitted by us. (Your Zoho email is stored
  locally so requests can be addressed to you.)
- Authentication information: **No**, not collected by us. (A GitHub token the user chooses to enter is stored
  locally and sent only to api.github.com, to the user's own repository.)
- Health, financial, personal communications, location, web history, user activity, website content: **No**,
  not collected or transmitted by us.
- Sold to third parties: **No**. Used for purposes unrelated to the single purpose: **No**. Used to determine
  creditworthiness: **No**.

## Privacy policy URL
```text
https://github.com/myind-ai/workpulse-extension/blob/main/docs/PRIVACY.md
```

## Assets

| Asset | Where |
|---|---|
| Package | `cd extension && npm run release:store` → `extension/.output/store/workpulse-extension-1.1.0-chrome.zip` (no signing key; the Store issues the id) |
| Icon 128×128 | In the package (`icon/128.png`) |
| Screenshots 1280×800 | `docs/store/screenshots/*.png` (5, cropped from the stand-in demo; no personal data) |

## Before you submit (you)

- [ ] Developer account: one-time US$5 registration, two-factor authentication on
- [ ] Upload the zip, paste the text above, add the screenshots
- [ ] Privacy policy URL above opens (public repository)
- [ ] Choose visibility: Unlisted first, Public after a week of your own use

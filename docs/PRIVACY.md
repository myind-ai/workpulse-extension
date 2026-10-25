# WorkPulse — privacy policy

**Last updated:** 25 October 2026 · Applies to the WorkPulse Chrome extension, v1.1.0

## The short version

WorkPulse stores everything on your own computer and sends nothing to us. There is no WorkPulse
account, no WorkPulse server, and no analytics. The only network requests it makes are to **your
own Zoho People site**, from the tab you are already signed in to, and, **only if you set it up**,
to **a GitHub repository you own**, with a token you create (see "Your GitHub repository" below).

## What is stored, and where

Everything below lives in your browser's extension storage (`chrome.storage.local`), on this
computer and this Chrome profile only:

| Data | Why |
|---|---|
| Your shift, work days, prompt interval, minimum hours | To know when to remind you |
| What you wrote in each hourly entry, with its times and job | To build your timesheet |
| Your check-in and check-out times | To know whether reminders are owed |
| Tasks, reminders, and links you saved | To bring them back when you asked |
| The Zoho requests you captured or pasted | To read your attendance and send your time logs |
| Your Zoho email and data centre | To address those requests to the right person |

It is never uploaded to us. Clearing the extension's data, or removing the extension, deletes all of it.
**Settings → Advanced → Save a backup** writes it to a file you control.

## Your GitHub repository (optional, off until you set it up)

In **Settings → Backup** you can connect a GitHub repository you own, with a fine-grained token you
create (Contents: Read and write, on that one repository). When you do:

- A **daily backup** of your learnings, tickets, notes and time logs is committed to that repository,
  under a folder you choose (`workpulse/` by default).
- The **Brain** reads and writes a `bridge/` folder in the same repository: entries you add, entries the
  optional `wp-brain` command-line tool writes, and requests you send it. It checks for changes every
  15 minutes, and every minute while the Brain page is open.
- Requests go only to `api.github.com`. The token is stored in this browser's extension storage, is never
  exported or written into a backup, and is sent only to GitHub.
- Anything that looks like a credential (API keys, tokens, private keys) is refused before it is written.

Nothing reaches GitHub unless you connect a repository. Disconnecting stops it; deleting the repository on
GitHub deletes what was written there.

## What is never collected

- Your browsing history. WorkPulse does not read, store or transmit the pages you visit.
- Passwords or session cookies. The reader runs on your Zoho tab, so your Zoho session stays in
  the browser and never passes through WorkPulse. Cookies in a pasted cURL command are discarded
  by the parser before anything is stored.
- Keystrokes, screenshots, screen recordings, location (except when you press "Check in now" in
  Full mode, where the browser's current location is attached to that one Zoho punch, exactly as
  Zoho's own page does — and omitted entirely if you decline).
- Anything about your colleagues.

## Permissions, and why each exists

| Permission | What it is for |
|---|---|
| `storage`, `unlimitedStorage` | Keeping your settings and entries on this computer |
| `alarms`, `idle` | Running the once-a-minute scheduler, and noticing when you are away so a break is not logged as work |
| `notifications` | Telling you about a check-in, a reminder or a day that needs regularising |
| `offscreen` | Playing the reminder chime, which a Chrome service worker cannot do |
| `tabs` | Finding your Zoho tab, and prefilling a saved link with the page you are on |
| `scripting` + access to all sites | Showing the reminder card on whatever page you are reading, and running the reader on your Zoho tab. The card is drawn on the page; the page's content is not read or sent anywhere |
| `contextMenus` | The right-click items "note this page…" and "“selected time” in my time" (time-zone conversion) |
| `webRequest` *(optional)* | Only while you run the automatic setup: it watches which addresses Zoho's own pages ask for, so WorkPulse can use the same ones. It is requested when you press that button, never at install, it observes only `*.zoho.*` addresses, blocks nothing, and stops by itself after ten minutes |
| `tabGroups` *(optional)* | Reopening a saved ticket's links as one named Chrome tab group, when you ask |
| `history` *(optional)* | Suggesting what you worked on in an hour you cannot remember, from the pages open in that hour only; read on this computer, shown as suggestions, never saved unless you accept one, never sent |
| `desktopCapture` *(optional)* | Recording a short screen clip for a page note, only when you press record |
| Access to `127.0.0.1` / `localhost` | Talking to the optional WorkPulse desktop app, and to a local AI model (Ollama, LM Studio) if you choose one |

## Zoho

WorkPulse acts as you, in your browser, against your own Zoho People account — the same requests
Zoho's own pages make when you click. It reads your attendance and your projects; it writes only
when you click **Check in**, **Check out** or **Push**, and it never punches or submits on a timer.

## Changes

Material changes will be noted here with a new date, and in the extension's release notes.

## Contact

Questions or a data request: open an issue at https://github.com/myind-ai/workpulse-extension/issues.

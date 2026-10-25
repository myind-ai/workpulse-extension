---
name: workpulse-brain
description: Keep a running memory of every ticket, bug, debugging session, report, skill and side project in the WorkPulse bridge (a private GitHub repo the WorkPulse browser extension reads too). Read the brief BEFORE starting a ticket; write what was asked, done, broken and learned AFTER. Triggers on "start ticket", "working on PAY-123", "what did I learn about", "log this mistake", "record the root cause", "end of ticket", "write it to my brain", "weekly report", "what did I do this week", "side project log", "check the workpulse inbox", "wp-brain".
---

# WorkPulse Brain

One private GitHub repository holds a `bridge/` folder that both the WorkPulse extension (Brain page) and this skill read and write.
Each device writes only its own file, so nothing conflicts. The tool is `wp-brain` (`cli/wp-brain.mjs` in the WorkPulse repo, Node ≥ 22.18).

```bash
WP=~/path/to/workpulse-extension/cli/wp-brain.mjs   # set to your checkout
node $WP help
```

First time on a machine (once): `node $WP init owner/repo [--branch brain]`, using the same repository and branch
set in the extension's Settings → Backup (set the Branch there **before** picking the repository). If
`~/.config/workpulse/brain.json` exists, it is already done.

## Before starting a ticket or a side-project task

1. Find the key: from the branch (`git branch --show-current` → `fix/pay-2433-…` → `PAY-2433`), the user's message, or the project name for personal work.
2. Run the brief and **read it before planning**:

```bash
node $WP brief PAY-2433 --project acme/payments-web
```

It shows earlier entries for that ticket and its related ones, the mistakes that keep coming back (30 days),
open follow-ups, and requests the user sent from the extension's inbox. Say in one line what you are taking from it.
If an inbox item is handled, acknowledge it: `node $WP inbox --ack <id>`.

## While working

Record the moment it happens, not at the end, when one of these occurs:

| It happened | Command |
|---|---|
| A wrong assumption or a fix that did not work | `node $WP add mistake "what went wrong #tag" --ticket K --root-cause "why"` |
| A bug was diagnosed | `node $WP add debug "symptom" --ticket K --root-cause "cause" --body "fix and the command that proved it"` |
| Something reusable was learned | `node $WP add learning "the lesson #tag"` |
| A new skill/tool was set up | `node $WP add skill "what, and where the notes are"` |

Use `--scope personal --project <name>` for side projects outside work.

## At the end of a ticket (or session)

Write one `ticket` entry plus the mistakes and learnings, as one JSON array, in one commit:

```bash
node $WP add --json - <<'JSON'
[
  { "kind": "ticket", "title": "Financing button double-submits", "ticket": "PAY-2433", "project": "acme/payments-web",
    "asked": "Stop the double submit on slow networks", "done": "Button disabled while pending; server rejects a repeated idempotency key; 3 tests",
    "rootCause": "No in-flight guard and no server idempotency", "status": "done",
    "next": ["Watch stage for duplicate charges for 48 h"],
    "links": { "pr": "https://github.com/acme/payments-web/pull/812", "commits": ["a1b2c3d"], "related": ["PAY-2390"] } },
  { "kind": "mistake", "title": "Patched the click handler; Enter also submits #forms", "ticket": "PAY-2433", "rootCause": "Fixed only the path I reproduced" },
  { "kind": "learning", "title": "Guard at the server; a disabled button is UX, not a guarantee #idempotency", "ticket": "PAY-2433" }
]
JSON
```

Rules:

- **Honest status**: `done` only if verified (tests, build, live check). Otherwise `in progress` or `blocked`, with `next`.
- **Short and specific**: titles are one line; the body holds commands, error text and the fix.
- **Never secrets**: the tool refuses anything token-shaped, but also leave out customer data, passwords and full logs.
- Pushing to this private notes repo is the skill's purpose; it is the one push that needs no extra ask once the user has run `init`.

## Reports

```bash
node $WP report --days 7               # week, Markdown on stdout
node $WP report --days 30 --scope personal
node $WP list --kind mistake --query forms
```

## Gotchas

| Symptom | Fix |
|---|---|
| `wp-brain needs Node 22.18 or newer` | `nvm use 24`; the CLI loads the extension's TypeScript directly |
| `Not set up. Run: wp-brain init` | Config lives at `~/.config/workpulse/brain.json` (override with `WP_BRAIN_CONFIG`) |
| `Committed locally but could not push` | `node $WP sync`; check `gh auth status` |
| Extension does not show new entries | Brain page → **Sync now** (it also polls every minute while open, every 15 min otherwise) |
| Extension says "Connect a repository first" | Settings → Backup needs the repo and a fine-grained token with Contents: Read and write |
| Two quick saves from the extension, one is missing | GitHub sends Cache-Control max-age=60; a cached read before an append drops a line. lib/github.ts sends every call with cache: no-store; keep it that way |
| Save from the Brain page spins for a while on first setup | It queues behind the daily backup, which runs the first time a repository is set after 19:00. Wait; it completes |

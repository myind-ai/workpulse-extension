---
name: workpulse-brain
description: Keep a running memory of every ticket, bug, debugging session, report, skill and side project in the WorkPulse bridge (a private GitHub repo the WorkPulse browser extension reads too). Read the brief BEFORE starting a ticket; write what was asked, done, broken and learned AFTER. Triggers on "start ticket", "working on PAY-123", "what did I learn about", "log this mistake", "record the root cause", "end of ticket", "write it to my brain", "weekly report", "what did I do this week", "side project log", "check the workpulse inbox", "wp-brain", "update the workpulse extension", "save it in learning", "save it as a learning", "save this in my learnings", "add to my learnings", "remember this", "note this down for later", "log a learning", "edit that learning", "archive that learning", "delete that learning", "show my learnings".
---

# WorkPulse Brain

One private GitHub repository holds a `bridge/` folder that both the WorkPulse extension (Brain page) and this skill read and write.
Each device writes only its own file, so nothing conflicts. The tool is `wp-brain` (`cli/wp-brain.mjs` in the WorkPulse repo, Node ≥ 22.18).

In the browser the same Brain shows up where the work is: on a Jira ticket, pull request, staging or localhost
page the extension shows what was recorded for it (next action, root cause), and the palette's **Save context**
(`+`) and **This page** modes write and list entries for that page.

Every entry also gets a readable Markdown record under `bridge/records/<device>/YYYY-MM/`, written once by the device that wrote the entry (so every file keeps one writer). Its filename comes from the ticket and title; its front matter carries subtitle, type, scope, device, tags, status and links; its body uses headings such as **Summary**, **Done**, **Root cause**, and **Next action**. JSONL remains the sync source. Entry kinds include `decision` and `handover` as well as ticket, learning, mistake, debug, report, code, skill, note.

```bash
WP="${CLAUDE_PLUGIN_ROOT}/cli/wp-brain.mjs"                        # installed as a Claude Code plugin
[ -f "$WP" ] || WP="${WP_CLI:-$HOME/workpulse-extension/cli/wp-brain.mjs}"   # installed by install.sh (or set WP_CLI)
node "$WP" help
```

How to connect everything: `docs/guides/connect-extension-and-claude-code.md` in this repo.

## Setup — check first, then ask, never assume

Run `node $WP doctor` the first time this skill is used in a session (it is fast and changes nothing).
If it reports **Config missing**, or the SessionStart context says the plugin "is installed but not linked",
or the user asks to set up / re-link / change the Brain, **ask before doing anything**, with **one** question
(AskUserQuestion):

| Question | Options (first is recommended) |
|---|---|
| Where should the Brain live? | **A new private repo `<gh login>/workpulse-notes`** (the extension's default) · An existing private repo (name it) · Not now |

Always use branch **`brain`**: it is the extension's default from 1.6.0, so the two sides match with nothing to
type. The machine's name defaults to `cli-<hostname>`; say it in the result, and change it only if asked.

Get `<gh login>` with `gh api user --jq .login`. If `gh` is missing or not signed in, say so and stop: the
user runs `! gh auth login` (an interactive login), then ask again.

**Installed as a plugin** (`$CLAUDE_PLUGIN_ROOT` is set in the path above): the hooks already come from the
plugin, so nothing in `~/.claude` needs editing. Link it yourself — this only writes `~/.config/workpulse/`
and `~/.workpulse/`, and creates the repository private when it doesn't exist:

```bash
node "$WP" init owner/workpulse-notes --branch brain --create --steps     # a new repo (created private)
node "$WP" init owner/existing-repo --branch brain --steps                # an existing repo
```

Then show the user the browser steps it printed (branch, the **pre-filled token link**, Back up now) and run
`node "$WP" doctor`. The two "Extension" lines turn ✓ only after the user's first **Back up now**.

**Not a plugin** (the skill was linked by hand): `setup` installs the hooks and the rule, which edits
`~/.claude/settings.json` and `CLAUDE.md` — Claude Code may not do that on its own, so hand the user **one**
command. On a machine without the CLI, the one-line installer does it all:

```bash
! node "$WP" setup --repo owner/repo --yes
! curl -fsSL https://raw.githubusercontent.com/myind-ai/workpulse-extension/main/install.sh | bash -s -- --repo owner/workpulse-notes
```

The easiest route for anyone new is the plugin: `/plugin install workpulse-brain --marketplace myind-ai/workpulse-extension`.
Full guide: `docs/guides/connect-extension-and-claude-code.md`.

Afterwards run `node $WP doctor` and read it back: every ✓/!/✗ line, and what each `!` means. `setup` can be
re-run any time; it replaces its own hooks and rule and never touches anything else, and it keeps
`.wp-brain.bak` copies. The GitHub token is only ever pasted into the extension (fine-grained, Contents:
Read and write, that one repository, with an expiry). The CLI uses the user's own `gh`/git login and stores no token.

Whether this machine is already linked, and to which repository and branch, is in `~/.config/workpulse/brain.json`;
`node $WP doctor` reads it out.

If the session already began with a "WorkPulse Brain — what was recorded before…" block (the SessionStart hook,
`node $WP hook`), that is the brief: read it and skip step 2 below.

If a Stop hook says "This session committed work on KEY and nothing is recorded…" (`node $WP stop-check`),
do the end-of-ticket step below now, then stop. It asks only once per session; if the work was trivial, say so
in one line instead.

The brief also includes what the user wrote on the extension's Learnings page (from its daily backup under
`workpulse/data/`). Never write there: `bridge/` only.

## Before starting a ticket or a side-project task

1. Find the key: from the branch (`git branch --show-current` → `fix/pay-2433-…` → `PAY-2433`), the user's message, or the project name for personal work.
2. Run the brief and **read it before planning**:

```bash
node $WP brief PAY-2433 --project acme/payments-web --about "webhook retry"   # --about: the task in 2-4 words
```

It shows earlier entries for that ticket and its related ones, **what was learned before about the same subject
under other tickets** (`--about`; the SessionStart hook uses the branch's words), the mistakes that keep coming
back (30 days), open follow-ups, and requests the user sent from the extension's inbox. Say in one line what you
are taking from it.

3. When the task touches something that has gone wrong before, or the user asks "have I seen this", search
before guessing. Filters narrow it; the rest are words:

```bash
node $WP search "idempotency retry"                       # ranked: title, then subtitle and tags, then the rest
node $WP search "type:mistake #forms"                     # every mistake tagged forms
node $WP search "ticket:PAY-2433 has:next-action"         # where that ticket was left
node $WP search "repo:payments status:open after:14d"     # open work on a repo, last two weeks
node $WP search "type:debug has:root-cause timeout"       # diagnosed timeouts, with their causes
```

Filters: `ticket:` `type:` (ticket, learning, mistake, debug, decision, handover, report, code, skill, note)
`status:open|done` `repo:` `tag:` or `#tag` `after:`/`before:` (`2026-10-01` or `7d`, `2w`)
`has:next-action|pr|root-cause|links` `scope:work|personal`. The same filters work in the extension's search
box (Alt+Shift+K) and on its Brain page.
If an inbox item is handled, acknowledge it: `node $WP inbox --ack <id>`.

For personal productivity work, use `--scope personal --project <name>` and read the matching brief before planning. Preserve a concrete **next** step whenever work remains open; it is the resume point for the next session.

## While working

Record the moment it happens, not at the end, when one of these occurs:

| It happened | Command |
|---|---|
| A wrong assumption or a fix that did not work | `node $WP add mistake "what went wrong #tag" --ticket K --root-cause "why"` |
| A bug was diagnosed | `node $WP add debug "symptom" --subtitle "one-line impact" --ticket K --root-cause "cause" --body "fix and the command that proved it"` |
| Something reusable was learned | `node $WP add learning "the lesson #tag"` |
| A new skill/tool was set up | `node $WP add skill "what, and where the notes are"` |
| A choice between options was made | `node $WP add decision "chose X over Y" --ticket K --body "why, and what would change it"` |
| Handing work to someone (or to tomorrow) | `node $WP add handover "where it stands" --ticket K --status "in progress" --next "first thing to do"` |

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
- **Short and specific**: titles are one line; `--subtitle` says why it matters; the body holds commands, error text and the fix.
- **Always leave a resume point**: for unfinished work, set `--status "in progress" --next "the next concrete action"`. Claude must read that next action before continuing the same ticket or project.
- **Never secrets**: the tool refuses anything token-shaped, but also leave out customer data, passwords and full logs.
- Pushing to this private notes repo is the skill's purpose; it is the one push that needs no extra ask once the user has run `init`.

## Managing what is saved

Everything is append-only underneath (one writer per file, so nothing conflicts); a change is one more line
that every reader applies. Every list and search shows an entry's id in `[brackets]`: that is what these take.

```bash
node $WP search "type:learning idempotency"           # find it (or: list --kind learning)
node $WP edit 3f9a2c1d --title "better wording" --tags retry,payments --root-cause "…" --next "…"
node $WP archive 3f9a2c1d                             # out of lists, search and briefs; still kept
node $WP list --archived                              # what is archived
node $WP restore 3f9a2c1d
node $WP rm 3f9a2c1d                                  # hidden everywhere
node $WP rm 3f9a2c1d --purge                          # this machine's own entry: its line and record removed for good
```

- **Don't save it twice.** `add` skips an entry with the same kind, title and ticket that is already there and
  prints its id; improve that one with `edit` instead. `--force` adds anyway.
- **When a learning turns out wrong or outdated**, edit it (or archive it) the moment you find out, so the next
  brief does not repeat it.
- **"Save it in learning"** from the user means `add learning "…" #tags`, nothing more to ask; add `--subtitle`
  for why it matters and `--ticket` when it came from a ticket.
- The extension's Brain page has the same: **Edit**, **Archive**, **Delete** on every entry, and **Archived**.

## Reports

```bash
node $WP report --days 7               # week, Markdown on stdout
node $WP report --days 30 --scope personal
node $WP list --kind mistake --query forms
node $WP search "idempotency retry"    # ranked title/tag/body matches, with next actions
node $WP index                         # add this device's missing records; write INDEX.md + graph.json beside the clone
```

Every `add` commits only the entry line and its own record. `INDEX.md` (open
next actions, recent records) and `graph.json` are built from every device on
read and never committed: `wp-brain index` writes them to `<clone>-index/`, and
the extension builds them in memory. The graph chains records that share a
ticket, project or tag. Search is lexical and
evidence-based today: it ranks title, subtitle, tags, and body matches; it does
not claim semantic similarity that has not been verified.

## Updating the extension

When the user asks to update the WorkPulse extension (or its dashboard says a newer version is out), run the
updater. It replaces the files inside the folder Chrome loads, keeps `<folder>.previous`, and refuses a folder that
does not hold WorkPulse. Then tell the user to press **Reload** in WorkPulse. Never tell them to Remove the extension:
that deletes its data.

```bash
curl -fsSL https://raw.githubusercontent.com/myind-ai/workpulse-extension/main/update.sh | bash -s -- --check   # what it would do
curl -fsSL https://raw.githubusercontent.com/myind-ai/workpulse-extension/main/update.sh | bash                 # do it
```

If it says the folder has no WorkPulse manifest, ask which folder they picked in **Load unpacked** and pass
`-s -- --dir "/that/folder"` (remembered afterwards).

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

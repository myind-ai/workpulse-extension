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
WP="$(ls -t "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/workpulse-brain/*/cli/wp-brain.mjs 2>/dev/null | head -1)"   # installed as a Claude Code plugin
[ -f "$WP" ] || WP="${WP_CLI:-$HOME/workpulse-extension/cli/wp-brain.mjs}"   # installed by install.sh (or set WP_CLI)
node "$WP" help
```

How the whole flow works: `docs/guides/brain-flow-and-next-steps.md` in the WorkPulse repo.

## Setup — check first, then ask, never assume

Run `node $WP doctor` the first time this skill is used in a session (it is fast and changes nothing).
If it reports **Config missing**, or the SessionStart context says the plugin "is installed but not linked",
or the user asks to set up, re-link or change the Brain, **ask before doing anything**, with one AskUserQuestion
holding these two questions. Get `<gh login>` first with `gh api user --jq .login`. If `gh` is missing or not signed
in, say so and stop: the user runs `! gh auth login` (an interactive login), then ask again.

| Question | Options (first is recommended) | `--use` |
|---|---|---|
| How do you want to use it? | **Lessons, skills and rules**: what you learn, plus a copy of `~/.claude` skills and rules so a new computer can restore them | `skills` |
| | **Lessons only**: mistakes, lessons and tickets | `brain` |
| | **Everything**: also the full text of your sessions, kept on this computer and searchable | `sessions` |
| | **Not now**: carry on with the task | |
| Which private repository? | **A new `<gh login>/workpulse-notes`** · **Another name** (they type it; a bare name goes under their login, an existing `owner/name` is fine) | `--repo` |

Never suggest the code repository: learning goes in a repository of its own. A Brain already inside one moves with `wp-brain move owner/workpulse-notes` (a plan first; `--yes` does it, on the user's word).

**Installed as a plugin** (the path above is under `plugins/cache`, or the session-start note gave the path; use that one): their answers are the go-ahead, so run it yourself. It writes only `~/.config/workpulse/` and `~/.workpulse/`, because the hooks come from the plugin:

```bash
node "$WP" connect --repo workpulse-notes --use skills
```

It creates the repository private when missing, refuses a public one, stores the skills and rules, leaves out files that look like they hold a secret and names them, and turns on session memory for `sessions`. Then tell the user what it printed: where the Brain is, what was stored, what was left out, and the browser steps for the extension (branch, the **pre-filled token link**, Back up now). Run `node "$WP" doctor` and read it back. The two "Extension" lines turn ✓ only after the user's first **Back up now**.

Branch is always **`brain`**, the extension's default from 1.6.0. The machine's name defaults to `cli-<hostname>`; say it in the result, and change it only if asked (`--device NAME`).

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

If the session already began with a "WorkPulse Brain, recorded before for …" block (the SessionStart hook,
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
are taking from it. The brief is capped at 400 tokens and ends `… N more: wp-brain brief KEY --full` when something
was left out: run that for all of it. `node $WP show ID` prints one entry in full (body, root cause, next steps).

3. **Lessons arrive on their own, per prompt.** With the UserPromptSubmit hook (`setup` → question 4, or the
   plugin), every prompt that shares at least two real words with a recorded learning, mistake, debug,
   decision or skill gets up to three of them as context (one line each, 300 tokens at most, with where it came
   from or `wp-brain show ID`). Use them when they apply and say so in one line; ignore them when they don't. It reads the local clone (the
   SessionStart brief pulls), shows each lesson once per session, and stays quiet for commands and short
   replies. Try it by hand: `node $WP recall "write the reel script"`.
   Once the owner has a rule map (`~/.claude/rule-files/rule-map.json`), recall also adds up to two pointer lines,
   rules first and then skills, in the same cap: `- Read before acting: <path> (<why>)`. It is a pointer, never the
   text: read that file before acting. A rule's trigger word is enough; a skill needs its name or two of its
   description words. Without a map there are no pointers. The guard (when on) does the same once per session and
   agent when a command in a rule's `onCommand` runs, which is what reaches subagents.

4. When the task touches something that has gone wrong before, or the user asks "have I seen this", search
before guessing. Filler words are ignored and word forms meet (script ≈ scripting). Filters narrow it; the rest are words:

```bash
node $WP search "idempotency retry"                       # ranked: more of your words first; title, then subtitle and tags, then the rest
node $WP search "type:mistake #forms"                     # every mistake tagged forms
node $WP search "ticket:PAY-2433 has:next-action"         # where that ticket was left
node $WP search "repo:payments status:open after:14d"     # open work on a repo, last two weeks
node $WP search "type:debug has:root-cause timeout"       # diagnosed timeouts, with their causes
```

Filters: `ticket:` `type:` (ticket, learning, mistake, debug, decision, handover, report, code, skill, note)
`status:open|done` `repo:` `tag:` or `#tag` `after:`/`before:` (`2026-10-01` or `7d`, `2w`)
`has:next-action|pr|root-cause|links` `scope:work|personal`. The same filters work in the extension's search
box (Alt+Shift+K) and on its Brain page.
If an inbox item is handled, acknowledge it: `node $WP inbox --ack <id>`. Pages saved from the extension are not asks: they show as one count line and are read only on "process my queue" (see that section).

For personal productivity work, use `--scope personal --project <name>` and read the matching brief before planning. Preserve a concrete **next** step whenever work remains open; it is the resume point for the next session.

## While working

### WorkPulse time log

When the user asks to log a completed, real work interval, write one compact
local WorkPulse row. Use an explicit duration or start/end time; never guess a
session's elapsed time. This syncs through the private bridge into the browser
extension's **Review & timesheet** queue. It does **not** write to Zoho: the
user reviews and presses the extension's manual Push button.

```bash
node $WP worklog "Implemented retry validation" --minutes 45 --job ZOHO_JOB_ID --ticket PAY-2433
node $WP worklog "Reviewed payment PR" --from 2026-10-28T10:00:00+05:30 --to 2026-10-28T10:30:00+05:30 --job ZOHO_JOB_ID
```

Keep the description factual and one line. Omit `--job` only when the user
will select the job in Review. Never run a Zoho push; the extension owns that
manual, visible step.

### Scan Claude Code activity (only when asked or configured by the user)

`scan-claude` reads only timestamps from local Claude transcript JSONL files.
It never copies prompts, answers, secrets, or customer text into a work log.
It splits at idle gaps and caps every proposal at two hours, then commits
idempotent records to the private bridge. The extension imports them into
**Your time logs** on **Sync now**; the user can edit job, description, start,
end and total before pressing the one visible **Push to Zoho** action.

```bash
node $WP scan-claude --since 24h --gap 20 --max-session 120 --job ZOHO_JOB_ID --ticket PAY-2433
```

- Default `--since` is `24h`; accepted values are `30m`, `8h`, `2d`, `1w`.
- Default idle `--gap` is 20 minutes. Use a smaller gap for short focused work.
- `--max-session` must stay between 5 and 120 minutes. Do not raise it beyond
  two hours: long inferred spans must be reviewed in smaller pieces.
- Do not run it automatically at session end. Ask the user, or follow their
  explicit recurring rule. A transcript is activity evidence, not proof of
  billable time.
- If local extension data was restored or cleared, **Sync now** imports a
  bridge interval again exactly once; the local row, not an old cache marker,
  is the restore authority.

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

## Session memory

Only where the owner ran `wp-brain memory on`; `memory on`, `backfill`, `import-claude-mem` and `backup schedule on` are the owner's steps, never yours. If the Stop hook asks for a summary, run the one command it names and stop, writing each apostrophe as `'\''` (a bare one can let a `$(...)` run). For the note, search, the archive, export or promotion, first read `session-memory.md` in this skill's folder.

## Learn from a website

Triggers: "learn from this page", "learn from this article", "save this site". No Brain setup is needed for the first step.

1. `node $WP learn <url>` saves the article into `~/Documents/youtube-learning/<date>_<slug>_<hash>/` (`article.md`, `meta.json`, a pending `notes.md`) and prints one JSON line `{ folder, title, words, problems }`. A page with almost no text (a login wall, or one that needs JavaScript) and a PDF are refused; say so and stop.
2. Read all of `article.md`, then fill `notes.md` from it and delete its `<!-- status: pending … -->` line.
3. `node $WP library add <folder> --type site` (only does anything when `"library": true` is in brain.json; if it is off, say so once and carry on).
4. Record 2–5 lessons: `node $WP add learning "<title> #tag" --source-type site --source-url "<url>" --source-title "<page title>" --source-library "<library path printed in step 3>" --body "From \"<page title>\" <url>. Notes: <folder>/notes.md"`. Use the title rule from the video skill: the title uses the words a future task will use, not the page's own words, and never holds article text. Check with `node $WP recall "<a task this should help>"`.
5. Put each returned `[id]` under *Recorded in the Brain* in `notes.md`, then run the `library add` from step 3 again, so the backup holds the finished notes. It is safe to repeat: nothing commits when nothing changed.

## Process my queue

Pages the person saved with the extension's **Save to Brain** button wait in the Brain. The brief shows only a count ("Saved to read: 3"), and nothing is fetched or read until they ask. Run this only when asked. Triggers: "process my queue", "read what I saved".

1. `node $WP queue` lists what is waiting, stuck (claimed by another device) or failed, with `[id]`s.
2. Loop `node $WP queue next`. It claims the oldest waiting page (or resumes this device's unfinished claim), pushes the claim first, and prints one JSON line:
   - `{ "empty": true }`: nothing left. Stop and report.
   - `{ "failed": true, "id", "url", "why" }`: the page could not be read (login wall, needs JavaScript, a PDF). It is already marked failed; carry on with the next call.
   - `route: "site"` with `{ id, url, folder, title, words, problems }`: read all of `<folder>/article.md`, write `notes.md` from it and delete its `<!-- status: pending … -->` line, then `node $WP library add <folder> --type site`, then 2 to 5 lessons exactly as in "Learn from a website" (`--source-type site --source-url <url>`, the same title rule: the words a future task will use, never article text). If the library is off, say so once and carry on, as the video skill does.
   - `route: "video"` with `{ id, url, title }` and no `folder`: a YouTube or Instagram URL. Never read it as a page. Follow the `youtube-learning` skill for that URL.
3. Then `node $WP queue done <id> --lessons N`, or `node $WP queue fail <id> --why "<one line>"` when you could not finish. `node $WP queue retry <id>` puts this device's own failed page back.
4. Report what was saved (title, lessons) and what failed (id and reason). A page another device claimed stays with it; leave it.

The first device to acknowledge a page owns it. A device that has seen that acknowledgement leaves the page alone. Two machines working at the same moment can both start the same page before either has seen the other; the earlier acknowledgement then wins. `[id] belongs to <device>` from `queue done`, `fail` or `retry` means that device owns it: leave it and carry on with the next page.

## On a new machine, and for older lessons

Triggers: "set up my new laptop", "restore my skills", "bring my notes over", "give old lessons a source". Everything here needs `"library": true` in brain.json (`setup` asks; the answer is off by default), except `backfill-source`.

1. `node $WP setup` (links this machine), then `node $WP doctor` (its Library line says on or off and how many folders it holds).
2. `node $WP library restore` puts notes and transcripts back into `~/Documents/youtube-learning/`; `node $WP config restore` puts `~/.claude/CLAUDE.md`, `RTK.md` and the skills back. A file already there is kept; say so, and use `--force` only if the user asks. The exception is a `CLAUDE.md` holding only the Brain rule that `setup` just wrote: it counts as empty, so the backup replaces it. When the backup has no Brain rule, this machine's goes back in (with `--force` too). With backups from several machines, choose one with `--from DEVICE`.
3. On the machine that has them: `node $WP config backup` (text only; symlinked skills, hidden folders, files and folders with sensitive names such as `.env`, `*.pem` or `*token*`, `node_modules`, `.git`, media and files over 2 MB are left out; one secret-shaped file stops it, naming the file) and `node $WP library add <folder> --type <type>`. Both print what they kept and skipped.
4. Older lessons without a source: `node $WP backfill-source` lists what it would set (a dry run); `--yes` writes one commit. A second run finds 0.

## Vault: videos and database backups

Triggers: "back up my videos", "vault", "restore my database", "set up the vault", "new Mac, get my backups back". Off unless `brain.json` holds `"vault"`. Videos and databases go as release assets to a separate private repository, `<user>/workpulse-vault`; git there holds only `manifest/<device>.json` (names, sizes, checksums, dates). Databases are encrypted with an age key that lives in the macOS Keychain. Videos are not encrypted. It needs `gh` logged in and `age` (`brew install age`); on a new machine run `node $WP setup` first.

**Ask the owner before every `--yes`.** It creates a repository, uploads or deletes. Run the command without it first and show what it says.

**Claude never runs `vault key export`, `vault key confirm` or `vault key import`**; tell the owner to run them in their own terminal. They refuse without a terminal anyway. The key is never printed by anything else, and never goes in a repo, file, config, log, chat or Brain entry. If the owner pastes it into a chat, tell them to treat it as exposed.

| Command | What it does |
|---|---|
| `node $WP vault init [--yes]` | Says what it would do; with `--yes` creates the private repo (refusing if it isn't private), clones it to `~/.workpulse/vault/`, makes a key only for a new repo, writes `"vault"` into `brain.json`. A second run changes nothing |
| `vault key export` | Owner's terminal only: prints the key once |
| `vault key confirm` | Owner's terminal only: the owner types the key's last 4 characters from their copy; records `keyBackedUpAt` |
| `vault key import` | Owner's terminal only: paste the key (hidden) on a new Mac; a wrong fingerprint or a different key already stored is refused |
| `vault backup [--videos] [--databases] [--yes] [--dry-run] [--discard-staged]` | A dry run unless `--yes`. A run that was stopped resumes with the same release |
| `vault list` / `vault status` | What the vault holds; the key's state, orphan releases and unlisted assets |
| `vault restore <name or id> --to DIR [--force]` | Puts one item back under its name, checked end to end; a file already there is kept |
| `vault prune [--keep N] [--yes]` | A list unless `--yes`: deletes old snapshots and orphan releases of this device, never videos |

**The offline copy of the key, in plain words.** Losing the key loses every encrypted backup, and nothing can get it back. So after `vault init`, tell the owner: run `vault key export` in your own terminal, write the key down or print it, and keep it somewhere that is not this Mac, such as a password manager and a paper copy; never paste it into a chat; then run `vault key confirm`. Until then `vault backup` refuses encrypted items.

**A new Mac:** `node $WP setup`, then `vault init --yes` (the repo exists, so it clones and writes the config, with no new repo and no new key), then the owner runs `vault key import`, and `vault key confirm` before backing up from that Mac: import itself never records the offline copy. A new key clears the record of an old key's copy, so `vault key export` and `confirm` are asked for again. `vault restore` needs only the clone, the assets and the key.

**What to tell the owner when it stops:**

- One bad manifest stops every restore: it fails closed and names the item. Fix that manifest in the vault repo, then run again.
- Prune stops when this device's manifest lists no database but published snapshots of this device exist. That looks like a lost manifest, not old backups, so nothing is deleted. Restore the manifest from the vault repo's history.
- A secret-shaped file name stops a backup without printing the name; it says which position to rename.
- Which key is which: `vault status` and `doctor` show the fingerprint, 8 hex characters that reveal nothing.

`node $WP doctor` shows vault off or on, age, key present, offline copy, repo private and the last verified snapshot; a public vault repo fails it.

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
node $WP graph PAY-123                 # what connects to a ticket; also '#tag', project:name, a lesson [id], or words
node $WP graph                         # counts per node type and the most connected hubs
```

### What connects to X

Triggers: "what connects to X", "what else is linked to this", "show the graph for PAY-123", "which lessons share this
tag". Run `node $WP graph X` (add `--depth 2` for neighbours of neighbours, `--type tag,project` to show only some hub
types, `--limit N`, `--json`). It is read-only and prints nothing unless asked: never run it unprompted, never paste its
output into a brief, a hook or a record.

Every `add` commits only the entry line and its own record. `INDEX.md` (open
next actions, recent records) and `graph.json` are built from every device on
read and never committed: `wp-brain index` writes them to `<clone>-index/`, and
the extension builds them in memory. The graph has a node per lesson and a hub
per ticket, project, tag and source (one per video or page, whatever `&t=` it
carries); a lesson joins the hubs it names, so it grows with the entries. Search is lexical and
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

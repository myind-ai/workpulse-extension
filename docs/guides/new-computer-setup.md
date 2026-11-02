# Set up WorkPulse on another computer

Updated: 2026-11-02
What it is for: a second (or replacement) computer that should get the same Brain, skills, rules, learning notes and
extension data as the first one, plus the working flow that keeps recording on both from then on.
Related: [first-time setup](connect-extension-and-claude-code.md) · [where your learning lives](where-your-learning-lives.md) ·
[the Brain skill](../../skills/workpulse-brain/SKILL.md) · [Jira plugin](jira-ticket-update-setup.md) · [video plugin](../../plugins/youtube-learning/README.md)

Setting up from scratch, with no Brain repository yet? Use the [first-time guide](connect-extension-and-claude-code.md).
This page is for when the first computer already has one (e.g. `you/workpulse-notes`, branch `brain`).

## What moves, and how

| Thing | Where it lives | How it reaches the new computer |
|---|---|---|
| Lessons, mistakes, tickets, decisions (per project and ticket) | `bridge/entries/…` in your private Brain repo | Automatically: `connect` clones it, every brief and recall reads it |
| `~/.claude/CLAUDE.md`, `RTK.md`, rules, skill text | `bridge/config/<device>/` | `wp-brain config restore` (only if the first computer ran `config backup`, or `connect --use skills`) |
| Video and article notes, transcripts | `bridge/library/…` | `wp-brain library restore` (only with `"library": true`) |
| Extension data (entries, learnings, tasks, settings) | `workpulse/` in the same repo (the extension's daily backup) | Extension → Settings → Backup → **Restore it here** |
| Zoho sign-in, the GitHub token | that one browser only | Done again by hand (steps 6 and 7) |
| Session memory (full session text) | `~/.workpulse/memory/memory.db` on each computer | Stays on each computer. Only the encrypted vault carries it, if you use one |
| Videos, database snapshots | your private `you/workpulse-vault` (opt-in) | `wp-brain vault init --yes`, then `vault key import` in your own terminal |

Each computer writes only its own files (`cli-<hostname>` for Claude Code, a browser id for the extension), so two
computers never conflict.

## 1. Tools

```bash
node -v                 # 22.18 or newer; if older: nvm install 24 && nvm use 24
git --version
gh auth login           # once; the CLI uses your own GitHub login and stores no token
gh auth status
```

For the video plugin (optional): `brew install yt-dlp ffmpeg` (optional extras: `deno`, `pip install openai-whisper`).
For the vault (optional, macOS): `brew install age`.

## 2. Install the three Claude Code plugins

In Claude Code:

```text
/plugin marketplace add myind-ai/workpulse-extension
/plugin install workpulse-brain@workpulse
/plugin install youtube-learning@workpulse
/plugin install jira-ticket-update@workpulse
```

Already added the marketplace a while ago? Run `/plugin marketplace update workpulse` first. Then **start a new
session** so the plugins load. Check with `/plugin`: all three should say enabled.

| Plugin | Does |
|---|---|
| `workpulse-brain` | Brief at session start, matching lessons on every prompt, an offer to record after a commit, the `wp-brain` CLI and skill |
| `youtube-learning` | Paste a YouTube / Instagram link: video, subtitles, transcript, notes, and the takeaways sent to the Brain |
| `jira-ticket-update` | On a commit, PR or session end, drafts a Jira comment and status move and asks before writing |

## 3. Link this computer to the same Brain

Say in Claude Code:

```text
Link my WorkPulse Brain to you/workpulse-notes
```

Or run it yourself. Find the CLI the plugin installed, then connect to the **existing** repository:

```bash
WP="$(ls -t ~/.claude/plugins/cache/*/workpulse-brain/*/cli/wp-brain.mjs | head -1)"
node "$WP" connect --repo you/workpulse-notes --use skills
```

`connect` finds the repository already there, so it creates nothing. It clones branch `brain` to `~/.workpulse/brain`,
writes `~/.config/workpulse/brain.json`, and names this computer `cli-<hostname>`. With `--use skills` it also
switches the library on and stores this computer's own skills. Use `--use sessions` instead to also keep session
memory on this computer.

**"This computer already uses …"** means it was linked to another repository before. `wp-brain move you/workpulse-notes`
says what would happen; it moves only with `--yes`.

## 4. Bring back skills, rules and notes

```bash
node "$WP" config restore --from cli-<first-computer-hostname>    # CLAUDE.md, RTK.md, rules, skills
node "$WP" library restore                                        # notes + transcripts into ~/Documents/youtube-learning/
```

A file already on this computer is kept; the command says which. `--force` replaces them. **Always pass `--from`**:
without it, restore picks this computer's own backup first, and step 3's `--use skills` may already have stored one.
To see the device names: `ls ~/.workpulse/brain/bridge/config/`.

**Paths inside the restored `CLAUDE.md`.** If the first computer's rules name an absolute path to `wp-brain.mjs`
(e.g. a `WP=…` line), it is wrong on this computer unless you cloned the code to the same place. Point it at
`$WP` from step 3, or clone the code repository to the same path.

## 5. Check it

```bash
node "$WP" doctor
node "$WP" brief --project owner/some-repo     # what was recorded before for that project
node "$WP" recall "write the release notes"    # lessons a prompt would get
```

Every `doctor` line should show ✓. With the plugin, `SessionStart hook / Stop hook — not installed` is expected
(the plugin's hooks are not in `settings.json`): `/plugin` showing workpulse-brain enabled is what counts.

## 6. The extension

1. Install it (Mac / Linux):

   ```bash
   curl -fsSL https://raw.githubusercontent.com/myind-ai/workpulse-extension/main/update.sh | bash
   ```

   It puts the latest release in `~/WorkPulse/extension`. Open `chrome://extensions` → **Developer mode** on →
   **Load unpacked** → pick that folder. (Windows: download the `-chrome.zip` from
   [the latest release](https://github.com/myind-ai/workpulse-extension/releases/latest) and unzip it to a folder you keep.)
2. Settings → Backup → **Make a token** (pre-filled: Contents Read and write, 90 days) → *Only select repositories* →
   your Brain repo → **Generate token** → paste it.
3. Because the repository already holds a backup, the extension shows how many learnings, tickets and days it holds
   and offers **Restore it here**. Press that, **not** *Back up now*: a fresh browser's empty backup would
   otherwise be the newest copy.
4. Reconnect Zoho through **Connect Zoho**. The extension ID is the same on every computer, so the same Zoho
   client works.

Never **Remove** the extension to update it: that deletes its data. To update, run the same `update.sh` line, then
press **Reload** on the notice.

## 7. Optional extras

| Want | Run |
|---|---|
| Session memory on this computer | `node "$WP" memory on` (your step: it adds hooks to `settings.json`) |
| Daily backup at 03:30, or at the next wake (macOS) | `node "$WP" backup schedule on` |
| Videos and encrypted databases | `node "$WP" vault init --yes` (clones the existing vault, makes no new key), then in **your own terminal** `vault key import` and `vault key confirm` |
| Jira | `/mcp` → atlassian → sign in. One person per team commits `.claude/jira-ticket-update.json` |

## How it works once set up

```text
 Claude Code session                          Private Brain repo (branch brain)               Chrome extension
 ─────────────────────                        ───────────────────────────────                 ────────────────
 SessionStart ── brief for this repo/branch ◀─ bridge/entries/*/<device>.jsonl ─────────────▶ Brain page (syncs every
 each prompt ─── up to 3 matching lessons  ◀─                                                  minute while open,
 while working ─ wp-brain add mistake/debug/ ─▶ one commit + push per entry,                  every 15 min otherwise)
                 learning/decision            plus bridge/records/<device>/YYYY-MM/*.md
 after a commit  Stop hook asks once ──────▶ one ticket entry (asked, done, root cause,
                                               status, next, PR, commits)
 paste a video ─ youtube-learning ─────────▶ lessons + bridge/library/youtube/<folder>
 open a PR ───── jira-ticket-update asks ──▶ Jira comment + move (only after your yes)
                                              workpulse/ ◀──────────────────────────────── daily backup of the
                                                                                              extension's own data
```

- **Project and ticket wise.** Every entry carries `--project owner/repo` and, when there is one, `--ticket KEY`
  (taken from the branch, e.g. `fix/pay-2433-…` → `PAY-2433`). The brief reads by those, so each repository gets
  its own history. Side projects use `--scope personal --project <name>`.
- **Nothing to push by hand.** Each `add` commits and pushes only its own line to the Brain. If a push fails
  (offline), `wp-brain sync` sends it later.
- **What never goes in:** tokens, passwords, `.env` values, customer data, full logs. The CLI refuses anything
  token-shaped, and `config backup` leaves out files that look like they hold a secret, naming them.

## Fixes

| Symptom | Fix |
|---|---|
| `Plugin "workpulse-brain" not found in marketplace "workpulse"` | `/plugin marketplace add myind-ai/workpulse-extension` (or `… update workpulse`), then install again |
| `wp-brain needs Node 22.18 or newer` | `nvm install 24 && nvm use 24` |
| `doctor`: `Config missing` | Run step 3 |
| `… is a clone of X, not Y` | An old `~/.workpulse/brain` from another repo: move it aside, run step 3 again |
| `config restore` finds nothing | The first computer never stored them: there, run `wp-brain config backup` |
| Extension shows no Brain entries | Brain page → **Sync now**; check the Branch in Settings → Backup is `brain` |
| `Committed locally but could not push` | `wp-brain sync`; check `gh auth status` |

## What changed

- 2026-11-02: first version. Covers plugins 1.8.1 (`workpulse-brain`), 0.2.2 (`youtube-learning`), 0.2.0
  (`jira-ticket-update`) and extension 1.7.0.

# Connect the WorkPulse extension and Claude Code to one GitHub repository

Updated: 2026-10-27 (fewer steps: branch `brain` on both sides by default, one-answer setup)

For anyone setting up WorkPulse from scratch: install the extension, link it to a private GitHub repository,
and link Claude Code to the same repository, so that both read and write one shared Brain. It takes about 5 minutes.

**The short version:** install the extension → Zoho setup opens by itself, and when it's green it says what's next →
in Claude Code `/plugin install workpulse-brain --marketplace myind-ai/workpulse-extension` and answer one
question → in the extension, paste one token and press **Back up now**. Both sides use the `brain` branch
without you typing it.
Related: [README](../../README.md) · [skill](../../skills/workpulse-brain/SKILL.md) · [installer](../../install.sh) · [privacy](../PRIVACY.md)

## What you end up with

| Side | Talks to GitHub with | Writes |
|---|---|---|
| Extension (Chrome) | a fine-grained token for **one** repository, Contents: Read and write | `workpulse/` (daily backup) and `bridge/entries/…/<browser>.jsonl` |
| Claude Code (terminal) | your own `gh` login; no token stored | `bridge/entries/…/cli-<machine>.jsonl` |

Each device writes only its own files, so the two sides never conflict.

## Before you start

- Chrome
- Node **22.18 or newer** (`node -v`; if it's older, run `nvm install 24`)
- git, and the GitHub CLI signed in: `gh auth login`
- macOS or Linux for the one-line connect. On Windows, use the two manual commands in step 2.

## 1. Install the extension

Use whichever of these is available:

| Way | How |
|---|---|
| Chrome Web Store | *(not yet listed; this guide gets updated once it is)* |
| One line (Mac, Linux) | `curl -fsSL https://raw.githubusercontent.com/myind-ai/workpulse-extension/main/update.sh \| bash` puts the latest release in `~/WorkPulse/extension`. In `chrome://extensions`, switch on **Developer mode**, click **Load unpacked**, and pick that folder. The same line updates it later |
| Release zip | Download `workpulse-extension-1.5.0-chrome.zip` from [the latest release](https://github.com/myind-ai/workpulse-extension/releases/latest) and unzip it into a folder you keep (e.g. `~/WorkPulse/extension`). In `chrome://extensions`, switch on **Developer mode**, click **Load unpacked**, and pick that folder |
| From source | `git clone https://github.com/myind-ai/workpulse-extension && cd workpulse-extension/extension && npm install && npm run build`, then load `extension/.output/chrome-mv3` the same way |

### Updating

Chrome does not update an extension loaded with **Load unpacked**. WorkPulse asks GitHub once a day and shows
**WorkPulse x.y is out** at the top of its dashboard (Settings → **Updates** has the same, plus **Check now**).

1. Run the update line in a terminal. It replaces the files *inside* the folder you loaded, keeps the old ones in
   `<folder>.previous`, and refuses any folder that does not hold WorkPulse:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/myind-ai/workpulse-extension/main/update.sh | bash
   curl -fsSL https://raw.githubusercontent.com/myind-ai/workpulse-extension/main/update.sh | bash -s -- --dir "/the/folder/you/loaded"   # first time, if not ~/WorkPulse/extension
   ```

2. Press **Reload** on the notice (or ↻ on `chrome://extensions`). Everything saved stays.

**Never click Remove to update**: that deletes the extension's data. On Windows, download the zip, unzip it over the
folder you loaded (replacing the files), then Reload. With the plugin, you can also ask Claude Code to "update the
WorkPulse extension".

## 2. Connect Claude Code

### Easiest: the plugin (any OS with Node 22.18+; needs `gh auth login`)

In Claude Code, run:

```text
/plugin install workpulse-brain --marketplace myind-ai/workpulse-extension
```

On Claude Code older than 2.1.275, use these two commands instead:

```text
/plugin marketplace add myind-ai/workpulse-extension
/plugin install workpulse-brain@workpulse
```

**It says `Plugin "workpulse-brain" not found in marketplace "workpulse"`?** The plugins live in their own
marketplace, not Anthropic's directory, and each machine adds it once. Claude Code's own hint ("your local copy may
be out of date") appears even when the marketplace was never added. Two causes, two fixes:

| Cause | Fix |
|---|---|
| The marketplace was never added on this machine (you ran `…@workpulse`, or searched in `/plugin`) | `/plugin marketplace add myind-ai/workpulse-extension`, then `/plugin install workpulse-brain@workpulse` |
| It was added before the plugin you want existed (e.g. `jira-ticket-update`) | `/plugin marketplace update workpulse`, then install again |

Then start a new session so the plugin loads. Settings → Claude Code & the Brain → step 2 has the same, with copy buttons.

The plugin brings the skill and both hooks (a brief at session start, an offer to record after a commit). You
don't edit any settings by hand. In the next session, Claude notices the Brain isn't linked and offers to link it,
or you can say it yourself:

```text
Link my WorkPulse Brain to you/workpulse-notes
```

Claude asks **one** question (a new private `you/workpulse-notes`, or a repository you name), creates it as
**private** if it doesn't exist, links this machine on the `brain` branch, and shows you step 3 with your token
link filled in. The extension's **Settings → Claude Code & the Brain** panel shows both
lines with your repository already filled in.

### Or: one terminal line (macOS / Linux), without the plugin

```bash
curl -fsSL https://raw.githubusercontent.com/myind-ai/workpulse-extension/main/install.sh | bash
```

With an existing repository, or a `brain` branch of one:

```bash
curl -fsSL https://raw.githubusercontent.com/myind-ai/workpulse-extension/main/install.sh | bash -s -- --repo you/workpulse-notes --branch brain
```

What it does. It shows the recommended answers once, and **Enter** takes them all (`n` asks each one; `--yes`
skips even that):

1. Checks Node, git and `gh auth status`.
2. Installs (or updates) the CLI and the skill in `~/workpulse-extension`.
3. Creates the repository as **private** if it doesn't exist (`gh repo create --private`).
4. Clones only the Brain branch to `~/.workpulse/brain`, and writes `~/.config/workpulse/brain.json`.
5. Adds the two hooks to `~/.claude/settings.json`, and the WorkPulse Brain rule to `~/.claude/CLAUDE.md`.
   It also links the skill.
6. Prints the browser steps for step 3, with your repository and token link filled in.

Before changing a file, it saves a `.wp-brain.bak` copy. Re-running it is safe, and it's also how you update.
If you later install the plugin as well, its hooks stay quiet, so nothing runs twice.

Windows, or if you'd rather not pipe a script into bash:

```bash
git clone https://github.com/myind-ai/workpulse-extension.git ~/workpulse-extension
node ~/workpulse-extension/cli/wp-brain.mjs setup --repo you/workpulse-notes --yes
```

## 3. Connect the extension

In Chrome, open WorkPulse → **Settings → Backup**:

1. **Repository**: press **Create it on GitHub →** (one click on GitHub's own form), or **I already have one** if setup made it.
2. **Make a token**: the button opens GitHub's token page with the name, **Contents: Read and write** and a 90-day expiry already filled in.
   You choose one thing: **Repository access → Only select repositories → your Brain repository**.
   Then click **Generate token**. The same pre-filled link is in setup's output:

   ```text
   https://github.com/settings/personal-access-tokens/new?name=WorkPulse+Brain&expires_in=90&contents=write
   ```

3. Paste the token (a token limited to one repository picks it by itself) and press **Back up now**. The first backup
   only runs when you press it.

The branch is already `brain`, the same as Claude Code's, so there is nothing to set.

**Already have a repository with your WorkPulse backup** (a new browser or machine)? Paste the token as above. If the
repository already holds a backup, step 4 says so (how many learnings, tickets and days, and when) and offers
**Restore it here** instead of *Back up now* (1.6.1). A backup from a fresh browser would otherwise write its empty
copy over yours. The token and the Zoho connection are per browser; everything else comes from the repository. Extensions set up before 1.6.0
keep the branch they had.

The token is stored only in the extension. Never put it in a repository, an `.env` file, a chat, or a Brain entry.

## Optional: keep Jira tickets up to date

A separate plugin, no extension needed: `/plugin install jira-ticket-update --marketplace myind-ai/workpulse-extension`,
then `/mcp` → atlassian → sign in. See [the explainer](jira-ticket-update-setup.md).

## 4. Check it

**In the extension:** Settings → **Claude Code & the Brain** → *Set it up, step by step* → **4. Test it**. Copy the sentence,
say it in Claude Code, and press **Check**. *Passed — cli-… saved it* means every part is linked.


```bash
node ~/workpulse-extension/cli/wp-brain.mjs doctor
```

Every line should show ✓. In the extension, **Settings → Claude Code & the Brain** shows the repository, branch
and token, the last sync, and every machine and browser that has written. It also shows the connect command
filled in with your repository.

| `doctor` says | Fix |
|---|---|
| `Extension seen — no browser has written yet` | Brain page → **+ Add** one entry, or press **Back up now** |
| `Extension backup — not on this branch yet` | The extension's Branch differs from setup's. Make them the same, then **Back up now** |
| `SessionStart hook / Stop hook — not installed` | With the plugin, this is expected: the plugin's hooks aren't in `settings.json`. Check `/plugin` shows workpulse-brain as enabled. Without the plugin, run the connect line again and answer yes |
| `Config missing` | Run the connect line |
| Claude Code: `Plugin … not found in marketplace "workpulse"` | See *It says … not found* under step 2: add the marketplace, or `/plugin marketplace update workpulse` |

## What changed

- 2026-10-27 (1.6.2): what to do when Claude Code says `Plugin … not found in marketplace "workpulse"` (here, in Settings and in the release notes).
- 2026-10-27 (1.6.1): a repository that already holds your backup is restored from, never written over by a fresh install.
- 2026-10-27 (1.6.0): fewer steps. The extension and setup both default to the `brain` branch (the "Branch: set this
  first" step is gone), setup takes every recommended answer with one Enter, Claude asks one question instead of two,
  opening GitHub's repository form counts as making it, and the Zoho page says what's next once it's green.
- 2026-10-27: one-line install and update (`update.sh`), the in-extension update notice, and the Updating section.

- 2026-10-26 (later): the Claude Code plugin is now the easiest way. It needs no settings edits, and Claude offers to link it.
- 2026-10-26: first version. The one-line installer, repository creation in setup, and the pre-filled token link are new.
  Before this, setup needed an existing repository, and the token page had to be filled in by hand.

# Connect the WorkPulse extension and Claude Code to one GitHub repository

Updated: 2026-10-26 (plugin)

For anyone setting up WorkPulse from scratch: install the extension, link it to a private GitHub repository,
and link Claude Code to the same repository, so that both read and write one shared Brain. It takes about 5 minutes.
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
| Release zip | Download `workpulse-extension-1.1.2-chrome.zip` from [the latest release](https://github.com/myind-ai/workpulse-extension/releases/latest) and unzip it. In `chrome://extensions`, switch on **Developer mode**, click **Load unpacked**, and pick the unzipped folder |
| From source | `git clone https://github.com/myind-ai/workpulse-extension && cd workpulse-extension/extension && npm install && npm run build`, then load `extension/.output/chrome-mv3` the same way |

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

The plugin brings the skill and both hooks (a brief at session start, an offer to record after a commit). You
don't edit any settings by hand. In the next session, Claude notices the Brain isn't linked and offers to link it,
or you can say it yourself:

```text
Link my WorkPulse Brain to you/workpulse-notes
```

Claude asks which repository to use, creates it as **private** if it doesn't exist, links this machine, and shows
you step 3 with your token link filled in. The extension's **Settings → Claude Code & the Brain** panel shows both
lines with your repository already filled in.

### Or: one terminal line (macOS / Linux), without the plugin

```bash
curl -fsSL https://raw.githubusercontent.com/myind-ai/workpulse-extension/main/install.sh | bash
```

With an existing repository, or a `brain` branch of one:

```bash
curl -fsSL https://raw.githubusercontent.com/myind-ai/workpulse-extension/main/install.sh | bash -s -- --repo you/workpulse-notes --branch brain
```

What it does, asking before each part:

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
node ~/workpulse-extension/cli/wp-brain.mjs setup --repo you/workpulse-notes --branch brain
```

## 3. Connect the extension

In Chrome, open WorkPulse → **Settings → Backup**:

1. **Branch**: the same one you gave setup (`brain`, or leave it empty for the default branch). Set this first.
2. **Make a token**: the button opens GitHub's token page with the name, **Contents: Read and write** and a 90-day expiry already filled in.
   You choose one thing: **Repository access → Only select repositories → your Brain repository**.
   Then click **Generate token**. The same pre-filled link is in setup's output:

   ```text
   https://github.com/settings/personal-access-tokens/new?name=WorkPulse+Brain&expires_in=90&contents=write
   ```

3. Paste the token, pick the repository, and press **Back up now**. The first backup only runs when you press it.

The token is stored only in the extension. Never put it in a repository, an `.env` file, a chat, or a Brain entry.

## 4. Check it

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

## What changed

- 2026-10-26 (later): the Claude Code plugin is now the easiest way. It needs no settings edits, and Claude offers to link it.
- 2026-10-26: first version. The one-line installer, repository creation in setup, and the pre-filled token link are new.
  Before this, setup needed an existing repository, and the token page had to be filled in by hand.

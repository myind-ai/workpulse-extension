# Where your learning lives

Updated: 2026-11-01
What it is for: which repository and database hold what, for anyone who installs WorkPulse, and how to move your learning to a repository of its own.
Related: [connect guide](connect-extension-and-claude-code.md)

## Nothing is shared between users

WorkPulse has no server and no shared database. The code is one repository; each person's data is in repositories that person owns.

| What | Where | Whose |
|---|---|---|
| The extension and CLI code | `myind-ai/workpulse-extension` (public) | The project. No user data ever goes here |
| Lessons, tickets, library text, config backup | `<you>/workpulse-notes`, branch `brain`, private | Yours, created by setup |
| Fast search over those lessons | `~/.workpulse/brain.db` | This computer. Rebuilt from the repository, so it needs no backup |
| Full session text, secrets masked | `~/.workpulse/memory/memory.db`, when session memory is on | This computer, and encrypted in the vault if you use one |
| Readable session Markdown | `~/Documents/claude-sessions`, when session memory is on | This computer |
| Videos and encrypted database backups (optional) | `<you>/workpulse-vault`, private, release assets | Yours, created by `wp-brain vault init` |

## How a new person gets their own repository

Install the plugin:

```
/plugin marketplace add myind-ai/workpulse-extension
/plugin install workpulse-brain@workpulse
```

In the next session Claude asks two things, or later with `/workpulse-brain:connect`:

| Question | Answers |
|---|---|
| How do you want to use it? | Lessons, skills and rules (recommended) · Lessons only · Everything, including searchable session text kept on this computer · Not now |
| Which private repository? | A new `<you>/workpulse-notes` (recommended) · A name you type |

Then it runs this, which works the same by hand:

```bash
wp-brain connect --repo workpulse-notes --use skills
```

- The repository is created private if it is missing, and a public one is refused.
- Your `~/.claude` skills and rules are stored. Files that look like they hold a secret are left out and named, and their values are never shown.
- Later changes to skills are stored with `wp-brain config backup`, or daily with `wp-brain backup schedule on`. A new computer runs `connect` with the same name, then `wp-brain config restore`.
- Asking for a different repository when one is already linked points you at `wp-brain move`, so the Brain never splits in two.

Extension only, with no terminal: Settings → Backup. Step 1 opens GitHub's new-repository page already filled in as private, step 2 makes a token for that one repository, and step 3 picks it.

Storing and fetching both go through your repository: the CLI through a clone, the extension through GitHub's API with your token. If both use the same repository and branch, they see each other's entries.

Public repositories: `init` and `setup` refuse one unless you pass `--allow-public`, `doctor` flags one, and the extension warns when you pick one.

## Moving your learning to its own repository

For anyone whose `brain` branch sits inside a code repository. `doctor` says so in its `Own repository` row.

```bash
node cli/wp-brain.mjs move you/workpulse-notes          # says what would happen, changes nothing
node cli/wp-brain.mjs move you/workpulse-notes --yes    # does it
```

- The whole history goes across, and the repository is created private if it is missing.
- A public target, or one whose privacy can't be checked, is refused.
- A target holding other data is refused. One holding only starter files (`bridge/SCHEMA.md`, README, LICENSE, `.gitignore`) is joined, with no force push.
- This computer switches only after GitHub shows the right commit. The old repository is never changed or deleted.

Then the extension needs pointing at the new repository, because until then it keeps writing to the old one. The command prints the steps. Afterwards this brings across what it wrote in between:

```bash
node cli/wp-brain.mjs move --catch-up
```

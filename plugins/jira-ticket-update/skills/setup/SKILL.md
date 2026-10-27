---
name: setup
description: One-question setup for the jira-ticket-update plugin. Detects the Jira site and the repo's ticket prefixes, guesses which real transition means started / PR opened / PR merged / on stage / done, shows it all once for a single yes, and saves it for the team (committed file) or just for the user. Can also make the repo offer the plugin to every teammate. Triggers on "set up jira ticket updates", "setup jira", "configure jira-ticket-update", "jira prefixes", "map jira statuses", "jira-ticket-update setup", and the plugin's own offer ("isn't set up here").
---

# Set up Jira ticket updates: one question

**Aim: the user answers one question.** Work everything else out yourself; ask only what you can't detect.
Nothing here writes to Jira: setup only reads it.

```bash
NUDGE="${CLAUDE_PLUGIN_ROOT:-$(dirname "$(ls -d ~/.claude/plugins/cache/*/jira-ticket-update/*/scripts 2>/dev/null | tail -1)")}/scripts/jira-nudge.mjs"
```

## 1. Gather silently (no questions)

1. `node "$NUDGE" config`: if the team file already has prefixes and moves, say "already set up for this team"
   and stop. A teammate only needs to sign in.
2. **Jira tools:** `ToolSearch "jira transition"`. If only `authenticate` tools exist, say in one line: *"Run `/mcp`,
   pick atlassian, sign in, then say 'set up jira ticket updates' again."* Then stop. Don't wait in a loop.
3. **Site:** `getAccessibleAtlassianResources`. With one site, take it. Ask only if there are several, and if so
   fold that into the single question below as its own question.
4. **Prefixes:** `node "$NUDGE" prefixes` (keys used by two or more tickets in commits and branches). If none,
   use the user's open tickets: `searchJiraIssuesUsingJql` `assignee = currentUser() AND statusCategory != Done`
   and take their project keys.
5. **Moves, per prefix (top 3):** take one recent ticket (`project = PAY ORDER BY updated DESC`, 1 result) and
   collect its `getTransitionsForJiraIssue` names. If that ticket is already far along the workflow, add one ticket
   in a To Do status so the early moves show up. Then run
   `node "$NUDGE" guess "Start Progress,Code Review,Ready for QA,Done,…"`, which returns the guessed mapping.

## 2. Ask once

One AskUserQuestion. Put the full proposal in the first option's `preview`:

```
Jira: https://yourco.atlassian.net
Prefixes: PAY (14 tickets), LEAP (3)

PAY   started → Start Progress · PR opened → Code Review · PR merged → Ready for QA · on stage → Ready for QA · done → Done
LEAP  started → In Progress · PR opened → In Review · done → Closed   (no QA step found)
```

Options:
- **Save for the team + offer the plugin to teammates (Recommended):** writes the team file *and* the repo's
  `.claude/settings.json` block (step 3), so anyone who opens the repo is offered the plugin, already set up.
- **Save for the team:** the team file only.
- **Just for me:** the personal file, with no repo changes.
- **Change something:** then ask only about the parts they name, using options from the real transition names.

## 3. Save (the script writes the JSON; never hand-edit it)

```bash
node "$NUDGE" save team '{"site":"https://yourco.atlassian.net","cloudId":"…","prefixes":["PAY","LEAP"],"projects":{"PAY":{"moves":{"started":"Start Progress","pr_opened":"Code Review","pr_merged":"Ready for QA","deployed_stage":"Ready for QA","done":"Done"}}}}'
# or: node "$NUDGE" save personal '…'
```

For **offer the plugin to teammates**, merge this into the repo's `.claude/settings.json` (create it if missing; keep
every key already there):

```json
{
  "extraKnownMarketplaces": {
    "workpulse": { "source": { "source": "github", "repo": "myind-ai/workpulse-extension" } }
  },
  "enabledPlugins": { "jira-ticket-update@workpulse": true }
}
```

This is the **project's** shared settings file (a repo file the user chose to change), not Claude's own user
settings. If the edit is refused, show the block and say where it goes.

## 4. Commit and finish

- Team choice: commit only the files you wrote, by path: `git add .claude/jira-ticket-update.json [.claude/settings.json]`
  → `git commit -m "chore: add Jira ticket-update settings"`. Push only if the user says so.
- Run `node "$NUDGE" config` and tell the user in one or two lines what happens next: *"Next PR on a PAY branch:
  I'll offer the comment and the move to Code Review."*
- Tell them what a teammate does: *"Teammates: open the repo, accept the plugin, then `/mcp` → atlassian → sign in."*

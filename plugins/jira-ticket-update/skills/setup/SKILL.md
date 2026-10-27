---
name: setup
description: One-time setup for the jira-ticket-update plugin in a repo or for a team. Signs in check, finds the Jira site, asks the ticket prefixes and which real Jira transition each event maps to, and writes the team file .claude/jira-ticket-update.json so teammates need no setup. Triggers on "set up jira ticket updates", "setup jira", "configure jira-ticket-update", "jira prefixes", "map jira statuses", "jira-ticket-update setup".
---

# Set up Jira ticket updates (once per team)

Aim: **one person sets it up once, everyone else installs the plugin and is done.** The team file is
committed in the repo, so a teammate's `git pull` brings the prefixes and status mapping.

```bash
NUDGE="${CLAUDE_PLUGIN_ROOT:-$(dirname "$(ls -d ~/.claude/plugins/cache/*/jira-ticket-update/*/scripts 2>/dev/null | tail -1)")}/scripts/jira-nudge.mjs"
node "$NUDGE" config     # what applies now, and the two file paths
```

## Steps

1. **Already set up?** If `config` shows a team file with prefixes and moves, say so and stop. A teammate needs
   nothing more than to sign in to the MCP.
2. **Jira tools.** `ToolSearch "jira transition"`. If only `authenticate` tools exist, ask the user to run
   `/mcp` → Atlassian → sign in, and wait.
3. **Site.** `getAccessibleAtlassianResources`. With one site, use it. With several, ask which one. Keep `site`
   (URL) and `cloudId`.
4. **Prefixes.** Suggest them from this repo's history: `git log --oneline -200 | grep -oE '\b[A-Z][A-Z0-9]+-[0-9]+' | cut -d- -f1 | sort | uniq -c | sort -rn | head`
   plus branch names. Confirm with one AskUserQuestion (multiSelect).
5. **Moves, per prefix.** Find one recent ticket of that prefix (`searchJiraIssuesUsingJql`
   `project = PAY ORDER BY updated DESC`, limit 1). Read its `getTransitionsForJiraIssue`, and also go through
   the workflow's statuses if the list from one status is short. Then ask with AskUserQuestion, using **only real
   transition names** as options: which one means **started**, **PR opened**, **PR merged**, **on stage**, **done**.
   Up to 4 questions per call; use two calls if needed. "Not used" is always an option.
6. **Write the files** (they're local; committing is the user's call):
   - Team: `<repo>/.claude/jira-ticket-update.json`
     ```json
     {
       "site": "https://yourco.atlassian.net",
       "cloudId": "…",
       "prefixes": ["PAY", "LEAP"],
       "projects": {
         "PAY": { "moves": { "started": "Start Progress", "pr_opened": "Code Review", "pr_merged": "Ready for QA", "deployed_stage": "Ready for QA", "done": "Done" }, "commentFooter": "" }
       }
     }
     ```
     No secrets go in this file: the cloudId and site are not credentials. Sign-in stays per person in `/mcp`.
   - Personal only (no repo, or the user doesn't want a team file): the `personal` path from `config`.
7. **Offer the team step:** "Commit `.claude/jira-ticket-update.json` so teammates get it?" If yes, commit
   only that file with `chore: add Jira ticket-update settings`. Push only if they say so.
8. **Check:** `node "$NUDGE" config` shows the prefixes and moves. Tell the user what will happen next time
   they open a PR.

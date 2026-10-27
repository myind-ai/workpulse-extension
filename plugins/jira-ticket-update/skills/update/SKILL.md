---
name: update
description: Keep Jira Cloud tickets true from Claude Code through the Atlassian MCP. Drafts a factual progress comment and the right status move, ASKS once per ticket, then comments and transitions. Runs when the user asks, or when this plugin's hook reports a commit, an opened or merged PR, or a session ending with unreported ticket work. Triggers on "update the ticket", "update jira", "comment on PAY-123", "move PAY-123 to review", "close the ticket", "mark it done in jira", "ticket status", "set the ticket to in progress", "post an update on the ticket", "what's the status of PAY-123", "sync jira", "A pull request was opened for", "A pull request was merged for", "Work this session touched Jira tickets".
---

# Update a Jira ticket (comment + status, ask first)

**The rule: Claude drafts, the user decides.** Never post a comment or change a status without a "yes" for
*that ticket* in this conversation. A yes for one ticket doesn't cover another. Writing to Jira is an
outward action, and this skill is how to ask for it, not a pre-authorisation.

The helper script (it never calls Jira):

```bash
NUDGE="${CLAUDE_PLUGIN_ROOT:-$(dirname "$(ls -d ~/.claude/plugins/cache/*/jira-ticket-update/*/scripts 2>/dev/null | tail -1)")}/scripts/jira-nudge.mjs"
node "$NUDGE" config      # settings that apply in this repo (team file over personal)
node "$NUDGE" list        # ticket events the hooks recorded
node "$NUDGE" clear KEY   # after updating, or when the user says not now
```

## 0. Ready?

- **Settings:** `node "$NUDGE" config`. **No setup is needed to start.** If this ticket's prefix has no moves, do
  step 3's *no mapping* path: guess, ask once, save. Don't send the user off to a separate setup first.
- **Jira tools:** `ToolSearch "jira transition"`. The server prefix varies: this plugin's `atlassian` server,
  the claude.ai Atlassian connector, or another install. Use whichever has the **real** tools. If you only find
  `authenticate` tools, tell the user to run `/mcp`, pick the Atlassian server and sign in, then carry on
  with other work.

| Purpose | Tool (Atlassian Rovo MCP; the prefix varies) |
|---|---|
| Site / cloudId | `getAccessibleAtlassianResources` |
| Read a ticket | `getJiraIssue` |
| Moves allowed from its status | `getTransitionsForJiraIssue` |
| Change status | `transitionJiraIssue` |
| Comment | `addCommentToJiraIssue` |

Every call needs the `cloudId` from settings. If it's missing, get it from `getAccessibleAtlassianResources`.

## When to run

| Trigger | What you see | Do |
|---|---|---|
| The user asks | "update the ticket", "move PAY-123 to review", "close it" | The flow for the named ticket(s) |
| PR opened or merged | context: *"A pull request was opened for PAY-123 …"* | The flow now, event `pr_opened` / `pr_merged` |
| End of session | Stop blocked: *"Work this session touched Jira tickets …"* | One AskUserQuestion covering those tickets (up to 4), then stop |
| Starting a ticket | "start PAY-123" | Offer `started` if it is still To Do |

Ticket key: from the user's words, else the commit message, else the branch (`feature/PAY-2433-…`). If you
can't find one, ask. Never guess.

## The flow

1. **Read** `getJiraIssue`: status, assignee, summary. If it is already at or past the target, say so and stop.
2. **Gather facts, never invent them:** `git log --oneline <base>..HEAD`, `gh pr view --json url,state,title`,
   tests that ran *in this session* and their result, stage links the user gave.
3. **Pick the move:** `projects.<PREFIX>.moves[event]` from the config. Events are `started`, `pr_opened`,
   `pr_merged`, `deployed_stage` and `done`. Check it against `getTransitionsForJiraIssue` **from the current
   status**. If it isn't available, offer the ones that are.
   **No mapping for this prefix yet:** run `node "$NUDGE" guess "<the transition names>"` and use the guess for this
   event in step 5's question (*"Comment + move to Code Review"*). After the user answers, save what they picked
   without asking again: `node "$NUDGE" save personal '{"prefixes":["PAY"],"projects":{"PAY":{"moves":{"pr_opened":"Code Review"}}}}'`.
   Then mention once: *"Say 'set up jira ticket updates' to save this for the whole team."*
4. **Draft the comment** (plus `commentFooter` from the config, if set):

   ```
   Update — <one line: what changed for the reviewer / tester>

   • PR: <url> (<open|merged>)
   • Commits: <n> — <2–3 most telling subjects>
   • Tested: <what ran and passed> | Not tested: <what didn't run>
   • Stage: <link, if any>
   • Next: <what happens next / who it waits on>
   ```

   Never include secrets, tokens, `.env` values, customer data, stack traces or source code. Write "tested"
   only for what ran. Never mention Claude or AI.
5. **Ask** with AskUserQuestion, showing the comment in `preview`. Options: **Comment + move to <status>**
   (recommended) · **Comment only** · **Move only** · **Not now** (→ `clear KEY`).
6. **Do it:** `addCommentToJiraIssue` first, then `transitionJiraIssue` with the transition **id**. Re-read with
   `getJiraIssue` and **report the status Jira now shows**.
7. **Close the loop:** `node "$NUDGE" clear KEY`.

## Gotchas

| Symptom | Cause | Fix |
|---|---|---|
| Only `authenticate` tools | Not signed in on this machine | `/mcp` → Atlassian → sign in |
| Two Atlassian servers in `/mcp` | You also have the claude.ai connector | Either works; disable one in `/mcp` if you want |
| Transition not in the list | The workflow only allows some moves from each status | Offer what's available. Two hops are two transitions, each needing a yes |
| Transition asks for fields (resolution, fix version) | A screen on the transition | Ask for the value; never fill defaults silently |
| Hook fires on `UTF-8` / `SHA-256` | Looks like a key | Set `prefixes` (setup) |
| Comment shows raw `*` / `•` | The MCP may expect Markdown or ADF | Check once on a test ticket and note it here |

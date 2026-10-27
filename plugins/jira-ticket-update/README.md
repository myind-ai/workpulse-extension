# Jira Ticket Update: a Claude Code plugin

Updated: 2026-10-27
Keeps Jira tickets true without remembering to. On a commit, an opened or merged PR, the end of a session,
or when you say "update the ticket", Claude drafts a factual comment and the right status move, **asks you
once**, then posts it through the Atlassian MCP.

**Full explainer** (the problem, flow diagrams, setup, settings, troubleshooting, FAQ):
[`docs/guides/jira-ticket-update-setup.md`](../../docs/guides/jira-ticket-update-setup.md)

## Install (each person: two commands and one sign-in)

```
/plugin marketplace add myind-ai/workpulse-extension
/plugin install jira-ticket-update@workpulse
```

On Claude Code 2.1.275 or later, one line does both:

```
/plugin install jira-ticket-update --marketplace myind-ai/workpulse-extension
```

Privacy: the plugin itself stores nothing remotely. Jira calls go through Atlassian's MCP server under your own
login ([Atlassian privacy policy](https://www.atlassian.com/legal/privacy-policy)).

**Says `Plugin "jira-ticket-update" not found in marketplace "workpulse"`?** Never added here: `/plugin marketplace add myind-ai/workpulse-extension`.
Added before this plugin existed: `/plugin marketplace update workpulse`. Then install again.

Then `/mcp` → **atlassian** → sign in with your Atlassian account (OAuth; no token to create or paste).
If you already use the claude.ai Atlassian connector, that works too.

That's it. Just work: in a repo that uses ticket keys, Claude offers the one-question setup itself, and at
your first PR it guesses the right status move and asks once. The hooks, the skills and the Atlassian MCP server
come with the plugin. Nothing goes in `settings.json` by hand.

## Team setup (one person, once)

When Claude offers setup (or you say **"set up jira ticket updates"**), it detects the site and prefixes, guesses
which real transition means *started / PR opened / PR merged / on stage / done*, and asks **one** question. The
recommended answer writes and commits `.claude/jira-ticket-update.json` plus the block below, so every teammate who
opens the repo is offered the plugin already set up and only signs in.

The block it adds to the repo's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "workpulse": { "source": { "source": "github", "repo": "myind-ai/workpulse-extension" } }
  },
  "enabledPlugins": { "jira-ticket-update@workpulse": true }
}
```

(Teammates are asked to trust the folder first, and then to install.)

## What it does and doesn't do

| Trigger | Result |
|---|---|
| "update the ticket" / "move PAY-123 to review" / "close it" | Draft, one question, then comment and move |
| `gh pr create` / `gh pr merge` on a ticket branch | Offered straight away |
| `git commit` on `feature/PAY-123-…` | Noted silently, offered at the end of the session |
| Session ends with ticket work not reported | One question for all of those tickets, asked once |

- Never writes to Jira without your yes for that ticket.
- Comments carry facts only (PR, commits, what was tested in that session, stage link, next step), never
  secrets, `.env` values, customer data, stack traces or code, and never a mention of AI.
- Moves only through transitions your workflow allows. After moving, it reads the ticket again and reports
  what Jira shows.

## Settings

| File | Who | Holds |
|---|---|---|
| `<repo>/.claude/jira-ticket-update.json` | team, committed | site, cloudId, prefixes, moves per prefix, comment footer |
| `${CLAUDE_PLUGIN_DATA}/config.json` | you | the same keys, for repos with no team file (the team file wins) |

`node "${CLAUDE_PLUGIN_ROOT}/scripts/jira-nudge.mjs" config` shows what applies in the current repo.

## Develop

```bash
node --test plugins/jira-ticket-update/scripts/jira-nudge.test.mjs
claude plugin validate plugins/jira-ticket-update
```

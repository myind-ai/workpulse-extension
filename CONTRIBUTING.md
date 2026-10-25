# Contributing

WorkPulse is a Chrome extension with no backend. Everything it knows lives in
`chrome.storage.local` on the machine it runs on, and the only network calls it
makes are to Zoho People (your own session) and, if you set it up, to the GitHub
repository you chose for backups.

## Running it

```bash
cd extension
npm install
npm run dev          # loads an unpacked build with hot reload
npm run check        # tsc --noEmit && vitest run — run this before a PR
npm run build        # a production build in .output/chrome-mv3
```

Load `extension/.output/chrome-mv3` through **chrome://extensions → Load
unpacked**. After pulling changes, press **Reload** there: an open dashboard page
talking to an older service worker is the cause of almost every
"WorkPulse needs reloading" message.

## How the code is arranged

| Directory | What belongs there |
|---|---|
| `extension/src/core/` | Pure decisions — no `chrome.*`, no storage, no fetch. Every rule worth arguing about lives here and has tests. |
| `extension/src/background/` | The engine and the commands. Reads the world, calls into `core/`, carries the answer out. |
| `extension/src/lib/` | The typed store, the Zoho client, the GitHub client. |
| `extension/src/entrypoints/` | The service worker, the widget, the dashboard, the content scripts. |
| `extension/src/ui/` | Components shared by the widget and the dashboard. |

**The rule that keeps this maintainable:** if a change contains a decision — when
to remind, what counts as a ticket key, whether a backup is owed — that decision
goes in `core/` with a test, and the surface calls it. Please don't put rules in
components.

## House style, enforced

Two rules about the interface are checked by `src/ui/house-style.test.ts`, so
breaking one fails `npm run check` with the file and the line:

- **A link goes somewhere; a button does something.** `<a>` is `.wp-link` — the
  text colour with a quiet underline on hover. `<button>` is `.wp-action` —
  never underlined, never the accent; on hover it gets a background, a border
  and a radius. Underlined blue means one thing to everyone who has ever used a
  browser, and a `<button>` that takes it is making a promise it does not keep.
- **An icon-only button has a `title`.** The tooltip is the only label it will
  ever have.

Both were written in `DESIGN.md` first and broken the week after, by the person
who wrote them. A rule that lives only in a document holds until somebody is
concentrating on something else — which is exactly when it matters. If you add a
rule to the design pattern, add its case to that test; a rule without one is a
suggestion.

## What a good pull request looks like

- `npm run check` passes.
- A new rule in `core/` comes with tests; a bug fix comes with the test that
  would have caught it.
- Test names start with `should`.
- No new dependency for something a few lines can do. There is deliberately no
  Markdown library, no editor framework and no timezone database in here.
- Nothing that reports usage anywhere. No telemetry, ever — that is the point of
  the thing.

## Reporting a bug

Say what you did, what happened and what you expected, and include the extension
version from `chrome://extensions`. **Never paste a Zoho session cookie, a
`conreqcsr` token, an employee id or a GitHub token into an issue** — redact them
first; a cURL from DevTools contains all of the above.

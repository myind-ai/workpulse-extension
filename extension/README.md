# WorkPulse — Chrome extension

Updated: 2026-10-11
What it is for: building, loading, testing and understanding the WorkPulse extension (phase 1).
Related: [the project README](../README.md) · [design and art slots](../DESIGN.md) · [contributing](../CONTRIBUTING.md)

## Load it in Chrome

```bash
cd extension
npm install
npm run build          # → .output/chrome-mv3/
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick `extension/.output/chrome-mv3/`.
3. **Connect Zoho** opens on first install: one-click links to Zoho, with a helper on Zoho's page that fills the client form and picks up the Client ID. Zoho is optional: reminders work without it. Shift and work days are in Settings.

The extension ID is pinned to `eipfgalnomnkdbehopenpiopogejenef` (manifest `key`; private key in `.secrets/`, gitignored), so the Zoho redirect URI never changes.

## Commands

```bash
npm test               # 51 unit and engine tests (Vitest)
npm run compile        # TypeScript, strict
npm run demo           # build, load into Chrome for Testing, run 23 behaviour checks, save screenshots
npm run dev            # WXT dev mode with reload
```

## How it is built

```
alarms (1 min) ─┐
idle / tabs ────┼─► background engine ── decide() (pure) ──► actions
                │        │                                 ├─ forced overlay (Shadow DOM, injected on demand)
popup / dashboard / overlay ── call() ──► commands         ├─ prompt window (fallback, reopens if closed)
                         │                                 ├─ notifications + badge
                         └─► store (chrome.storage.local) ─┴─ Zoho client (OAuth / Self Client, write guard)
```

| Folder | What lives there |
|---|---|
| `src/core/` | Pure logic ported from the desktop app's Rust core: IST time, rules, `decide()`, Zoho parsing and the write guard |
| `src/lib/` | Storage repository, Zoho client, tasks and timer, typed RPC |
| `src/background/` | Engine (tick → snapshot → actions), presenter (overlay and window), commands |
| `src/entrypoints/` | `background`, `overlay.content` (runtime-injected), `prompt`, `popup`, `dashboard` |
| `src/ui/` | Theme (one indigo accent, light/dark), the forced views, hooks |
| `scripts/demo.mjs` | The in-Chrome demo and behaviour checks |

Boilerplate copied from `openreply-agent-ext`: WXT + React + TypeScript + Vitest/happy-dom, `srcDir: 'src'`, a test-file entrypoint filter, and a pinned key.

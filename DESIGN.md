# WorkPulse — design pattern, and every picture the app wants

Two halves, and the second depends on the first:

1. **The design pattern** — the tokens, the components, the voice. Read this before drawing
   anything, because a picture that ignores it reads as a sticker someone pasted on.
2. **The pictures** — every slot in the app, what each one shows, its exact size and filename, and a
   prompt written to be pasted straight into an image/video model.

Everything here is taken from the code, not from a mood board: `src/ui/theme.css` is the source of
truth for tokens, and `src/ui/Art.tsx` is the component that renders the files.

---

# Part 1 — The design pattern

## The one rule the whole UI follows

**The screen interrupted you, so it owes you a short answer.** Every surface is built to be read in
a glance and answered in one click. Anything that cannot be answered in one click is a page, not a
card; anything that does not need answering is a line of muted text, not a banner.

Three consequences that show up everywhere in the code:

- **One question per surface.** The widget computes a single primary action (`core/focus.ts`) and
  puts everything else behind icons. A reminder card has one primary button.
- **One surface per thing.** A card and a notification never say the same thing at the same time
  (`Engine.note`). This was a real bug class, not a preference.
- **No surface forces a decision it can make itself.** Defaults are chosen, times are pre-filled,
  the standup is written. The user confirms; they do not assemble.

## The habit, and the line it does not cross

WorkPulse is only worth anything if it is used every day, and a thing used every
day needs the three parts of a habit: a **cue** you cannot miss, a **routine**
small enough to do without deciding, and a **reward** you can see.

| Part | Where it lives |
| --- | --- |
| Cue | The hourly card, and the badge on the toolbar icon — the only part of the app most people see most of the day |
| Routine | One tap. The likely answers are chips; Enter saves; typing a sentence is the fallback, not the requirement |
| Reward | The bar fills, the pip for today turns green, the run behind it grows |

**The rule about pressure: it has to be real or it is none.** Zoho locks a day
after a week. *"Tuesday is 3h short and locks on Friday"* is a fact with a date
on it, and that is the only deadline the app is allowed to lean on. A progress
bar dressed up as urgency, a countdown the app invented, a nag with no
consequence behind it — those train people to ignore the ones that matter.

**The rule about the streak: it counts the thing you want, not the thing we
want.** It counts *complete days* — a timesheet with no gaps — never days you
opened the app. You cannot earn one by clicking. And leave, holidays, weekends
and days off step over it rather than breaking it: being away is not a failure,
and a streak you lose on a beach is one that deserves to be ignored.

What this rules out, permanently: points, badges, confetti, levels, a tally of
days you were "good", comparisons with other people, and any sentence that
implies the app is disappointed. The number is yours and the only thing it is
measured against is your own contract.

## Voice

The app is written in the voice of **a colleague passing your desk**, not a coach, not a dashboard.

| Do | Don't |
| --- | --- |
| "Look away for 20 seconds" | "Time for your wellness break! 💪" |
| "17:58 – 18:30 · 32 minutes" | "You have unlogged time!" |
| "Nobody has shared anything yet." | "No data available" |
| "GitHub refused the token. Check it has not expired and was copied in full." | "Error 401" |
| "It didn't happen" as a real button | hiding the honest answer |

Rules:

- **Say what happened, then what to do.** Never one without the other.
- **Never claim about the user's health, mood or productivity.** The app knows you have been sitting
  still. It does not know you are tired.
- **Never gamify.** No streaks, no points, no confetti. The reward for logging an hour is a complete
  timesheet.
- **Rotate the wording, never the meaning.** Break lines, the footer credit and the sponsor line each
  have 4–5 variants (`core/health.ts`, `core/brand.ts`) so a line read a hundred times does not
  become furniture.
- **British spelling.** Colour, organise, labelled.

## Colour

One accent (indigo) on neutral greys. Tokens live on `.wp-root` so they work inside the overlay's
Shadow DOM as well as on extension pages.

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `--wp-accent` | `#4f46e5` | `#6366f1` | The one primary action, links that navigate, the logo |
| `--wp-accent-hover` | `#4338ca` | `#818cf8` | Hover on primary |
| `--wp-accent-soft` | `#eef2ff` | `rgba(99,102,241,.16)` | Focus ring, soft button, banner |
| `--wp-bg` | `#f8fafc` | `#0b0f19` | The page behind the cards |
| `--wp-surface` | `#ffffff` | `#111827` | Cards, inputs, menus |
| `--wp-surface-2` | `#f1f5f9` | `#1f2937` | Inset blocks, chips, hover |
| `--wp-border` | `#e2e8f0` | `#273244` | Every border and divider, 1px |
| `--wp-text` | `#0f172a` | `#e5e7eb` | Body |
| `--wp-muted` | `#64748b` | `#9ca3af` | Secondary text |
| `--wp-faint` | `#94a3b8` | `#6b7280` | Eyebrows |
| `--wp-ok` | `#15803d` | `#4ade80` | Done, confirmed |
| `--wp-warn` | `#b45309` | `#fbbf24` | Not logged, running short |
| `--wp-danger` | `#dc2626` | `#f87171` | Delete, refused, counts on the badge |

**Colour carries meaning, never decoration.** If a thing is not an action, not a state and not a
count, it is grey. There is exactly one accent on a screen: the thing to press.

The only exception is the footer heart, which changes hue on the hour and per page load
(`core/brand.ts`) — a deliberate, tiny piece of life in the one place that asks for nothing.

## Type

System font (`-apple-system, Segoe UI, system-ui`). Base 14px / 1.45. One scale, five sizes:

| Class | Size | Weight | Role |
| --- | --- | --- | --- |
| `.wp-eyebrow` | 11px | 600, uppercase, `.04em` | A label for the block under it. **Lower contrast than what it names, never bigger.** |
| `.wp-small` | 12px | — | Secondary lines, hints |
| body | 14px | — | Everything |
| `.wp-h2` | 14px | 620 | A section inside a page |
| `.wp-h1` / `.wp-title` | 19px | 640, `-.012em` | The page, or the card |
| `.wp-slot` / `.wp-big` | 26–28px | 640–650, tabular | A number that is the answer: minutes, the countdown |

Numbers always use `font-variant-numeric: tabular-nums` so a ticking countdown does not jitter.

## Space, radius, shadow

- **Stacks, not margins.** `.wp-stack` (12px gap) and `.wp-stack-sm` (6px) do all vertical rhythm;
  elements have no margins of their own.
- **Radius:** 12px cards, 16px the reminder modal, 9–10px controls, 999px chips.
- **One shadow,** and only on things that float: the modal, a menu, the search results.
  `0 24px 64px rgba(15,23,42,.22)`. Cards use a 1px border instead.
- **Reading width 760px.** About 90 characters; wider and the eye loses the line.

## Motion

Almost none, and all of it under 250ms:

- `wp-fade` 160ms — the backdrop arriving
- `wp-rise` 200ms — the modal, 8px up with a hair of scale
- 120ms on button background/border
- Every animation is inside `@media (prefers-reduced-motion: reduce)` and stops.

**Nothing in the app loops or pulses.** A moving thing in the corner of the eye is a cost paid all
day. This is why the GIFs matter so much and why they are so constrained: the illustration is the
*only* moving thing on the screen, and it only appears when a card has already interrupted you.

## Components

| Class | What it is | Note |
| --- | --- | --- |
| `.wp-card` | Surface, 1px border, 12px radius, 18/20 padding | The default container |
| `.wp-card-flat` | Inset block on `surface-2`, no border | A quote of your own data inside a card |
| `.wp-btn` | 36px, 9px radius, 550 weight | `-primary` (accent) · `-soft` (accent tint) · `-ghost` (bare) · `-sm` 30px · `-lg` 44px. Hover: border + a soft glow |
| `.wp-action` | A **text button**. Never underlined, never the link colour | On hover it becomes what it always was: a small button, with a border and a radius. `-danger` on the way in for deletes |
| `.wp-icon-btn` | Square icon action | Only for things used daily — everything else goes in the ⋯ menu |
| `.wp-menu` | ⋯ overflow menu, icon + name per row | Closes on outside click and Escape |
| `.wp-chip` | 24px pill | A fact, not a button: `PAY-2433 5h` |
| `.wp-banner` | Accent-tint strip | One sentence + one button, for a permission to grant |
| `.wp-fold` | `<details>` with a ▸ | Widget sections that grow. **Closed by default.** |
| `.wp-timeline` | Grid rows `96px / 1fr / auto` | The day, the team's day |
| `.wp-steps` | Numbered setup list, done/on/todo marks | Guided setup |
| `.wp-assure` | Muted inset list | What we promise before asking for a token |
| `.wp-art` | **The illustration slot** | Centred, `object-fit: cover`, 14px radius |

### Links versus actions — the rule, applied mechanically

**A link goes somewhere. An action does something.** They used to share a style,
so half the app turned blue and underlined itself on hover for things that were
not links at all — "delete this", "pick duplicates", "snooze". Underlined blue
means one thing to everyone who has ever used a browser, and the app was
breaking that promise seventy-two times over.

- `<a>` → `.wp-link` — text colour, a quiet underline on hover, accent only when
  it genuinely navigates
- `<button>` → `.wp-action` — no underline, ever; no accent, ever. Hover gives it
  a background, a border and a radius

Nothing is left to judgement: if it is a `<button>`, it is `.wp-action`.

**And nothing is left to memory either.** This rule was written down, and then
broken the following week by the person who wrote it — a rule that lives only in
a document holds until someone is concentrating on something else, which is
exactly when it matters. It is now a test:

```
src/ui/house-style.test.ts
  ✓ should never dress a button as a link
  ✓ should never dress a link as a button's text action
  ✓ should give every icon-only button something to say on hover
```

It reads the source the way a reviewer would and fails with the file, the line
and the offending tag. Adding a rule to this section means adding a case to that
file; a rule without one is a suggestion.

### Never a browser dialog

`confirm()` and `prompt()` are the browser's, not ours. They look like a
security warning from 2004, they cannot speak in the app's voice, and inside a
content script they freeze everything else the extension is doing until they are
answered. There are **none left in the app**.

The question is asked where the button was: one click turns the button into the
question, the answer is right there, Escape or Cancel puts it back
(`ui/Confirm.tsx`). Naming something is an inline field, never a `prompt()`.

And the best version of a confirmation is not asking: a token that can write to
exactly one repository has already answered "which repository?", so that dialog
was deleted rather than restyled.

### Icons

Inline SVG, 20×20 viewBox, `currentColor`, `stroke-width: 1.6`, round caps and joins, no fills.
Twenty of them in `src/ui/Icon.tsx`. **This is the line language the GIFs must match.**

### The logo

A 30×30 rounded square (8px radius) in `--wp-accent`, with a white pulse polyline across it:
`6,17 → 11,17 → 13,12 → 17,22 → 19,15 → 21,17 → 26,17`, stroke 2.4, round caps. A heartbeat that
is also a working day: flat, spike, flat.

## Surfaces, and their sizes

| Surface | Size | Notes |
| --- | --- | --- |
| Dashboard | 232px sidebar + 760px column | Footer on every page |
| Widget (toolbar popup) | **340px wide** | One primary action; folds for everything else |
| In-page overlay | Centred modal, max 560px, in a Shadow DOM | Drawn over whatever page you are on |
| Reminder window | **sized per card**: break 440×520 · meeting 460×560 · reminder 480×460 · check-in 520×560 · log 580×720 | Opens when Chrome is not in front |

An illustration therefore has to survive being drawn at **132px on a 440px window** and at **64px
beside a heading**. Detail below ~3px of line weight disappears.

## Accessibility, non-negotiable

Everything is reachable by keyboard; focus rings are a 3px `accent-soft` ring plus a 1px accent
border. Every icon-only button has `aria-label`. Colour is never the only signal — a state has a
word or an icon too. Cards stop keystrokes escaping into the page underneath, and hold focus once you
are typing in them.

---

# Part 2 — Every picture the app wants

## The rules every file must follow

1. **Loop seamlessly, 2–3 seconds.** The card is read for ten; a loop that visibly restarts is worse
   than a still image.
2. **Transparent background.** The card is `#ffffff` in light and `#111827` in dark. Anything baked
   to white will look like a pasted sticker in dark mode. If transparency is impossible, deliver two
   files: `name.gif` and `name-dark.gif`.
3. **Line art, 2–3px strokes, the WorkPulse icon language**: round caps, round joins, no fills, no
   gradients, no drop shadows.
4. **Two colours only** — `#4f46e5` (indigo, the subject) and a neutral grey that reads on both
   themes (`#94a3b8`). State colours only where the table says so: green `#15803d`, amber `#b45309`,
   red `#dc2626`.
5. **No text, no numbers, no letters.** The card says it, in the user's wording, and the wording
   rotates every time.
6. **No faces, no logos, no brands, no Zoho, no GitHub marks.** A figure is a simple silhouette.
7. **Under 200 KB.** The overlay loads these on whatever page you are on.
8. **Calm motion.** One idea per loop, ease-in-out, nothing bouncing or flashing. Never more than
   one element moving at a time.

## How to install one

Drop the file in `extension/public/art/`. That is all — `src/ui/Art.tsx` renders it if it exists and
renders nothing if it does not, so files can land one at a time and a missing file never shows a
broken image.

The **Wired** column says whether the slot is already in the UI or needs one line of code
(`<Art name="x" size={n} />`) added first.

---

## A. The break cards — square, 320×320, drawn at 132px

These are the most valuable: they are the only cards whose whole job is to get you to stop reading.

| File | Wired | Shows | Prompt |
| --- | --- | --- | --- |
| `eyes.gif` | ✅ | Eyes shifting from a near screen to a far window and back | *Minimal 2D line-art loop, 320×320, transparent background, 3px indigo `#4f46e5` and grey `#94a3b8` strokes, round caps, no fill, no text. A simple pair of eyes in the lower third looks at a small rectangle (a screen) close by, then the pupils and a thin sight-line shift up and to the right toward a large window shape with a horizon line in it, rest there, then return. 3 second seamless loop, ease-in-out, nothing else moves.* |
| `move.gif` | ✅ | A figure standing up from a desk and stretching | *Minimal 2D line-art loop, 320×320, transparent background, 3px indigo and grey strokes, round caps, no fill, no text, no face. A simple stick-figure silhouette sits at a desk (desk and chair in grey), then rises to standing and raises both arms into a stretch, holds, and the loop cuts cleanly back. Indigo for the figure, grey for the furniture. 3 second seamless loop.* |
| `water.gif` | ✅ | A glass filling, then a tick | *Minimal 2D line-art loop, 320×320, transparent background, 3px strokes, no fill except the water, no text. An empty outlined glass in grey `#94a3b8` fills smoothly from the bottom with flat indigo `#4f46e5` water to about three quarters, a small green `#15803d` tick appears beside it for half a second, then the glass empties downward and the loop restarts. 3 second seamless loop.* |
| `posture.gif` | ✅ | A slumped back straightening | *Minimal 2D line-art loop, 320×320, transparent background, 3px strokes, no fill, no text, no face. A side-on stick-figure silhouette sits slumped with a curved spine and shoulders up near the ears; the spine straightens into a clean vertical line and the shoulders drop; holds; loop cuts back. Spine in indigo, chair in grey. 3 second seamless loop.* |
| `breathe.gif` | ⬜ needs a line | A circle expanding and contracting on a 4-7-8 count | *Minimal 2D line-art loop, 320×320, transparent background, 3px indigo stroke, no fill, no text. A single thin circle outline expands over 4 seconds, holds its size, contracts slowly, and repeats — one unbroken breathing rhythm. A faint grey concentric ring marks the resting size. 10 second seamless loop.* |

## B. The reminder cards — 320×180, drawn at 64–120px

| File | Wired | Shows | Prompt |
| --- | --- | --- | --- |
| `meeting.gif` | ✅ | Yesterday's lines assembling into a note | *Minimal 2D line-art loop, 320×180, transparent background, 2px strokes, no text — use short horizontal bars as stand-in words. Four scattered small grey bars slide together and stack into a neat left-aligned list inside a rounded indigo-outlined card; a small indigo speech-bubble outline appears at the top right as the list completes. 3 second seamless loop, ease-in-out.* |
| `log.gif` | ⬜ | A gap on a timeline filling in | *Minimal 2D line-art loop, 320×180, transparent background, 2px strokes, no text. A horizontal timeline rail in grey `#94a3b8` has three filled indigo `#4f46e5` blocks on it and one empty gap outlined in amber `#b45309`; the gap fills with indigo from left to right, and the amber outline fades to indigo. 2.5 second seamless loop.* |
| `checkin.gif` | ⬜ | A clock reaching shift start, a tick landing | *Minimal 2D line-art loop, 320×180, transparent background, 2px strokes, no fill, no numerals on the clock face. A simple clock outline in grey has its minute hand sweep up to the top; as it arrives, a green `#15803d` tick draws itself beside the clock in two strokes. 2.5 second seamless loop.* |
| `wrapup.gif` | ⬜ | The day's entries stacking, then sent | *Minimal 2D line-art loop, 320×180, transparent background, 2px strokes, no text — short bars as stand-in rows. Five grey bars stack upward into a tidy block, the block outlines in indigo, then a small paper-plane outline lifts off it to the upper right and a green tick fades in where it was. 3 second seamless loop.* |
| `remind.gif` | ⬜ | A bell that rings once and settles | *Minimal 2D line-art loop, 320×180, transparent background, 2px indigo stroke, no fill, no text. A simple bell outline tilts left and right twice with two small arc marks either side, then settles still and the arcs fade. 2 second seamless loop with a long still tail.* |
| `focus.gif` | ⬜ | A block of quiet closing around one task | *Minimal 2D line-art loop, 320×180, transparent background, 2px strokes, no text. Several small grey shapes around the edges fade out one by one until a single indigo-outlined rounded rectangle is left in the centre, which draws a thin ring around itself. 3 second seamless loop.* |

## C. Empty states — 280×180, drawn at ~120px

These are the first thing a new user sees on each page, so they are the app's first impression.

| File | Wired | Where | Shows | Prompt |
| --- | --- | --- | --- | --- |
| `empty-links.gif` | ⬜ | Tickets & links, nothing saved | Loose tabs gathering into one labelled group | *Minimal 2D line-art loop, 280×180, transparent background, 2px strokes, no text. Four small grey browser-tab shapes scattered apart slide together and dock into a single rounded indigo-outlined container with a small tab label on top. 3 second seamless loop.* |
| `empty-journal.gif` | ⬜ | Learnings, nothing written | A line being written, then filed | *Minimal 2D line-art loop, 280×180, transparent background, 2px strokes, no legible text. A short indigo line draws itself left to right like handwriting on a grey card outline, then the card slides down into a stack of two others. 3 second seamless loop.* |
| `empty-today.gif` | ⬜ | Today, nothing logged yet | An empty day rail waiting | *Minimal 2D line-art loop, 280×180, transparent background, 2px strokes, no text. A long horizontal grey rail with faint tick marks; a small indigo caret travels slowly along it from left to right and fades at the end. 4 second seamless loop, very calm.* |
| `empty-tasks.gif` | ⬜ | Tasks, nothing open | A checklist with one box ticking | *Minimal 2D line-art loop, 280×180, transparent background, 2px strokes, no text — bars as stand-in words. Three grey rows each with an empty square; the top square draws a green `#15803d` tick and its bar goes grey and strikes through. 3 second seamless loop.* |
| `empty-team.gif` | ⬜ | Team, nobody has shared | Separate circles connecting through one shared box | *Minimal 2D line-art loop, 280×180, transparent background, 2px strokes, no faces, no text. Three simple grey circles at the edges each send a thin indigo line into a single rounded box in the centre; the lines draw in one after another and the box outline turns indigo. 3 second seamless loop.* |
| `empty-notes.gif` | ⬜ | Notes on a page, nothing to note | A pin landing on a page | *Minimal 2D line-art loop, 280×180, transparent background, 2px strokes, no text. A grey page outline; a small indigo pin drops from above, lands, and a thin ring pulses out from it once. 2.5 second seamless loop.* |

## D. The things that take a moment — 320×120

Shown while something is actually happening, so the loop is doing the waiting.

| File | Wired | Where | Shows | Prompt |
| --- | --- | --- | --- | --- |
| `backup.gif` | ⬜ | While the backup pushes | A day's data landing as a commit | *Minimal 2D line-art loop, 320×120, transparent background, 2px strokes, no text, no brand marks. Three small grey file shapes travel right along a thin line and merge into a single filled indigo dot sitting on a vertical rail of other grey dots. 2.5 second seamless loop.* |
| `push.gif` | ⬜ | While the timesheet pushes | Rows going into a form, one at a time | *Minimal 2D line-art loop, 320×120, transparent background, 2px strokes, no text — bars as stand-in rows. Four grey bars queue at the left and move one at a time into a rounded indigo-outlined frame at the right; each turns green `#15803d` as it lands. 3 second seamless loop.* |
| `reading.gif` | ⬜ | While a Zoho page is read | A page being scanned | *Minimal 2D line-art loop, 320×120, transparent background, 2px strokes, no text. A grey page outline with faint bars; a thin indigo horizontal scan line travels from top to bottom once, and the bars it passes turn indigo. 2 second seamless loop.* |

## E. Marketing — static PNG, 1280×800 for the store

Not GIFs: the Chrome Web Store wants stills, and the README wants two or three.

| File | Shows |
| --- | --- |
| `shot-today.png` | The Today page, a day half logged, one gap visible in amber |
| `shot-links.png` | Tickets & links with three tickets, one expanded with its labelled links |
| `shot-break.png` | A break card mid-countdown, over a blurred page |
| `shot-timesheet.png` | The timesheet push, showing the rows it will write |
| `shot-backup.png` | The backup repository's file tree on GitHub |
| `shot-team.png` | The team's day, three people, totalled by ticket |

Two **hero GIFs** for the README, 960×600, screen recordings rather than drawings:

| File | Shows |
| --- | --- |
| `hero-log.gif` | A card appears, one line is typed, the gap on the timeline closes |
| `hero-group.gif` | A ticket is opened and four tabs come back as one named Chrome group |

---

## Delivery checklist

- [ ] Transparent background, or a `-dark` twin
- [ ] Loops with no visible restart
- [ ] Legible at the small size in the table (squint test at 64px)
- [ ] Nothing moving but the subject
- [ ] No text, numerals, faces or brand marks
- [ ] Under 200 KB
- [ ] Dropped in `extension/public/art/` with the exact filename

Slots marked ⬜ need one line added where the card is drawn; the files can be made first and wired in
afterwards.

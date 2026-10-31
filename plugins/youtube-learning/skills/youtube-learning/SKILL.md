---
name: youtube-learning
description: Save a YouTube or Instagram video (reel, post, carousel), or one from another site yt-dlp reads, for learning and learn from it. Instagram also triggers on "get the caption", "subtitles of this reel", "video frames", "instagram login required". Downloads the video (720p mp4), subtitles (manual first, then the real auto captions, Whisper when there are none), a timestamped transcript grouped by chapter, thumbnail, description and metadata with yt-dlp into ~/Documents/youtube-learning/<date>_<title>_<id>/. Then writes notes.md (summary, key points with timestamp links, takeaways, try-next, terms) and records the takeaways in the WorkPulse Brain. Use when the user shares a YouTube link (youtube.com/watch, youtu.be, shorts, live, playlist), or says "save this video", "learn from this video", "download the video and subtitles", "get the transcript", "notes on this video", "summarise this YouTube video", "what did I save from YouTube". Also covers yt-dlp failures - "HTTP Error 403: Forbidden", "HTTP Error 429: Too Many Requests" on subtitles, "Sign in to confirm you're not a bot", no subtitles on a video.
---

# Video learning: link in, notes and learnings out

YouTube first, Instagram tested, and anything else yt-dlp reads. The name stays `youtube-learning` so installs,
the folder and Brain entries keep working.

Created 2026-10-29 (WorkPulse repo, `plugins/youtube-learning`). Status: see "Battle record".

## Core insight

**The transcript is the input; the notes are the learning.** Downloading is the easy half and the script
does all of it. The value is Claude reading the *whole* transcript and writing notes in its own words with
a timestamp link on every point, so the user can jump back to the exact moment, and then putting the
two-to-five lessons that matter into the Brain, where the next brief will surface them.

## Files

| File | What |
|---|---|
| `scripts/yt_learn.py` | `fetch URL… [--no-video] [--audio] [--max-height N] [--langs en,hi] [--speech-lang hi] [--frames [SEC]] [--root DIR] [--no-whisper] [--force] [--cookies-from-browser B]` · `frames FOLDER [--every N]` · `index` · `check`. Stdlib only, drives the `yt-dlp` CLI, one JSON line per video |
| `scripts/test_yt_learn.py` | Offline tests: `cd scripts && python3 -m unittest test_yt_learn` |
| `templates/notes.template.md` | The notes skeleton; created once per video, never overwritten |

`S=<this skill's directory>/scripts` below. Root: `~/Documents/youtube-learning` (env `YT_LEARN_ROOT`).

## The flow (do all of it without asking)

1. **Tools, once per session:** `python3 $S/yt_learn.py check`. If yt-dlp is more than ~60 days old, update it
   first (`yt-dlp -U`; a pip install: `python3 -m pip install -U "yt-dlp[default]"` with the Python that owns
   it; Homebrew: `brew upgrade yt-dlp`). An old yt-dlp is the usual cause of a 403.
2. **Fetch:** `python3 $S/yt_learn.py fetch "<url>" [more urls]`. Default: 720p video + everything else.
   - The user said transcript/notes only, or it's a talk/podcast where the picture adds nothing → `--no-video`.
   - Code, slides or diagrams on screen and they want to read them → `--max-height 1080`.
   - They want audio to listen to → `--audio`.
   - A non-English video: the video's own language is always added; add `--langs en,hi` for more.
   - A playlist URL fetches every video; for more than ~10, say how many and confirm first (it's large).
   Read each JSON line: `folder`, `transcript`, `words`, `subtitles.kind` (manual / auto / auto-translated /
   whisper), `video`, `problems`. Report every entry in `problems`, never drop it.
3. **Read the whole transcript** (`transcript.md`). Long videos: read it chapter by chapter in chunks, never
   skim the start and guess the rest. Check names, numbers and code against `description.md` and the
   chapter titles; auto captions mishear them ("serers side" = server-side, "Guido van rossom" = van Rossum).
4. **Write `notes.md`** in the folder, keeping the template's headings:
   - Delete the `<!-- status: pending … -->` line (the index then shows `done`).
   - *In one paragraph*: what the video teaches and for whom.
   - *Key points*: one bullet per idea, in order, each ending with its `[mm:ss](…&t=Ns)` link copied from
     transcript.md. Your own words; quote only a phrase (under ~15 words) when the wording itself matters.
   - *Takeaways I can use*: what changes how the user works; tie it to their projects when it fits.
   - *Try next*: concrete `- [ ]` actions. *Terms, tools and links*: the table. *Questions*: what was unclear
     or looked wrong, and what to verify.
   - `subtitles.kind` is auto/auto-translated/whisper → keep the transcript's warning in mind and say in
     *Questions* which terms were unclear.
5. **Record in the Brain** (pushing to `brain` is pre-authorised), 2–5 learnings, not one per bullet:
   ```bash
   WP="${WP_CLI:-$HOME/workpulse-extension/cli/wp-brain.mjs}"   # or wherever `wp-brain setup` installed it
   node $WP add learning "<the lesson as one line> #youtube #<topic>" --scope personal --project youtube-learning \
     --body "From \"<title>\" (<channel>) <url>&t=<N>s. Notes: <folder>/notes.md"
   ```
   Put each returned `[id]` under *Recorded in the Brain*. If wp-brain fails (no config, offline), keep going
   and say in the reply that the Brain was not updated.
6. **Index:** `python3 $S/yt_learn.py index` (fetch already does it; run it again after the notes so the row says `done`).
7. **Reply** with the folder path, the 3–5 key points (each with its timestamp link), what went to the Brain,
   and any problems. The full notes stay in the file.

**Getting the knowledge back when it's needed.** The Brain entries are the recall path, not the notes folder:
with the Brain's prompt-recall hook installed (`node $WP setup` → question 4, or the workpulse-brain plugin), a
later prompt like "write the reel script" brings the matching video lessons back by itself, with their timestamp
link and notes path. That only works if the learning's **title uses the words a future task will use**
("Open every script with Promise-Proof-Plan … #scripting"), not the video's own words ("3P formula"). Check with
`node $WP recall "<a task this should help>"`.

**"What did I save / learn about X?"** → read `~/Documents/youtube-learning/INDEX.md`, then `grep -ril "<x>"
~/Documents/youtube-learning/*/notes.md`, and `node $WP search "<x>" ` for the Brain side.

**Already fetched** (a folder ending `_<id>` exists): the script reuses it and fetches only what's missing;
`notes.md` is never overwritten. Update the notes instead of starting again; `--force` refetches files.

## Instagram and other platforms

| Platform | Tested 2026-10-31 (public links, no login, from India) | Time links |
|---|---|---|
| YouTube | Works: video, real subtitles, chapters | `&t=Ns` |
| Instagram reel, post, carousel | Works: video 720x1280, caption, Whisper subtitles; a carousel gets one folder per video | None: links open the post, so quote the mm:ss |
| Loom | Works: video, no subtitle tracks | None |
| Vimeo | Needs `--cookies-from-browser` (not tested with a login) | `#t=Ns` |
| TikTok | Blocked in India (`tiktok.com` redirects to `/about`), so untested; needs a VPN | None |
| Dailymotion, X, Facebook, LinkedIn | Only metadata checked on Dailymotion; rest not run. Try it and report `problems` | Dailymotion `?start=N` |

For an Instagram link, what you get:
- **Caption:** the JSON's `caption` and `description.md`. Read it first; many reels put the lesson there. It also replaces Instagram's useless "Video by <name>" title.
- **Subtitles:** Instagram exposes no subtitle tracks, so `subs/<id>.whisper.vtt` comes from Whisper. **Spoken Hindi or Marathi: pass `--speech-lang hi` (or `mr`)**; without it Whisper can write Hindi in Urdu script. The model matters as much: the script uses `large-v3-turbo` if it's in `~/.cache/whisper`, else `base`, which is unusable for Hindi. Tell the user if it fell back. It runs on CPU, so allow minutes per reel on a busy machine.
- **Video frames: only when the user asks** ("frames", "screenshots", "read the text on screen"): `--frames` (every 3 s) or `--frames 1`; on an already saved reel, `frames <folder>`. Then Read the jpgs in `frames/` and use what's on screen in the notes. If `problems` says "only N words of speech", don't extract by yourself: tell the user and offer it.
- **Private reel or "login required":** the JSON has a `hint`. Retry with `--cookies-from-browser chrome` (the user's own browser, on this machine); say first that this reads their Instagram login cookies.

## Gotchas

| Symptom | Cause | Fix |
|---|---|---|
| `ERROR: unable to download video data: HTTP Error 403: Forbidden` (subtitles still work) | yt-dlp too old for YouTube's current player (2026.02.04 failed on 2026-10-29) | Update yt-dlp (step 1), then `fetch … ` again; the folder is reused |
| `HTTP Error 429: Too Many Requests` on subtitles | `--sub-langs "en.*"` also matches every translation pair (`en-de`, `en-hi`, …) and YouTube rate-limits the burst | The script picks exact track keys from the metadata and sleeps 2 s between tracks; never pass a `.*` pattern |
| Auto captions read as gibberish in a non-English video | The `en` auto track of a Hindi/Marathi video is a machine *translation* | The real speech track is `<lang>-orig`; the script ranks it first and labels translations `auto-translated` |
| Every line appears two or three times in a raw .vtt | YouTube's rolling auto captions repeat the previous line in each cue | `parse_vtt` drops a line seen in the last three cues |
| `Sign in to confirm you're not a bot` | YouTube wants a signed-in session | Retry with `--cookies-from-browser chrome` (or safari/firefox): yt-dlp reads the user's own browser cookies locally. Never ask for or type a password |
| `no subtitles on this video` | Uploader disabled captions | The script runs Whisper (`large-v3-turbo` if downloaded, else `base`; env `YT_LEARN_WHISPER_MODEL` overrides) on the audio if `whisper` is installed; else `pip install -U openai-whisper` |
| One 429 left a video with no subtitles at all, and a rerun never retried (2026-10-29) | All tracks went in one yt-dlp call, and the Whisper file counted as "have subtitles" | Fixed: one call per track with 0/15/45 s retries; only that track's own file counts. Rerun `fetch` and it fills the gap |
| Whisper `base` on Hindi speech writes Urdu script mixed with garbled English, or only commas with `--language hi` | The base model is weak on Hindi. 10 s clip, 2026-10-31: `base` commas, `small` garbled (1448 s), `large-v3-turbo` nearly clean (199 s), under heavy load | Prefer YouTube's `hi-orig` track; if Whisper is the only source, use `large-v3-turbo` (the default when downloaded) with `--speech-lang hi` |
| A vertical reel saved at 322x572 | `height<=720` filtered on the long side | Fixed: `-S res:720` uses the shorter side, giving 720x1280 |
| `node --test scripts/` fails with no test output (Node 24) | `--test` with a directory isn't a file pattern | Name the file: `node --test scripts/yt-nudge.test.mjs` |

## Rules

- **Personal learning use.** Downloads stay on this machine. Never upload a video, a transcript or long quotes
  anywhere (Brain entries are one-line lessons in the user's words plus the link, not transcript text).
- Notes are written, not pasted: no transcript paragraphs copied into notes.md.
- Never type a password; cookies come only from the user's own browser, and only after a bot check.

## Battle record

- **2026-10-31, Instagram run for real:** public reel (video 720x1280, caption, Whisper subtitles, 5 frames opened and checked), 3-video carousel (3 folders). Not yet run through notes + Brain on a real Instagram lesson, and not with cookies.

- **2026-10-29, built and run for real** (yt-dlp 2026.02.04 → 2026.10.26, macOS, Python 3 stdlib):
  "Me at the zoo" (manual subs, 3 chapters, 720p mp4), "Python in 100 Seconds" (auto `en-orig`, 5 chapters,
  5.4 MB mp4), and the Whisper path (subtitles hidden, base model, 36 words in ~20 s). 11 offline tests +
  3 hook tests pass.
- **2026-10-29, first real request:** "Editing Psychology!" (0xCaseFiles, Hindi, 2:40). The first run hit a 429, so
  every subtitle track was lost and Whisper base gave Urdu-script gibberish. Fixed with a per-track retry; the rerun
  got `hi-orig` (512 words, clean Devanagari). Notes written in English, 3 Brain learnings, index `done`. 12 tests.

# Video Learning (`youtube-learning`): a Claude Code plugin

Updated: 2026-10-31
Share a YouTube or Instagram link (or another site yt-dlp reads; see the platform table in the skill) in Claude Code and it is saved for learning: the video, its subtitles, a timestamped
transcript, the thumbnail, description and metadata, then notes written from the whole transcript, with the
takeaways sent to the WorkPulse Brain. Skill: [`skills/youtube-learning/SKILL.md`](skills/youtube-learning/SKILL.md).

## Install

```
/plugin marketplace add myind-ai/workpulse-extension
/plugin install youtube-learning@workpulse
```

Already added the marketplace before this plugin existed? `/plugin marketplace update workpulse`, then install.

Needs `yt-dlp` (`brew install yt-dlp` or `pip install -U "yt-dlp[default]"`) and `ffmpeg`. Optional: `deno`
(yt-dlp's JavaScript runtime for YouTube) and `openai-whisper` (transcribes videos without subtitles).
Check with:

```
python3 skills/youtube-learning/scripts/yt_learn.py check
```

## Use

Paste a link: `https://youtu.be/…`, `https://www.instagram.com/reel/…`. The plugin's hook notices it and Claude runs the skill. Or say "save this
video", "notes on this video", "transcript only for …", "get the frames too", "what did I save about X?".

Each video gets one folder under `~/Documents/youtube-learning/` (env `YT_LEARN_ROOT`):

| File | What |
|---|---|
| `notes.md` | Summary, key points with timestamp links, takeaways, try-next, terms, questions, Brain ids |
| `transcript.md` / `transcript.txt` | Timestamped paragraphs by chapter / plain text |
| `subs/*.vtt` | The subtitle tracks (manual first, then the real auto captions, else Whisper) |
| `video.mp4` | 720p by default (`--no-video`, `--max-height 1080`) |
| `frames/*.jpg` | Stills, only when asked (`--frames`) |
| `thumbnail.jpg`, `description.md` (the Instagram caption), `meta.json` | The rest |

`INDEX.md` at the root lists every video, newest first, with whether its notes are done.

## What it does and doesn't do

| Does | Doesn't |
|---|---|
| Hook adds one line of context when a message has a video link | Download anything by itself: Claude runs the script |
| Keeps everything on this machine | Upload videos or transcripts anywhere |
| Sends 2–5 one-line lessons + the link to your Brain (`wp-brain`) | Put transcript text in the Brain |
| Uses your browser's cookies only with `--cookies-from-browser`, after a bot check | Ask for or type a password |

## Tests

```
node --test scripts/yt-nudge.test.mjs
cd skills/youtube-learning/scripts && python3 -m unittest test_yt_learn
```

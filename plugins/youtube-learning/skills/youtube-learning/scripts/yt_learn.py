#!/usr/bin/env python3
"""Save a video for learning (YouTube, Instagram, TikTok, anything yt-dlp reads): video,
subtitles, transcript, metadata, notes.

    yt_learn.py fetch URL [URL ...] [--no-video] [--audio] [--max-height 720]
                                    [--langs en] [--root DIR] [--no-whisper] [--force]
                                    [--cookies-from-browser chrome] [--frames [SEC]] [--speech-lang hi]
    yt_learn.py frames FOLDER [--every 3] stills from video.mp4 into frames/, for on-screen text
    yt_learn.py index [--root DIR]        rebuild INDEX.md from every video folder
    yt_learn.py check                     yt-dlp / ffmpeg / deno / whisper present and how old

One folder per video under the root (default ~/Documents/youtube-learning):

    <upload-date>_<title-slug>_<id>/
        meta.json        trimmed metadata (title, channel, chapters, tags, which subtitles)
        description.md   the uploader's description
        subs/            the .vtt tracks that were downloaded
        transcript.md    timestamped paragraphs, grouped by chapter, each time a link
        transcript.txt   plain text, for grep and for reading in one go
        thumbnail.jpg
        video.mp4        unless --no-video (<= --max-height, default 720)
        notes.md         the learning notes; created once from a template, never overwritten

Stdlib only; drives the yt-dlp CLI. A folder that already exists for the same id is
reused and only missing pieces are fetched (--force refetches). Prints one JSON line
per video so the caller can read where everything went.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(os.environ.get("YT_LEARN_ROOT", "~/Documents/youtube-learning")).expanduser()
HERE = Path(__file__).resolve().parent
TEMPLATE = HERE.parent / "templates" / "notes.template.md"
PARAGRAPH_SEC = 60
EXTRA: list[str] = []  # global yt-dlp options from the command line (e.g. cookies)
SPEECH_LANG: str | None = None  # what the video speaks, for Whisper; Instagram and TikTok don't say
KEEP = ("id", "title", "channel", "uploader", "channel_url", "upload_date", "duration",
        "duration_string", "view_count", "like_count", "language", "tags", "categories",
        "chapters", "webpage_url", "playlist_title", "extractor_key")
LOW_SPEECH_WORDS = 30
GENERIC_TITLE = re.compile(r"^(video|post|reel) by ", re.I)
NEEDS_LOGIN = re.compile(r"log(ged)?[ -]?in|sign in|cookies|rate.?limit|private|not a bot", re.I)


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #
def slugify(text: str, max_len: int = 60) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")
    return slug[:max_len].rstrip("-") or "video"


def hms(sec: float) -> str:
    sec = int(sec)
    h, m, s = sec // 3600, sec % 3600 // 60, sec % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def at(info: dict, sec: float) -> str:
    """A link to this moment. Platforms with no time links (Instagram, TikTok…) get the post itself."""
    url, s = info.get("webpage_url") or "", int(sec)
    site = (info.get("extractor_key") or "").lower()
    if site.startswith("youtube"):
        return f"https://www.youtube.com/watch?v={info['id']}&t={s}s"
    if site.startswith("vimeo"):
        return f"{url}#t={s}s"
    if site.startswith("dailymotion"):
        return f"{url}?start={s}"
    return url


def better_title(info: dict) -> str:
    """Instagram calls every reel "Video by <name>"; the caption's first line says what it is."""
    title = info.get("title") or info["id"]
    if GENERIC_TITLE.match(title):
        first = next((x.strip() for x in (info.get("description") or "").splitlines() if x.strip()), "")
        return first[:80] or title
    return title


def length(info: dict) -> str:
    return hms(info["duration"]) if info.get("duration") else ""


def folder_name(info: dict) -> str:
    d = info.get("upload_date") or ""
    date = f"{d[:4]}-{d[4:6]}-{d[6:]}" if len(d) == 8 else "undated"
    return f"{date}_{slugify(info.get('title', ''))}_{info['id']}"


def find_existing(root: Path, video_id: str) -> Path | None:
    hits = [p for p in root.glob(f"*_{video_id}") if p.is_dir()] if root.exists() else []
    return hits[0] if hits else None


def ytdlp(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    exe = shutil.which("yt-dlp")
    if not exe:
        sys.exit("yt-dlp not found. Install: brew install yt-dlp  (or pip install -U yt-dlp)")
    return subprocess.run([exe, "--no-warnings", *EXTRA, *args], capture_output=True, text=True,
                          check=check)


# --------------------------------------------------------------------------- #
# Subtitles: choose tracks, parse VTT
# --------------------------------------------------------------------------- #
def _match(tracks: dict, lang: str) -> str | None:
    """Exact key first, then a regional variant (en-US, en-GB), never a translation pair."""
    if lang in tracks:
        return lang
    for key in sorted(tracks):
        if re.fullmatch(rf"{re.escape(lang)}-[A-Z]{{2}}|{re.escape(lang)}-[A-Z][a-z]{{3}}", key):
            return key
    return None


def choose_subs(info: dict, langs: list[str]) -> list[dict]:
    """Return the tracks to download, best first: [{key, lang, kind}].

    Manual tracks beat auto-generated ones. For auto captions the real speech
    recognition is `<orig>-orig` (or plain `<orig>`); any other language in
    automatic_captions is a machine translation, labelled as such.
    """
    manual = info.get("subtitles") or {}
    manual = {k: v for k, v in manual.items() if k != "live_chat"}
    auto = info.get("automatic_captions") or {}
    orig = (info.get("language") or "").split("-")[0] or None
    if orig is None:
        orig = next((k[:-5] for k in auto if k.endswith("-orig")), None)

    wanted = list(dict.fromkeys([*langs, *([orig] if orig else [])]))
    picked: list[dict] = []
    for lang in wanted:
        if key := _match(manual, lang):
            picked.append({"key": key, "lang": lang, "kind": "manual"})
            continue
        for key in (f"{lang}-orig", lang):
            if key in auto:
                kind = "auto" if lang == orig else "auto-translated"
                picked.append({"key": key, "lang": lang, "kind": kind})
                break
    rank = {"manual": 0, "auto": 1, "auto-translated": 2}
    return sorted(picked, key=lambda t: rank[t["kind"]])


TIMING = re.compile(r"^(\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}\s+-->")
TAG = re.compile(r"<[^>]+>")


def _seconds(stamp: str) -> float:
    parts = stamp.replace(",", ".").split(":")
    parts = [0.0] * (3 - len(parts)) + [float(p) for p in parts]
    return parts[0] * 3600 + parts[1] * 60 + parts[2]


def parse_vtt(text: str) -> list[tuple[float, str]]:
    """Cues as (start_seconds, line), with YouTube's rolling duplicate lines removed."""
    cues: list[tuple[float, str]] = []
    start = 0.0
    seen_recent: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if TIMING.match(line):
            start = _seconds(line.split("-->")[0].strip())
            continue
        if (not line or line.startswith(("WEBVTT", "Kind:", "Language:", "NOTE", "STYLE"))
                or line.isdigit()):
            continue
        line = TAG.sub("", line).replace("&nbsp;", " ").replace("&amp;", "&").strip()
        line = re.sub(r"\s+", " ", line)
        if not line or line in seen_recent:
            continue
        cues.append((start, line))
        seen_recent = (seen_recent + [line])[-3:]
    return cues


def paragraphs(cues: list[tuple[float, str]], chapters: list[dict] | None,
               every: int = PARAGRAPH_SEC) -> list[dict]:
    """Group cues into ~`every`-second paragraphs that never cross a chapter start."""
    bounds = [float(c.get("start_time", 0)) for c in (chapters or [])][1:]
    out: list[dict] = []
    for start, line in cues:
        chapter_break = any(out and out[-1]["start"] < b <= start for b in bounds)
        if not out or chapter_break or start - out[-1]["start"] >= every:
            out.append({"start": start, "text": line})
        else:
            out[-1]["text"] += " " + line
    return out


def render_transcript(info: dict, track: dict, paras: list[dict]) -> str:
    chapters = info.get("chapters") or []
    head = [f"# Transcript: {info.get('title')}", "",
            f"Source: {info.get('webpage_url')} · {info.get('channel') or info.get('uploader')}"
            f" · {length(info)} · subtitles: {track['key']} ({track['kind']})",
            ""]
    if track["kind"] != "manual":
        head += ["> Machine-generated captions: names, numbers and code may be misheard. "
                 "Check against the video before quoting.", ""]
    body: list[str] = []
    ci = 0
    for p in paras:
        while ci < len(chapters) and float(chapters[ci].get("start_time", 0)) <= p["start"]:
            c = chapters[ci]
            body += [f"## {c.get('title')} · [{hms(c['start_time'])}]({at(info, c['start_time'])})", ""]
            ci += 1
        body += [f"[{hms(p['start'])}]({at(info, p['start'])}) {p['text']}", ""]
    return "\n".join(head + body)


# --------------------------------------------------------------------------- #
# Fetch one video
# --------------------------------------------------------------------------- #
def expand(url: str) -> list[str]:
    """A playlist URL becomes its video URLs; a video URL (even one inside a playlist) stays itself."""
    if re.search(r"watch\?v=|youtu\.be/|/shorts/|/live/", url) or "list=" not in url:
        return [url]
    data = json.loads(ytdlp("--flat-playlist", "-J", url).stdout)
    return [e.get("url") or f"https://www.youtube.com/watch?v={e['id']}"
            for e in data.get("entries") or [] if e]


def fetch(url: str, *opts) -> list[dict]:
    """One result per video: an Instagram carousel is one URL holding several."""
    info = json.loads(ytdlp("-J", "--no-playlist", url).stdout)
    parts = [e for e in info.get("entries") or [] if e]
    if not parts:
        return [save(info, *opts)]
    results = []
    for n, part in enumerate(parts, 1):
        part = {**{k: info[k] for k in ("description", "uploader", "channel", "webpage_url") if info.get(k)}, **part}
        part["title"] = f"{better_title(part)} (part {n} of {len(parts)})"
        results.append(save(part, *opts))
    return results


def save(info: dict, root: Path, langs: list[str], video: bool, audio: bool,
         max_height: int, whisper: bool, force: bool, frames_every: int | None = None) -> dict:
    if SPEECH_LANG:
        info["language"] = SPEECH_LANG
    info["title"] = better_title(info)
    folder = find_existing(root, info["id"]) or root / folder_name(info)
    (folder / "subs").mkdir(parents=True, exist_ok=True)
    info_file = folder / ".info.json"  # full dump, reused by the calls below, deleted at the end
    info_file.write_text(json.dumps(info))
    base = ["--load-info-json", str(info_file), "-P", str(folder)]
    problems: list[str] = []

    tracks = choose_subs(info, langs)
    problems += download_subs(base, folder, info["id"], tracks, force)
    if force or not (folder / "thumbnail.jpg").exists():
        ytdlp(*base, "--skip-download", "--write-thumbnail", "--convert-thumbnails", "jpg",
              "-o", "thumbnail:thumbnail.%(ext)s", check=False)

    want_video = (video or frames_every) and (force or not list(folder.glob("video.*")))
    if want_video:
        # res = the shorter side, so a vertical reel gets 720x1280, not 405x720.
        r = ytdlp(*base, "-f", "bv*+ba/b", "-S", f"res:{max_height},ext:mp4:m4a",
                  "--merge-output-format", "mp4", "-o", "video.%(ext)s", check=False)
        if r.returncode:
            problems.append("video download failed: " + r.stderr.strip().splitlines()[-1][:200])

    # Pick the transcript source: the best downloaded track, else Whisper on the audio.
    track, vtt = None, None
    for t in tracks:
        hit = folder / "subs" / f"{info['id']}.{t['key']}.vtt"
        if hit.exists():
            track, vtt = t, hit
            break
    whisper_vtt = folder / "subs" / f"{info['id']}.whisper.vtt"
    if vtt is None and whisper_vtt.exists():
        track, vtt = {"key": "whisper", "lang": "?", "kind": "whisper"}, whisper_vtt
    if vtt is None and whisper and shutil.which("whisper"):
        track, vtt = transcribe(folder, info, base, whisper_vtt), whisper_vtt
        if not whisper_vtt.exists():
            track, vtt = None, None
    need_audio = audio and not list(folder.glob("audio.*"))
    if need_audio:
        ytdlp(*base, "-f", "ba[ext=m4a]/ba", "-o", "audio.%(ext)s", check=False)

    if not info.get("duration"):
        info["duration"] = media_seconds(folder)

    words = 0
    if vtt:
        cues = parse_vtt(vtt.read_text(encoding="utf-8", errors="ignore"))
        paras = paragraphs(cues, info.get("chapters"))
        (folder / "transcript.md").write_text(render_transcript(info, track, paras), encoding="utf-8")
        plain = " ".join(line for _, line in cues)
        (folder / "transcript.txt").write_text(plain + "\n", encoding="utf-8")
        words = len(plain.split())
        if words < LOW_SPEECH_WORDS:
            problems.append(f"only {words} words of speech (music or on-screen text?): the transcript may be "
                            "wrong; read description.md and run `frames` on the folder")
    else:
        problems.append("no subtitles on this video" + ("" if whisper and shutil.which("whisper")
                     else "; install openai-whisper (pip install -U openai-whisper) to transcribe"))

    (folder / "description.md").write_text(
        f"# Description: {info.get('title')}\n\n{info.get('description') or '(none)'}\n",
        encoding="utf-8")
    meta = {k: info.get(k) for k in KEEP}
    meta.update(saved_at=dt.date.today().isoformat(), subtitles=track, words=words,
                video=next((p.name for p in folder.glob("video.*")), None),
                available_subs={"manual": sorted((info.get("subtitles") or {}).keys()),
                                "auto_orig": sorted(k for k in (info.get("automatic_captions") or {})
                                                    if k.endswith("-orig"))})
    (folder / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
    write_notes_template(folder, info, meta)
    info_file.unlink(missing_ok=True)
    stills = frames(folder, frames_every) if frames_every else None
    return {"id": info["id"], "title": info.get("title"), "folder": str(folder),
            "caption": (info.get("description") or "")[:500], "frames": stills,
            "transcript": str(folder / "transcript.md") if vtt else None, "words": words,
            "subtitles": track, "video": meta["video"], "chapters": len(info.get("chapters") or []),
            "duration": length(info), "notes": notes_status(folder / "notes.md"),
            "problems": problems}


def download_subs(base: list[str], folder: Path, video_id: str, tracks: list[dict],
                  force: bool, waits: tuple[int, ...] = (0, 15, 45)) -> list[str]:
    """One yt-dlp call per track, retried with a growing pause, so one HTTP 429 doesn't sink the rest.

    Only that track's own file counts as done: a Whisper transcript never stops a retry.
    """
    problems = []
    for t in tracks:
        dest = folder / "subs" / f"{video_id}.{t['key']}.vtt"
        if dest.exists() and not force:
            continue
        err = ""
        for wait in waits:
            time.sleep(wait)
            r = ytdlp(*base, "--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", t["key"],
                      "--sub-format", "vtt", "-o", "subtitle:subs/%(id)s.%(ext)s", check=False)
            if dest.exists():
                break
            err = (r.stderr.strip().splitlines() or ["no file written"])[-1][:200]
        else:
            problems.append(f"subtitle track {t['key']} ({t['kind']}) failed: {err}")
    return problems


def media_seconds(folder: Path) -> float | None:
    """Some platforms give no duration; ask the downloaded file."""
    media = next((p for p in [*folder.glob("video.*"), *folder.glob("audio.*")]), None)
    if not media or not shutil.which("ffprobe"):
        return None
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(media)],
                       capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return None


def frames(folder: Path, every: int) -> dict:
    """Stills for reading on-screen text: many reels teach with captions burned in, not speech."""
    video = next(iter(folder.glob("video.*")), None)
    if not video:
        return {"folder": str(folder), "error": "no video file: fetch it without --no-video first"}
    out = folder / "frames"
    out.mkdir(exist_ok=True)
    for old in out.glob("*.jpg"):
        old.unlink()
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(video), "-vf", f"fps=1/{every}", "-q:v", "3",
                    str(out / "%04d.jpg")], check=True)
    return {"folder": str(out), "frames": len(list(out.glob("*.jpg"))), "every_sec": every}


def whisper_model() -> str:
    """large-v3-turbo if already downloaded: on Hindi it was clean and 7x faster than small; base gave nothing."""
    if env := os.environ.get("YT_LEARN_WHISPER_MODEL"):
        return env
    cached = Path("~/.cache/whisper/large-v3-turbo.pt").expanduser().exists()
    return "large-v3-turbo" if cached else "base"


def transcribe(folder: Path, info: dict, base: list[str], out: Path) -> dict:
    """No subtitles anywhere: download the audio and run Whisper on it."""
    ytdlp(*base, "-f", "ba[ext=m4a]/ba", "-o", "audio.%(ext)s", check=False)
    audio = next(iter(folder.glob("audio.*")), None)
    if audio:
        model = whisper_model()
        args = ["whisper", str(audio), "--model", model, "--output_format", "vtt",
                "--output_dir", str(folder / "subs")]
        if info.get("language"):
            args += ["--language", info["language"].split("-")[0]]
        subprocess.run(args, capture_output=True, text=True)
        made = folder / "subs" / f"{audio.stem}.vtt"
        if made.exists():
            made.rename(out)
    return {"key": "whisper", "lang": info.get("language") or "?", "kind": "whisper"}


# --------------------------------------------------------------------------- #
# Notes and index
# --------------------------------------------------------------------------- #
STATUS = re.compile(r"<!--\s*status:\s*(\w+)")


def notes_status(path: Path) -> str:
    if not path.exists():
        return "missing"
    m = STATUS.search(path.read_text(encoding="utf-8", errors="ignore"))
    return m.group(1) if m else "done"


def write_notes_template(folder: Path, info: dict, meta: dict) -> None:
    path = folder / "notes.md"
    if path.exists():
        return
    tpl = TEMPLATE.read_text(encoding="utf-8")
    fill = {"title": info.get("title") or info["id"], "today": dt.date.today().isoformat(),
            "url": info.get("webpage_url") or "", "channel": info.get("channel") or info.get("uploader") or "",
            "duration": length(info), "video": meta.get("video") or "not downloaded",
            "subs": (meta.get("subtitles") or {}).get("kind", "none")}
    for k, v in fill.items():
        tpl = tpl.replace("{{" + k + "}}", str(v))
    path.write_text(tpl, encoding="utf-8")


def build_index(root: Path) -> Path:
    rows = []
    for meta_file in sorted(root.glob("*/meta.json")):
        m = json.loads(meta_file.read_text(encoding="utf-8"))
        rel = meta_file.parent.name
        title = (m.get("title") or m["id"]).replace("|", "/")
        rows.append((m.get("saved_at", ""), f"| {m.get('saved_at', '')} | [{title}]({rel}/notes.md) | "
                     f"{(m.get('channel') or m.get('uploader') or '').replace('|', '/')} | {length(m)} | "
                     f"{(m.get('subtitles') or {}).get('kind', 'none')} | "
                     f"{notes_status(meta_file.parent / 'notes.md')} | {'yes' if m.get('video') else 'no'} |"))
    rows.sort(key=lambda r: r[0], reverse=True)
    text = ["# Video learning", "", f"Updated: {dt.date.today().isoformat()}",
            "Every video saved for learning, newest first. Each row opens that video's notes; "
            "the folder also holds the transcript, subtitles and video. Rebuilt by `yt_learn.py index`.",
            "", "| Saved | Video | Channel | Length | Subtitles | Notes | Video file |",
            "|---|---|---|---|---|---|---|", *[r[1] for r in rows], ""]
    out = root / "INDEX.md"
    root.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(text), encoding="utf-8")
    return out


def check() -> int:
    ok = True
    for tool, why in (("yt-dlp", "required"), ("ffmpeg", "merges video+audio, converts thumbnails"),
                      ("deno", "yt-dlp's JavaScript runtime for YouTube"),
                      ("whisper", "optional: transcribes videos that have no subtitles")):
        path = shutil.which(tool)
        print(f"{'ok ' if path else '-- '} {tool:8} {path or 'missing'}  ({why})")
        ok &= bool(path) or tool in ("whisper", "deno")
    if shutil.which("yt-dlp"):
        ver = ytdlp("--version").stdout.strip()
        try:
            age = (dt.date.today() - dt.date(*map(int, ver.split(".")[:3]))).days
        except ValueError:
            age = 0
        hint = "  -> update it: yt-dlp -U (or pip install -U yt-dlp / brew upgrade yt-dlp)" if age > 60 else ""
        print(f"    yt-dlp version {ver}, {age} days old{hint}")
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch")
    f.add_argument("urls", nargs="+")
    f.add_argument("--root", type=Path, default=ROOT)
    f.add_argument("--langs", default="en", help="comma list; the video's own language is always added")
    f.add_argument("--no-video", action="store_true")
    f.add_argument("--audio", action="store_true")
    f.add_argument("--max-height", type=int, default=720)
    f.add_argument("--no-whisper", action="store_true")
    f.add_argument("--force", action="store_true")
    f.add_argument("--speech-lang", metavar="LANG",
                   help="language spoken, for Whisper (hi, mr, en…): keeps Hindi in Devanagari, not Urdu script")
    f.add_argument("--frames", nargs="?", type=int, const=3, metavar="SEC",
                   help="also save a still every SEC seconds (default 3), only when asked for")
    f.add_argument("--cookies-from-browser", metavar="BROWSER",
                   help="chrome, safari, firefox…: only when the site asks to log in / confirm not a bot")
    i = sub.add_parser("index")
    i.add_argument("--root", type=Path, default=ROOT)
    sub.add_parser("check")
    s = sub.add_parser("frames")
    s.add_argument("folder", type=Path)
    s.add_argument("--every", type=int, default=3, help="seconds between stills")
    a = ap.parse_args(argv)

    if a.cmd == "check":
        return check()
    if a.cmd == "frames":
        res = frames(a.folder.expanduser(), a.every)
        print(json.dumps(res, ensure_ascii=False))
        return 1 if "error" in res else 0
    root = a.root.expanduser()
    if a.cmd == "index":
        print(build_index(root))
        return 0
    global SPEECH_LANG
    SPEECH_LANG = a.speech_lang
    if a.cookies_from_browser:
        EXTRA.extend(["--cookies-from-browser", a.cookies_from_browser])
    failed = 0
    for url in [u for given in a.urls for u in expand(given)]:
        try:
            results = fetch(url, root, [x.strip() for x in a.langs.split(",") if x.strip()],
                            not a.no_video, a.audio, a.max_height, not a.no_whisper, a.force, a.frames)
        except subprocess.CalledProcessError as e:
            failed += 1
            res = {"url": url, "error": (e.stderr or str(e)).strip().splitlines()[-1][:300]}
            if NEEDS_LOGIN.search(res["error"]) and not a.cookies_from_browser:
                res["hint"] = "the site wants a login: retry with --cookies-from-browser chrome"
            results = [res]
        for res in results:
            print(json.dumps(res, ensure_ascii=False))
    print(json.dumps({"index": str(build_index(root))}))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

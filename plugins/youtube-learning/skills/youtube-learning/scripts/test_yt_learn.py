"""Offline tests for yt_learn.py: python3 -m unittest test_yt_learn (no network, no yt-dlp)."""
import json
import tempfile
import unittest
import unittest.mock
from pathlib import Path

import yt_learn as y

AUTO_VTT = """WEBVTT
Kind: captions
Language: en

00:00:00.160 --> 00:00:02.869 align:start position:0%
python<00:00:00.640><c> a</c><00:00:00.800><c> highlevel</c>

00:00:02.869 --> 00:00:02.879 align:start position:0%
python a highlevel

00:00:02.879 --> 00:00:05.150 align:start position:0%
python a highlevel
interpreted<00:00:03.360><c> programming</c>

01:00:05.150 --> 01:00:07.000
language &amp; more
"""


class ParseVtt(unittest.TestCase):
    def test_rolling_duplicates_and_tags_removed(self):
        cues = y.parse_vtt(AUTO_VTT)
        self.assertEqual([c[1] for c in cues],
                         ["python a highlevel", "interpreted programming", "language & more"])
        self.assertEqual([c[0] for c in cues], [0.16, 2.879, 3605.15])

    def test_short_timestamps_without_hours(self):
        cues = y.parse_vtt("WEBVTT\n\n01:02.500 --> 01:04.000\nhello\n")
        self.assertEqual(cues, [(62.5, "hello")])


class Paragraphs(unittest.TestCase):
    def test_split_every_minute_and_at_chapters(self):
        cues = [(0, "a"), (30, "b"), (61, "c"), (70, "d"), (80, "e")]
        paras = y.paragraphs(cues, [{"start_time": 0}, {"start_time": 75}])
        self.assertEqual([(p["start"], p["text"]) for p in paras],
                         [(0, "a b"), (61, "c d"), (80, "e")])


class ChooseSubs(unittest.TestCase):
    def test_manual_beats_auto_and_regional_variant_matches(self):
        info = {"language": "en", "subtitles": {"en-GB": [{}], "live_chat": [{}]},
                "automatic_captions": {"en-orig": [{}], "en": [{}], "de": [{}]}}
        self.assertEqual(y.choose_subs(info, ["en"]), [{"key": "en-GB", "lang": "en", "kind": "manual"}])

    def test_translation_pairs_never_match(self):
        self.assertIsNone(y._match({"en-de": [{}], "en-hi": [{}]}, "en"))

    def test_hindi_video_gets_real_asr_first_and_english_translation_second(self):
        info = {"language": "hi", "subtitles": {},
                "automatic_captions": {"hi-orig": [{}], "hi": [{}], "en": [{}]}}
        self.assertEqual(y.choose_subs(info, ["en"]), [
            {"key": "hi-orig", "lang": "hi", "kind": "auto"},
            {"key": "en", "lang": "en", "kind": "auto-translated"}])

    def test_language_guessed_from_orig_track_when_missing(self):
        info = {"automatic_captions": {"mr-orig": [{}], "en": [{}]}}
        self.assertEqual(y.choose_subs(info, ["en"])[0]["key"], "mr-orig")

    def test_no_subtitles_at_all(self):
        self.assertEqual(y.choose_subs({"language": "en"}, ["en"]), [])


class Naming(unittest.TestCase):
    def test_folder_name_and_lengths(self):
        info = {"id": "abc", "title": "C++ & Rust: 10 Tips!", "upload_date": "20240131"}
        self.assertEqual(y.folder_name(info), "2024-01-31_c-rust-10-tips_abc")
        self.assertEqual(y.length({"duration": 19}), "00:19")
        self.assertEqual(y.length({"duration": 3725}), "1:02:05")
        self.assertEqual(y.at({"id": "abc", "extractor_key": "Youtube"}, 61.9), "https://www.youtube.com/watch?v=abc&t=61s")

    def test_time_links_never_point_another_platform_at_youtube(self):
        reel = {"id": "C1", "extractor_key": "Instagram", "webpage_url": "https://www.instagram.com/reel/C1/"}
        self.assertEqual(y.at(reel, 30), "https://www.instagram.com/reel/C1/")
        self.assertEqual(y.at({"id": "5", "extractor_key": "Vimeo", "webpage_url": "https://vimeo.com/5"}, 30),
                         "https://vimeo.com/5#t=30s")

    def test_generic_instagram_title_takes_the_caption(self):
        reel = {"id": "C1", "title": "Video by someone", "description": "\n3 hooks that work\nmore text"}
        self.assertEqual(y.better_title(reel), "3 hooks that work")
        self.assertEqual(y.better_title({"id": "C1", "title": "Video by someone"}), "Video by someone")
        self.assertEqual(y.better_title({"id": "a", "title": "Real title", "description": "x"}), "Real title")

    def test_whisper_model_env_wins(self):
        with unittest.mock.patch.dict(y.os.environ, {"YT_LEARN_WHISPER_MODEL": "small"}):
            self.assertEqual(y.whisper_model(), "small")

    def test_login_errors_are_recognised(self):
        self.assertTrue(y.NEEDS_LOGIN.search("The web client only works when logged-in. Use --cookies"))
        self.assertTrue(y.NEEDS_LOGIN.search("Requested content is not available, rate-limit reached or login required"))
        self.assertFalse(y.NEEDS_LOGIN.search("Unsupported URL"))

    def test_video_urls_are_not_expanded(self):
        for url in ("https://www.youtube.com/watch?v=abc&list=PLx", "https://youtu.be/abc",
                    "https://www.youtube.com/shorts/abc"):
            self.assertEqual(y.expand(url), [url])


class NotesAndIndex(unittest.TestCase):
    def test_template_filled_once_and_index_reads_status(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            folder = root / "2024-01-31_x_abc"
            folder.mkdir()
            info = {"id": "abc", "title": "X | Y", "webpage_url": "u", "channel": "C", "duration": 90}
            meta = {**info, "saved_at": "2026-10-29", "subtitles": {"kind": "auto"}, "video": None}
            (folder / "meta.json").write_text(json.dumps(meta))
            y.write_notes_template(folder, info, meta)
            text = (folder / "notes.md").read_text()
            self.assertNotIn("{{", text)
            self.assertEqual(y.notes_status(folder / "notes.md"), "pending")

            (folder / "notes.md").write_text("# mine\n")
            y.write_notes_template(folder, info, meta)  # never overwrites
            self.assertEqual((folder / "notes.md").read_text(), "# mine\n")
            self.assertEqual(y.notes_status(folder / "notes.md"), "done")

            index = y.build_index(root).read_text()
            self.assertIn("| 2026-10-29 | [X / Y](2024-01-31_x_abc/notes.md) | C | 01:30 | auto | done | no |", index)


class DownloadSubs(unittest.TestCase):
    def test_each_track_alone_retried_and_whisper_file_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            (folder / "subs").mkdir()
            (folder / "subs" / "vid.whisper.vtt").write_text("WEBVTT")  # must not count as done
            calls = []

            def fake(*args, check=True):
                key = args[args.index("--sub-langs") + 1]
                calls.append(key)
                if key == "hi-orig" and calls.count(key) == 2:  # 429 once, then works
                    (folder / "subs" / "vid.hi-orig.vtt").write_text("WEBVTT")
                return type("R", (), {"stderr": "ERROR: HTTP Error 429: Too Many Requests"})()

            real, y.ytdlp = y.ytdlp, fake
            try:
                problems = y.download_subs([], folder, "vid", [
                    {"key": "hi-orig", "kind": "auto"}, {"key": "en", "kind": "auto-translated"}],
                    False, waits=(0, 0, 0))
            finally:
                y.ytdlp = real
            self.assertEqual(calls, ["hi-orig", "hi-orig", "en", "en", "en"])
            self.assertEqual(problems, ["subtitle track en (auto-translated) failed: "
                                        "ERROR: HTTP Error 429: Too Many Requests"])


if __name__ == "__main__":
    unittest.main()

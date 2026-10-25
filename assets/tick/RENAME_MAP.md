# Tick video rename map (2026-10-19)

Matched against WorkPulse_Tick_Exact_Grok_Prompts_v2.md by stage composition.

| new name | original download |
|---|---|
| 01-eyes.mp4 | grok-video-25adc9d7-e37a-44ec-8bb5-9019bb7f13be (19).mp4 |
| 02-move.mp4 | grok-video-25adc9d7-e37a-44ec-8bb5-9019bb7f13be (18).mp4 |
| 03-water.mp4 | grok-video-25adc9d7-e37a-44ec-8bb5-9019bb7f13be (17).mp4 |
| 04-posture.mp4 | grok-video-25adc9d7-e37a-44ec-8bb5-9019bb7f13be (16).mp4 |
| 05-breathe.mp4 | grok-video-25adc9d7-e37a-44ec-8bb5-9019bb7f13be (15).mp4 |
| 06-meeting.mp4 | grok-video-25adc9d7-e37a-44ec-8bb5-9019bb7f13be (14).mp4 |
| 07-log.mp4 | grok-video-25adc9d7-e37a-44ec-8bb5-9019bb7f13be (13).mp4 |
| 08-checkin.mp4 | grok-video-25adc9d7-e37a-44ec-8bb5-9019bb7f13be (12).mp4 |
| 09-wrapup.mp4 | grok-video-25adc9d7-e37a-44ec-8bb5-9019bb7f13be (11).mp4 |
| 10-remind.mp4 | grok-video-25adc9d7-e37a-44ec-8bb5-9019bb7f13be (10).mp4 |
| 11-focus.mp4 | grok-video-25adc9d7-e37a-44ec-8bb5-9019bb7f13be (9).mp4 |
| 12-empty-links.mp4 | grok-video-25adc9d7-e37a-44ec-8bb5-9019bb7f13be (8).mp4 |
| 13-empty-journal.mp4 | grok-video-25adc9d7-e37a-44ec-8bb5-9019bb7f13be (7).mp4 |
| 14-empty-today.mp4 | grok-video-25adc9d7-e37a-44ec-8bb5-9019bb7f13be (6).mp4 |
| 15-empty-tasks.mp4 | grok-video-25adc9d7-e37a-44ec-8bb5-9019bb7f13be (5).mp4 |
| 16-empty-team.mp4 | grok-video-25adc9d7-e37a-44ec-8bb5-9019bb7f13be (4).mp4 |
| 17-empty-notes.mp4 | grok-video-25adc9d7-e37a-44ec-8bb5-9019bb7f13be (3).mp4 |
| 18-backup.mp4 | grok-video-25adc9d7-e37a-44ec-8bb5-9019bb7f13be (2).mp4 |
| 19-push.mp4 | grok-video-25adc9d7-e37a-44ec-8bb5-9019bb7f13be (1).mp4 |
| 20-reading.mp4 | grok-video-25adc9d7-e37a-44ec-8bb5-9019bb7f13be.mp4 |

## Processing (2026-10-19)
- `originals/` — untouched Grok downloads (renamed only).
- `*.mp4` here — Grok watermark removed with ffmpeg `delogo=x=612:y=424:w=72:h=34`, H.264 CRF 20, no audio.
- `gif/` — bottom 44 px cropped (removes watermark), hqdn3d denoise, 10 fps, 48-colour palette, no dither, looping.
  Widths: 320 px (01–11, 18–20), 280 px (12–17). Full 6 s storyboard kept.

# Art slots

Tick's clips, made from the masters in [`../../../assets/tick`](../../../assets/tick) by
`node scripts/build-art.mjs` (ffmpeg). Each slot is two files:

- `<slot>.mp4` — the full 6-second loop, 320 px wide, H.264, no audio (~15–45 KB).
- `<slot>.jpg` — its first frame: shown first, shown for reduced motion, shown if the video cannot play.

Every master is restaged on one flat light backdrop so the clips match each other. `src/ui/Art.tsx` renders the
slot if the files exist and nothing if they do not, and nothing at all when `WXT_FEATURE_TICK=false`.

The brief for each slot lives in [`../../DESIGN.md`](../../DESIGN.md). To change a clip, replace its master and
rerun the script; the outputs are committed so building the extension never needs ffmpeg.

# Art slots

Tick's clips, cut out of the masters in [`../../../assets/tick`](../../../assets/tick) by
`node scripts/build-art.mjs` (ffmpeg with libvpx-vp9, and python3 with numpy and opencv-python). Each slot is
two files, both with real transparency, so they sit on a light card and a dark one alike:

- `<slot>.webm`: the full 6-second loop, 320 px wide, VP9 with alpha, no audio (~30–150 KB).
- `<slot>.webp`: its first frame. It shows first, it shows for reduced motion, and it shows if the video cannot play.

The masters were drawn on light backdrops, some with a fake checkerboard baked in. `scripts/matte-art.py` removes
only the light, colourless region that touches the frame edge, so Tick's white belly and eyes stay solid. It
paints enclosed checkerboard (inside a sheet of paper) plain white and drops compression specks.

`src/ui/Art.tsx` renders the slot if the files exist, nothing if they do not, and nothing at all when
`WXT_FEATURE_TICK=false`. The brief for each slot is in [`../../DESIGN.md`](../../DESIGN.md). To change a clip,
replace its master and rerun the script. The outputs are committed, so building the extension never needs
ffmpeg or Python.

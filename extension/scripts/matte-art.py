#!/usr/bin/env python3
"""Cuts Tick out of a master clip and writes a VP9 WebM with real transparency.

    python3 scripts/matte-art.py <master.mp4> <out.webm> [width]

Called by build-art.mjs for each slot. Needs ffmpeg (with libvpx-vp9), numpy and
opencv-python.

The masters were drawn on light, colourless backdrops — flat greys, and on some
a fake checkerboard baked into the pixels. Tick is dark indigo and the props are
dark line art, so the backdrop is "light and colourless". But Tick's belly and
eyes are white too, and a global key would punch holes in them. So only the
light, colourless region that *touches the edge of the frame* is background:
it is found by a flood fill from the border, and anything enclosed by the
drawing stays opaque. The mask edge is softened by a pixel so lines stay smooth
on any colour.
"""

import subprocess
import sys

import cv2
import numpy as np

src, out = sys.argv[1], sys.argv[2]
width = int(sys.argv[3]) if len(sys.argv) > 3 else 320
CROP = 8  # some masters carry a green strip or a watermark shadow at the edge


def probe(path):
    r = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'csv=p=0', path],
        capture_output=True, text=True, check=True,
    )
    w, h, rate = r.stdout.strip().split(',')
    return int(w), int(h), rate


w, h, rate = probe(src)
cw, ch = w - 2 * CROP, h - 2 * CROP
oh = round(ch * width / cw / 2) * 2

reader = subprocess.Popen(
    ['ffmpeg', '-v', 'error', '-i', src, '-vf', f'crop={cw}:{ch}:{CROP}:{CROP}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    stdout=subprocess.PIPE,
)
writer = subprocess.Popen(
    [
        'ffmpeg', '-y', '-v', 'error',
        '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', f'{width}x{oh}', '-r', rate, '-i', '-',
		'-an', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '30',
        '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-auto-alt-ref', '0',
        out,
    ],
    stdin=subprocess.PIPE,
)

first = None
threshold = None
frame_bytes = cw * ch * 3
while True:
    buf = reader.stdout.read(frame_bytes)
    if len(buf) < frame_bytes:
        break
    rgb = np.frombuffer(buf, np.uint8).reshape(ch, cw, 3)
    luma = (0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]).astype(np.int16)
    chroma = rgb.max(axis=2).astype(np.int16) - rgb.min(axis=2).astype(np.int16)
    if threshold is None:
        # The darkest pixel of the empty top-right corner is the checkerboard's
        # darker square (or the flat backdrop itself); a little below it is bg.
        corner = luma[12:72, cw - 72:cw - 12]
        threshold = int(min(corner.min(), 214)) - 5
    candidate = ((luma >= threshold) & (chroma < 28)).astype(np.uint8)

    # Flood from every border pixel that is a candidate: that region is the backdrop.
    mask = np.zeros((ch + 2, cw + 2), np.uint8)
    fill = candidate.copy() * 255
    for x in range(0, cw, 4):
        for y in (0, ch - 1):
            if fill[y, x] == 255 and mask[y + 1, x + 1] == 0:
                cv2.floodFill(fill, mask, (x, y), 128, flags=4)
    for y in range(0, ch, 4):
        for x in (0, cw - 1):
            if fill[y, x] == 255 and mask[y + 1, x + 1] == 0:
                cv2.floodFill(fill, mask, (x, y), 128, flags=4)
    background = fill == 128
    # Light, colourless pixels the drawing encloses are paper, a belly, an eye
    # highlight — or a checkerboard the generator baked inside a sheet of paper.
    # All of them read correctly as plain white.
    rgb = rgb.copy()
    rgb[(fill == 255) & ~background] = 255
    # Specks: tiny opaque islands left in the backdrop by compression noise.
    solid = (~background).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(solid, connectivity=8)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] < 40:
            background[labels == i] = True

    alpha = np.where(background, 0, 255).astype(np.uint8)
    # One pixel of softening so line art keeps its anti-aliasing on dark cards.
    alpha = cv2.GaussianBlur(alpha, (3, 3), 0)
    rgba = np.dstack([rgb, alpha])
    rgba = cv2.resize(rgba, (width, oh), interpolation=cv2.INTER_AREA)
    if first is None:
        first = rgba
    writer.stdin.write(rgba.tobytes())

writer.stdin.close()
writer.wait()
reader.wait()

# The still, with the same transparency, for reduced motion and first paint.
if first is not None:
    cv2.imwrite(out.replace('.webm', '.webp'), cv2.cvtColor(first, cv2.COLOR_RGBA2BGRA), [cv2.IMWRITE_WEBP_QUALITY, 82])

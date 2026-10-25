// Turns the Tick masters in ../assets/tick into what the extension ships.
//
//   node scripts/build-art.mjs           # only clips whose output is missing or older
//   node scripts/build-art.mjs --force   # every clip
//
// A master is `NN-slot.mp4` (688×464, 6 s, no audio). Each becomes
// `public/art/<slot>.mp4` — 320 px wide, H.264, CRF 30, fast-start, still the full
// 6 s so it loops as it was drawn — and `public/art/<slot>.jpg`, its first frame,
// for reduced motion and for the moment before the video starts. Eight pixels come
// off every edge: some clips carry a green chroma strip or a watermark shadow there.
//
// The outputs are committed, so building the extension never needs ffmpeg. Run
// this only when a master changes.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const masters = join(here, '..', '..', 'assets', 'tick')
const out = join(here, '..', 'public', 'art')
const force = process.argv.includes('--force')

mkdirSync(out, { recursive: true })

const crop = 'crop=iw-16:ih-16:8:8'

// Every master was generated on a different backdrop — flat greys of every shade,
// and on several a fake transparency checkerboard baked into the pixels. Shown
// side by side they look like stickers cut from different sheets. Tick is a
// dark indigo and the props are dark line art, so everything at or above the
// backdrop's brightness is pushed to one shared stage tone: the checkerboard's
// two squares and every grey become the same flat light stage, and the drawing
// stays. (Real transparency needs a matting pass; this is the honest interim.)
const STAGE_Y = 236
/** The darkest pixel of the empty top-right corner: a checkerboard's darker square. */
function backdropLuma(src) {
	const y = execFileSync('ffmpeg', ['-v', 'error', '-i', src, '-vf', 'crop=60:60:600:20', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
	return Math.min(...y)
}
const restage = (src) => {
	const t = Math.min(backdropLuma(src), 214) - 12
	return `${crop},lutyuv=y='if(gte(val,${t}),${STAGE_Y},val)':u='if(between(val,120,136),128,val)':v='if(between(val,120,136),128,val)',scale=320:-2:flags=lanczos`
}

let built = 0
let bytes = 0
for (const file of readdirSync(masters).filter((f) => /^\d\d-.+\.mp4$/.test(f)).sort()) {
	const slot = file.replace(/^\d\d-/, '').replace(/\.mp4$/, '')
	const src = join(masters, file)
	const mp4 = join(out, `${slot}.mp4`)
	const jpg = join(out, `${slot}.jpg`)
	const stale = (p) => force || !existsSync(p) || statSync(p).mtimeMs < statSync(src).mtimeMs
	if (stale(mp4)) {
		execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', src, '-an', '-vf', `${restage(src)},fps=24`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4])
		built++
	}
	if (stale(jpg)) {
		execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', src, '-vf', restage(src), '-frames:v', '1', '-q:v', '5', jpg])
	}
	bytes += statSync(mp4).size + statSync(jpg).size
}
console.log(`art: ${built} clip(s) rebuilt, ${(bytes / 1024).toFixed(0)} KB in public/art`)

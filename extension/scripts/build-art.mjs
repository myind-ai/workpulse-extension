// Turns the Tick masters in ../assets/tick into what the extension ships.
//
//   node scripts/build-art.mjs           # only clips whose output is missing or older
//   node scripts/build-art.mjs --force   # every clip
//
// A master is `NN-slot.mp4` (688×464, 6 s, no audio). Each becomes
//
//   public/art/<slot>.webm   the full 6-second loop, 320 px, VP9 with real transparency
//   public/art/<slot>.webp   its first frame, also transparent: shown first, and for reduced motion
//
// The masters were drawn on light backdrops (flat greys, and on some a fake
// checkerboard baked into the pixels). scripts/matte-art.py cuts Tick and the
// props out of them, so a clip sits on a dark card as well as on a light one.
//
// The outputs are committed, so building the extension never needs ffmpeg or
// Python. Run this only when a master changes. Needs ffmpeg with libvpx-vp9,
// and python3 with numpy and opencv-python.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { cpus } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const masters = join(here, '..', '..', 'assets', 'tick')
const out = join(here, '..', 'public', 'art')
const force = process.argv.includes('--force')

mkdirSync(out, { recursive: true })
try {
	execFileSync('python3', ['-I', '-c', 'import cv2, numpy'], { stdio: 'ignore' })
} catch {
	console.error('build-art needs python3 with numpy and opencv-python: pip install numpy opencv-python')
	process.exit(1)
}

const jobs = readdirSync(masters)
	.filter((f) => /^\d\d-.+\.mp4$/.test(f))
	.sort()
	.map((file) => {
		const slot = file.replace(/^\d\d-/, '').replace(/\.mp4$/, '')
		return { slot, src: join(masters, file), webm: join(out, `${slot}.webm`), webp: join(out, `${slot}.webp`) }
	})
	.filter(({ src, webm, webp }) => force || [webm, webp].some((p) => !existsSync(p) || statSync(p).mtimeMs < statSync(src).mtimeMs))

// One clip per core: each is a decode, a per-frame matte and a VP9 encode.
const queue = [...jobs]
await Promise.all(
	Array.from({ length: Math.max(1, cpus().length - 1) }, async () => {
		for (let job = queue.shift(); job; job = queue.shift()) {
			await run('python3', ['-I', join(here, 'matte-art.py'), job.src, job.webm, '320'])
			console.log(`  ${job.slot}`)
		}
	}),
)

let bytes = 0
for (const f of readdirSync(out).filter((f) => /\.(webm|webp)$/.test(f))) bytes += statSync(join(out, f)).size
console.log(`art: ${jobs.length} clip(s) rebuilt, ${(bytes / 1024).toFixed(0)} KB in public/art`)

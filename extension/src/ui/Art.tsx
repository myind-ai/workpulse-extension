// Tick, when there is a clip of him for this slot.
//
// Every slot is optional on purpose: the file either exists in public/art and
// the card gets a picture, or it does not and the card is exactly what it was.
// That way art can land one file at a time without a code change, and a build
// missing a file never shows a broken image.
//
// A slot is a six-second loop (`<name>.webm`, VP9 with transparency) with its
// first frame as a still (`<name>.webp`, also transparent). The still is what
// shows first, what shows to anyone who asked for less motion, and what shows
// when the video cannot play. Both sit on any card, light or dark. The clips are
// cut out of the masters in assets/tick by scripts/build-art.mjs.

import { useEffect, useRef, useState } from 'react'

import { enabled } from '@/core/features'

/** The masters are 3:2 once trimmed; `size` is the height, the width follows. */
const ASPECT = 1.5

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

export function Art({
	name,
	size = 148,
	round = true,
	delay = 0,
}: {
	name: string
	size?: number
	round?: boolean
	/** Hold the still this long before playing — for a busy strip that may finish first. */
	delay?: number
}) {
	const [ok, setOk] = useState(true)
	const [play, setPlay] = useState(delay === 0)
	const ref = useRef<HTMLVideoElement>(null)

	useEffect(() => {
		if (delay === 0) return
		const t = setTimeout(() => setPlay(true), delay)
		return () => clearTimeout(t)
	}, [delay])

	// A card left open in a background tab should not keep a decoder busy.
	useEffect(() => {
		const v = ref.current
		if (!v) return
		const on = () => (document.hidden ? v.pause() : v.play().catch(() => undefined))
		document.addEventListener('visibilitychange', on)
		return () => document.removeEventListener('visibilitychange', on)
	}, [play])

	if (!enabled('TICK') || !ok) return null
	const url = (ext: string) => chrome.runtime.getURL(`/art/${name}.${ext}`)
	const style = { borderRadius: round ? 14 : 0, width: Math.round(size * ASPECT), height: size, objectFit: 'contain' as const }

	if (!play || reducedMotion()) {
		return <img className="wp-art" src={url('webp')} alt="" aria-hidden style={style} onError={() => setOk(false)} />
	}
	return (
		<video
			ref={ref}
			className="wp-art"
			src={url('webm')}
			poster={url('webp')}
			autoPlay
			muted
			loop
			playsInline
			aria-hidden
			style={style}
			onError={() => setOk(false)}
		/>
	)
}

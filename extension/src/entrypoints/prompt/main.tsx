// Fallback surface for forced reminders: a focused popup window used when no
// web page can show the overlay, or when Chrome is not the focused app.

import { useEffect } from 'react'
import ReactDOM from 'react-dom/client'

import '@/ui/theme.css'
import { Forced } from '@/ui/forced/Forced'

const MIN_H = 260
const MAX_H = 720

/**
 * The window is created at a guessed size, which leaves a slab of empty space
 * under a short card. Measure what rendered and shrink to it — and because the
 * card changes (a reminder is small, the hourly prompt is not), keep watching.
 */
function Sized() {
	useEffect(() => {
		const fit = () => {
			const h = document.documentElement.scrollHeight
			if (!h) return
			const want = Math.min(MAX_H, Math.max(MIN_H, h + (window.outerHeight - window.innerHeight)))
			if (Math.abs(want - window.outerHeight) > 8) window.resizeTo(window.outerWidth, want)
		}
		fit()
		const ro = new ResizeObserver(fit)
		ro.observe(document.documentElement)
		return () => ro.disconnect()
	}, [])
	return <Forced surface="window" onEmpty={() => window.close()} />
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Sized />)

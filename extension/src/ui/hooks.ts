import { useCallback, useEffect, useRef, useState } from 'react'

import { onChanged } from '@/lib/rpc'

/** Loads `fn()` and reloads it whenever the background reports a change. */
export function useLive<T>(fn: () => Promise<T>, deps: unknown[] = []) {
	const [data, setData] = useState<T | null>(null)
	const [error, setError] = useState<string | null>(null)
	const fnRef = useRef(fn)
	fnRef.current = fn
	const reload = useCallback(async () => {
		try {
			setData(await fnRef.current())
			setError(null)
		} catch (e) {
			setError((e as Error).message)
		}
	}, [])
	useEffect(() => {
		void reload()
		// One action can broadcast several times (save → reconcile → badge). Without
		// this, every subscriber re-runs its command for each one.
		let timer: ReturnType<typeof setTimeout> | undefined
		const off = onChanged(() => {
			clearTimeout(timer)
			timer = setTimeout(() => void reload(), 120)
		})
		return () => {
			clearTimeout(timer)
			off()
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, deps)
	return { data, error, reload, setData }
}

/** Wraps an async action with busy + error state. */
export function useAction() {
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
		setBusy(true)
		setError(null)
		try {
			return await fn()
		} catch (e) {
			setError((e as Error).message)
			return undefined
		} finally {
			setBusy(false)
		}
	}, [])
	return { busy, error, setError, run }
}

/** Re-renders every `ms` so relative times stay fresh. */
export function useNow(ms = 30_000) {
	const [now, setNow] = useState(Date.now())
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), ms)
		return () => clearInterval(t)
	}, [ms])
	return now
}

export async function copyText(text: string) {
	await navigator.clipboard.writeText(text)
}

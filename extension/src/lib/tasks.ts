// Tasks and the single running timer. Starting a task stops the previous one
// and books its minutes; the hourly prompt prefills from the running timer.

import type { Priority, Task, TaskStatus } from '@/core/types'

import { uid, type Store } from './store'

export interface NewTask {
	title: string
	key?: string
	jobId?: string
	priority?: Priority
	repeatMinutes?: number
	/** When to bring this back, as an epoch. Empty means never. */
	remindAt?: number
	url?: string
	kind?: 'task' | 'note'
}

export async function createTask(store: Store, t: NewTask, now: number): Promise<Task> {
	const title = t.title.trim()
	if (!title) throw new Error('A task needs a title.')
	const task: Task = {
		uid: uid(),
		title,
		key: t.key?.trim() || undefined,
		jobId: t.jobId || undefined,
		status: 'todo',
		createdAt: now,
		spentMinutes: 0,
		priority: t.priority ?? 'normal',
		remindAt: t.remindAt,
		url: t.url?.trim() || undefined,
		kind: t.kind ?? 'task',
		repeatMinutes: t.repeatMinutes || undefined,
	}
	await store.saveTasks([task, ...(await store.tasks())])
	return task
}

export async function updateTask(store: Store, id: string, patch: Partial<Omit<Task, 'uid'>>): Promise<void> {
	const list = await store.tasks()
	if (!list.some((t) => t.uid === id)) throw new Error('Task not found.')
	const stamp = patch.status === 'done' ? { doneAt: Date.now() } : patch.status ? { doneAt: undefined } : {}
	await store.saveTasks(list.map((t) => (t.uid === id ? { ...t, ...patch, ...stamp } : t)))
	if (patch.status === 'done') {
		const timer = await store.timer()
		if (timer?.taskUid === id) await stopTimer(store, Date.now())
	}
}

export async function deleteTask(store: Store, id: string): Promise<void> {
	const timer = await store.timer()
	if (timer?.taskUid === id) await store.setTimer(null)
	await store.saveTasks((await store.tasks()).filter((t) => t.uid !== id))
}

/** Stops the running timer (if any) and adds its minutes to the task. Returns minutes booked. */
export async function stopTimer(store: Store, now: number): Promise<number> {
	const timer = await store.timer()
	if (!timer) return 0
	const minutes = Math.max(0, Math.round((now - timer.startedAt) / 60_000))
	const list = await store.tasks()
	await store.saveTasks(list.map((t) => (t.uid === timer.taskUid ? { ...t, spentMinutes: t.spentMinutes + minutes } : t)))
	await store.setTimer(null)
	return minutes
}

export async function startTimer(store: Store, taskId: string, now: number): Promise<void> {
	const list = await store.tasks()
	if (!list.some((t) => t.uid === taskId)) throw new Error('Task not found.')
	await stopTimer(store, now)
	await store.saveTasks((await store.tasks()).map((t) => (t.uid === taskId ? { ...t, status: 'doing' } : t)))
	await store.setTimer({ taskUid: taskId, startedAt: now })
}

const RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 }

/** High first, then the order you added them. */
export const byPriority = (a: Task, b: Task) => RANK[a.priority ?? 'normal'] - RANK[b.priority ?? 'normal'] || a.createdAt - b.createdAt

/**
 * When a repeating reminder should next appear. Counts forward from the time
 * that was due, so a laptop asleep for three hours does not fire three times.
 */
export function nextRepeat(remindAt: number, repeatMinutes: number, now: number): number {
	const step = repeatMinutes * 60_000
	const missed = Math.floor((now - remindAt) / step) + 1
	return remindAt + missed * step
}

/** Tasks whose reminder time has come and that have not been told about yet. */
export function dueReminders(list: Task[], now: number): Task[] {
	return list.filter((t) => t.status !== 'done' && t.remindAt != null && t.remindAt <= now && (t.remindedAt == null || t.remindedAt < t.remindAt))
}

/**
 * The open tasks worth asking about now. A task you have just answered is quiet
 * for one interval — the same gap as the hourly prompt — so the popup nudges
 * once an hour rather than every time you open it.
 */
export function tasksToAsk(list: Task[], now: number, quietMinutes: number): Task[] {
	// Notes are kept, not chased: only todos are ever asked about.
	return list.filter((t) => t.kind !== 'note' && t.status !== 'done' && (t.askedAt == null || now - t.askedAt >= quietMinutes * 60_000)).sort(byPriority)
}

/** "Done" / "still on it" / "not today", and the quiet period starts. */
export async function answerTask(store: Store, id: string, answer: 'done' | 'doing' | 'later', now: number): Promise<void> {
	const list = await store.tasks()
	if (!list.some((t) => t.uid === id)) throw new Error('Task not found.')
	const status: TaskStatus | undefined = answer === 'later' ? undefined : answer
	await store.saveTasks(
		list.map((t) => (t.uid === id ? { ...t, ...(status ? { status } : {}), askedAt: now, doneAt: answer === 'done' ? now : t.doneAt } : t)),
	)
	if (answer === 'done') {
		const timer = await store.timer()
		if (timer?.taskUid === id) await stopTimer(store, now)
	}
}

export interface RunningTimer {
	task: Task
	startedAt: number
	minutes: number
}

export async function runningTimer(store: Store, now: number): Promise<RunningTimer | null> {
	const timer = await store.timer()
	if (!timer) return null
	const task = (await store.tasks()).find((t) => t.uid === timer.taskUid)
	if (!task) return null
	return { task, startedAt: timer.startedAt, minutes: Math.max(0, Math.round((now - timer.startedAt) / 60_000)) }
}

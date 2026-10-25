// Where the big things live.
//
// `chrome.storage.local` is a JSON store: anything put in it is serialised, and
// a video turned into base64 is a third larger again and has to be parsed in
// full every time anything else in that key is read. A thirty-second clip is
// four megabytes; a handful of them would make every read of the notes list
// slow, for data no list ever shows.
//
// IndexedDB holds Blobs as Blobs. Nothing else in WorkPulse needs it, which is
// why this is forty lines rather than a library.

const DB = 'workpulse-blobs'
const STORE = 'blobs'

function open(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB, 1)
		req.onupgradeneeded = () => {
			if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
		}
		req.onsuccess = () => resolve(req.result)
		req.onerror = () => reject(req.error)
	})
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	return open().then(
		(db) =>
			new Promise<T>((resolve, reject) => {
				const tx = db.transaction(STORE, mode)
				const req = fn(tx.objectStore(STORE))
				req.onsuccess = () => resolve(req.result)
				req.onerror = () => reject(req.error)
				tx.oncomplete = () => db.close()
			}),
	)
}

export const putBlob = (id: string, blob: Blob) => run('readwrite', (s) => s.put(blob, id))
export const getBlob = (id: string) => run<Blob | undefined>('readonly', (s) => s.get(id))
export const dropBlob = (id: string) => run('readwrite', (s) => s.delete(id))
export const blobIds = () => run<IDBValidKey[]>('readonly', (s) => s.getAllKeys()).then((k) => k.map(String))

/** Everything that is no longer pointed at by anything. */
export async function sweepBlobs(keep: string[]): Promise<number> {
	const have = await blobIds()
	const wanted = new Set(keep)
	const gone = have.filter((id) => !wanted.has(id))
	for (const id of gone) await dropBlob(id)
	return gone.length
}

/** A blob as a data URL, for showing it or for sending it somewhere. */
export function toDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () => resolve(String(reader.result))
		reader.onerror = () => reject(reader.error)
		reader.readAsDataURL(blob)
	})
}

// Encryption for the vault, done by the `age` CLI. Only this file knows age.
// The key is an age identity (AGE-SECRET-KEY-1...). It travels on stdin only: never argv, never a file, never a message.
// The key store is the macOS Keychain through `security`, or an in-memory one for tests.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { renameSync, rmSync, writeFileSync } from 'node:fs'

export const NO_AGE = 'age is not installed: run `brew install age`'
const KEY_SHAPE = /^AGE-SECRET-KEY-1[0-9A-Z]{20,}$/
const SERVICE = 'workpulse-vault'

/** Runs a command, feeding stdin; resolves { code, out } and never exposes stderr. Rejects with NO_AGE when the tool is missing. */
function run(cmd, args, input) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] })
		const chunks = []
		child.stdout.on('data', (c) => chunks.push(c))
		child.on('error', (e) => reject(e.code === 'ENOENT' ? new Error(NO_AGE) : new Error(`${cmd} failed to start`)))
		child.stdin.on('error', () => {}) // a tool that exits early closes the pipe
		child.on('close', (code) => resolve({ code, out: Buffer.concat(chunks).toString('utf8') }))
		child.stdin.end(input ?? '')
	})
}

/** True when `age` and `age-keygen` are on PATH. */
export function ageAvailable() {
	return ['age', 'age-keygen'].every((c) => spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0)
}

/** A new vault key (an age identity). Prints nothing. */
export async function newKey() {
	const { code, out } = await run('age-keygen', [])
	const key = out.split('\n').find((l) => l.startsWith('AGE-SECRET-KEY-1'))
	if (code !== 0 || !key) throw new Error('could not create a key')
	return key.trim()
}

/** The public recipient of a key, via `age-keygen -y` with the key on stdin. */
export async function recipientOf(key) {
	const { code, out } = await run('age-keygen', ['-y'], `${key}\n`)
	const recipient = out.trim()
	if (code !== 0 || !recipient.startsWith('age1')) throw new Error('not a valid vault key')
	return recipient
}

/** The first 8 hex of the key's SHA-256: names the key without revealing it. */
export function fingerprint(key) {
	return createHash('sha256').update(key).digest('hex').slice(0, 8)
}

/** Trims the text and checks it is an age secret key (age's bech32 checksum catches a typo). Throws without echoing the text. */
export async function validateKey(text) {
	const key = String(text ?? '').trim()
	if (!KEY_SHAPE.test(key)) throw new Error('not a valid vault key')
	await recipientOf(key)
	return key
}

const partialOf = (dest) => `${dest}.partial`

/** Encrypts src to dest. Writes dest.partial and renames only on success; removes it on any failure. */
export async function encryptFile(src, dest, key) {
	const partial = partialOf(dest)
	rmSync(partial, { force: true })
	try {
		const recipient = await recipientOf(key)
		const { code } = await run('age', ['-r', recipient, '-o', partial, src])
		if (code !== 0) throw new Error('encryption failed')
		renameSync(partial, dest)
	} catch (e) {
		rmSync(partial, { force: true })
		throw e
	}
}

/** Decrypts src to dest. age verifies each chunk as it writes, so the partial file is never a result: rename only on exit 0. */
export async function decryptFile(src, dest, key) {
	const partial = partialOf(dest)
	rmSync(partial, { force: true })
	try {
		writeFileSync(partial, '', { mode: 0o600, flag: 'wx' }) // plaintext is never world-readable, not even as a partial
		const { code } = await run('age', ['-d', '-i', '-', '-o', partial, src], `${key}\n`)
		if (code !== 0) throw new Error('wrong key or damaged file')
		renameSync(partial, dest)
	} catch (e) {
		rmSync(partial, { force: true })
		throw e.message === NO_AGE ? e : new Error('wrong key or damaged file')
	}
}

/** Long enough to answer a Keychain dialog; a locked Keychain must not hang `doctor` for ever. A timeout sets r.error, so it reads as "could not read", never as a missing key. */
export const SECURITY_TIMEOUT_MS = 120000
const security = (args) => spawnSync('security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: Number(process.env.WP_VAULT_SECURITY_TIMEOUT_MS) || SECURITY_TIMEOUT_MS })

/** The macOS Keychain. get returns null when the key is missing and never creates one. (add-generic-password -w exposes the key on argv for a moment: accepted.) */
export const keystore = {
	get(account) {
		const r = security(['find-generic-password', '-s', SERVICE, '-a', account, '-w'])
		if (r.error) throw new Error('could not read the Keychain')
		if (r.status === 44) return null // errSecItemNotFound: the only "no key"
		if (r.status !== 0) throw new Error('could not read the Keychain')
		const key = r.stdout.trim()
		return key || null
	},
	set(account, key) {
		const r = security(['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', key])
		if (r.error || r.status !== 0) throw new Error('could not save the key in the Keychain')
	},
	has(account) {
		return keystore.get(account) !== null
	},
}

/** An in-memory key store with the same shape, for tests. */
export function fakeKeystore() {
	const m = new Map()
	return {
		get: (a) => m.get(a) ?? null,
		set: (a, k) => void m.set(a, k),
		has: (a) => m.has(a),
	}
}

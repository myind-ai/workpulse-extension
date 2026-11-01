// node --test cli/vault-crypto.test.mjs
// Uses the real `age` and `age-keygen` in temp dirs. The Keychain is only ever a stub `security` first on PATH.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { ageAvailable, decryptFile, encryptFile, fakeKeystore, fingerprint, keystore, newKey, SECURITY_TIMEOUT_MS, recipientOf, validateKey } from './vault-crypto.mjs'

const root = mkdtempSync(join(tmpdir(), 'vault-crypto-'))
after(() => rmSync(root, { recursive: true, force: true }))
let n = 0
const dir = () => mkdtempSync(join(root, `t${n++}-`))
const MiB = 1024 * 1024
const CHUNK = 65536 + 16

test('age is installed (these tests need the real binary)', () => {
	assert.equal(ageAvailable(), true, 'age and age-keygen must be on PATH: brew install age')
})

/** Encrypts `bytes` and returns everything a test needs. */
async function sealed(bytes, key) {
	const d = dir()
	const src = join(d, 'in.bin')
	const enc = join(d, 'in.age')
	writeFileSync(src, bytes)
	await encryptFile(src, enc, key)
	return { d, src, enc, out: join(d, 'out.bin') }
}
/** Rejects with a message that matches `re` and holds none of the keys. */
const rejectsClean = (p, re, ...keys) => assert.rejects(p, (e) => re.test(e.message) && keys.every((k) => !e.message.includes(k)))
const leftovers = (out) => [out, `${out}.partial`].filter((f) => existsSync(f))
/** Where the payload starts: after the header's closing `--- <mac>` line, then a 16-byte nonce. */
const payloadStart = (buf) => buf.indexOf('\n', buf.indexOf('\n--- ') + 1) + 1 + 16

describe('round trip and format', () => {
	for (const [label, size] of [['0 bytes', 0], ['1 byte', 1], ['4 MiB', 4 * MiB], ['9 MiB', 9 * MiB]]) {
		test(`round trips ${label}`, async () => {
			const key = await newKey()
			const bytes = randomBytes(size)
			const s = await sealed(bytes, key)
			assert.equal(existsSync(`${s.enc}.partial`), false)
			await decryptFile(s.enc, s.out, key)
			assert.ok(readFileSync(s.out).equals(bytes))
			assert.equal(existsSync(`${s.out}.partial`), false)
		})
	}

	test('two encryptions of the same file differ', async () => {
		const key = await newKey()
		const bytes = randomBytes(1000)
		const a = await sealed(bytes, key)
		const b = await sealed(bytes, key)
		assert.ok(!readFileSync(a.enc).equals(readFileSync(b.enc)))
	})
})

describe('a bad key or a damaged file is rejected and leaves nothing', () => {
	test('wrong key', async () => {
		const key = await newKey()
		const s = await sealed(randomBytes(5000), key)
		const other = await newKey()
		await rejectsClean(decryptFile(s.enc, s.out, other), /wrong key or damaged file/, key, other)
		assert.deepEqual(leftovers(s.out), [])
	})

	test('a flipped byte in the middle', async () => {
		const key = await newKey()
		const s = await sealed(randomBytes(9 * MiB), key)
		const buf = readFileSync(s.enc)
		buf[Math.floor(buf.length / 2)] ^= 1
		writeFileSync(s.enc, buf)
		await rejectsClean(decryptFile(s.enc, s.out, key), /wrong key or damaged file/, key)
		assert.deepEqual(leftovers(s.out), [])
	})

	test('the last chunk dropped (truncation)', async () => {
		const key = await newKey()
		const s = await sealed(randomBytes(9 * MiB), key)
		const buf = readFileSync(s.enc)
		writeFileSync(s.enc, buf.subarray(0, buf.length - CHUNK))
		await rejectsClean(decryptFile(s.enc, s.out, key), /wrong key or damaged file/, key)
		assert.deepEqual(leftovers(s.out), [])
	})

	test('two whole chunks swapped', async () => {
		const key = await newKey()
		const s = await sealed(randomBytes(9 * MiB), key)
		const buf = readFileSync(s.enc)
		const start = payloadStart(buf)
		assert.equal((buf.length - start) % CHUNK, 0, 'the payload is whole chunks')
		const a = buf.subarray(start + CHUNK, start + 2 * CHUNK)
		const b = buf.subarray(start + 2 * CHUNK, start + 3 * CHUNK)
		const [ca, cb] = [Buffer.from(a), Buffer.from(b)]
		ca.copy(buf, start + 2 * CHUNK)
		cb.copy(buf, start + CHUNK)
		writeFileSync(s.enc, buf)
		await rejectsClean(decryptFile(s.enc, s.out, key), /wrong key or damaged file/, key)
		assert.deepEqual(leftovers(s.out), [])
	})

	test('an encryption that fails leaves no partial, and the message has no key', async () => {
		const key = await newKey()
		const d = dir()
		const dest = join(d, 'x.age')
		await rejectsClean(encryptFile(join(d, 'missing.bin'), dest, key), /encryption failed/, key)
		assert.deepEqual(leftovers(dest), [])
	})
})

test('decrypted plaintext is private: dest is mode 600 at a 022 umask', async () => {
	const key = await newKey()
	const s = await sealed(randomBytes(100), key)
	const old = process.umask(0o022)
	try {
		await decryptFile(s.enc, s.out, key)
	} finally {
		process.umask(old)
	}
	assert.equal(statSync(s.out).mode & 0o777, 0o600)
})

describe('keys', () => {
	test('newKey is an age identity and recipientOf gives the public side', async () => {
		const key = await newKey()
		assert.match(key, /^AGE-SECRET-KEY-1[0-9A-Z]+$/)
		assert.match(await recipientOf(key), /^age1/)
		assert.match(fingerprint(key), /^[0-9a-f]{8}$/)
		assert.notEqual(fingerprint(key), fingerprint(await newKey()))
	})

	test('validateKey trims, accepts a real key and rejects a changed character without echoing it', async () => {
		const key = await newKey()
		assert.equal(await validateKey(`  ${key}\n`), key)
		const i = key.length - 5
		const typo = key.slice(0, i) + (key[i] === 'Q' ? 'P' : 'Q') + key.slice(i + 1)
		for (const bad of [typo, 'hello', '', key.slice(0, 30)]) {
			await assert.rejects(validateKey(bad), (e) => e.message === 'not a valid vault key' && !e.message.includes(bad || '\0'))
		}
	})

	test('a missing age gives the install hint, tested through an empty PATH', async () => {
		const path = process.env.PATH
		process.env.PATH = dir()
		try {
			assert.equal(ageAvailable(), false)
			const fake = 'AGE-SECRET-KEY-1' + 'Q'.repeat(50)
			await rejectsClean(newKey(), /brew install age/)
			await rejectsClean(encryptFile('a', join(dir(), 'b'), fake), /brew install age/, fake)
			await rejectsClean(decryptFile('a', join(dir(), 'b'), fake), /brew install age/, fake)
		} finally {
			process.env.PATH = path
		}
	})
})

describe('key stores', () => {
	test('the fake store returns null for a missing account and never creates one', () => {
		const ks = fakeKeystore()
		assert.equal(ks.get('me'), null)
		assert.equal(ks.has('me'), false)
		ks.set('me', 'k')
		assert.equal(ks.get('me'), 'k')
		assert.equal(ks.has('me'), true)
	})

	test('the macOS store calls only a stub `security` with the expected command lines', () => {
		const d = dir()
		const log = join(d, 'calls.log')
		const store = join(d, 'value')
		writeFileSync(
			join(d, 'security'),
			`#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\ncase "$1" in\nadd-generic-password) while [ $# -gt 0 ]; do [ "$1" = "-w" ] && printf '%s' "$2" > "${store}"; shift; done ;;\nfind-generic-password) [ -f "${store}" ] && { cat "${store}"; echo; exit 0; }; exit 44 ;;\nesac\n`,
		)
		chmodSync(join(d, 'security'), 0o755)
		const path = process.env.PATH
		process.env.PATH = `${d}:${path}`
		try {
			assert.equal(keystore.get('me'), null)
			assert.equal(keystore.has('me'), false)
			keystore.set('me', 'KEYVALUE')
			assert.equal(keystore.get('me'), 'KEYVALUE')
			assert.equal(keystore.has('me'), true)
		} finally {
			process.env.PATH = path
		}
		const calls = readFileSync(log, 'utf8').trim().split('\n')
		assert.equal(calls[0], 'find-generic-password -s workpulse-vault -a me -w')
		assert.equal(calls[2], 'add-generic-password -U -s workpulse-vault -a me -w KEYVALUE')
		assert.equal(calls[3], 'find-generic-password -s workpulse-vault -a me -w')
		assert.equal(calls.length, 5)
	})

	test('a security call that hangs is a Keychain that cannot be read, never a missing key, and the limit leaves time to answer a dialog', () => {
		assert.equal(SECURITY_TIMEOUT_MS, 120000)
		const d = dir()
		writeFileSync(join(d, 'security'), '#!/bin/sh\nexec sleep 20\n')
		chmodSync(join(d, 'security'), 0o755)
		const path = process.env.PATH
		process.env.PATH = `${d}:${path}`
		process.env.WP_VAULT_SECURITY_TIMEOUT_MS = '200'
		try {
			const started = Date.now()
			assert.throws(() => keystore.get('me'), /could not read the Keychain/)
			assert.throws(() => keystore.has('me'), /could not read the Keychain/)
			assert.throws(() => keystore.set('me', 'KEYVALUE'), (e) => /could not save/.test(e.message) && !e.message.includes('KEYVALUE'))
			assert.ok(Date.now() - started < 15000, 'the calls were stopped, not waited out')
		} finally {
			process.env.PATH = path
			delete process.env.WP_VAULT_SECURITY_TIMEOUT_MS
		}
	})

	test('the macOS store tells "not found" from a Keychain it cannot read, and never echoes the key', () => {
		const d = dir()
		const sh = (body) => {
			writeFileSync(join(d, 'security'), `#!/bin/sh\n${body}\n`)
			chmodSync(join(d, 'security'), 0o755)
		}
		const path = process.env.PATH
		const key = 'AGE-SECRET-KEY-1' + 'Q'.repeat(50)
		const clean = (e) => /could not (read|save)/.test(e.message) && !e.message.includes(key)
		try {
			process.env.PATH = `${d}:${path}`
			sh('exit 44')
			assert.equal(keystore.get('me'), null)
			assert.equal(keystore.has('me'), false)
			for (const code of [1, 36, 51]) {
				sh(`exit ${code}`)
				assert.throws(() => keystore.get('me'), clean)
				assert.throws(() => keystore.has('me'), clean)
			}
			sh('exit 1')
			assert.throws(() => keystore.set('me', key), clean)
			process.env.PATH = dir() // no `security` at all (r.error)
			assert.throws(() => keystore.get('me'), clean)
			assert.throws(() => keystore.has('me'), clean)
			assert.throws(() => keystore.set('me', key), clean)
		} finally {
			process.env.PATH = path
		}
	})
})

// node --test cli/memory-mask.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FILE_SECRET_SHAPES } from './library.mjs'
import { maskSecrets } from './memory-mask.mjs'
import { withinBudget } from './sandbox.mjs'
const { secretsIn, SECRET_SHAPES } = await import(join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'src', 'core', 'bridge.ts'))

// Synthetic values, built from parts so no scanner mistakes this file for a leak.
const SAMPLES = {
	'GitHub token': 'gh' + 'p_a1B2c3D4e5F6g7H8i9J0k1L2',
	'API key': 'sk-' + 'ant-abcdefghij0123456789abcd',
	'Supabase token': 'sb' + 'p_0123456789abcdef0123456789',
	'AWS key': 'AK' + 'IAABCDEFGHIJKLMNOP',
	'Slack token': 'xo' + 'xb-1234567890-abcdefghij',
	'Private key': '-----BEGIN RSA PRIVATE KEY-----',
	JWT: 'ey' + 'JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
	'age secret key': 'AGE-SECRET-' + 'KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQ',
	'Google API key': 'AI' + 'za0123456789abcdefghijklmnopqrstuvwx',
	'Google OAuth token': 'ya' + '29.a0AbCdEfGhIjKlMnOpQrSt',
	'Resend key': 're' + '_Ab12Cd34Ef56Gh78Ij90Kl',
	'NVIDIA key': 'nv' + 'api-abcdefghij0123456789',
	'Stripe live key': 'sk' + '_live_abcdefghij012345',
	'Secret key (sk_)': 'sk' + '_abcdefghij0123456789abcdef',
	'Razorpay key': 'rz' + 'p_live_abcdefghij12',
	'DigitalOcean token': 'do' + 'p_v1_0123456789abcdef0123456789',
	'Cashfree key': 'cf' + 'sk_abcdefghij12',
}

test('every secret shape has a sample, and the sample is gone after masking', () => {
	const names = [...new Set([...SECRET_SHAPES, ...FILE_SECRET_SHAPES].map(([n]) => n))]
	for (const name of names) assert.ok(SAMPLES[name], `no sample for shape "${name}"`)
	for (const name of names) {
		const s = SAMPLES[name]
		const out = maskSecrets(`before ${s} after`)
		assert.ok(!out.text.includes(s), `${name}: value still there`)
		assert.deepEqual(secretsIn(out.text), [], `${name}: still looks like a secret`)
		assert.ok(out.hits.length > 0, `${name}: no hit recorded`)
		assert.ok(out.text.startsWith('before '))
		if (name !== 'Private key') assert.ok(out.text.endsWith(' after')) // an unclosed PEM header masks to the end, by design
	}
})

test('a hit is [masked:<shape name>] and hits hold names only', () => {
	const out = maskSecrets(`key ${SAMPLES['AWS key']}`)
	assert.equal(out.text, 'key [masked:AWS key]')
	assert.deepEqual(out.hits, ['AWS key'])
})

test('service_role alone stays; sbp_ and a JWT beside it are masked', () => {
	assert.equal(maskSecrets('the service_role key must never reach the client').text, 'the service_role key must never reach the client')
	const out = maskSecrets(`service_role ${SAMPLES.JWT} and ${SAMPLES['Supabase token']}`)
	assert.ok(!out.text.includes(SAMPLES.JWT) && !out.text.includes(SAMPLES['Supabase token']))
	assert.ok(out.text.includes('service_role'))
})

test('a PEM block is masked from BEGIN through END, and to the end when unclosed', () => {
	const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nKcwggSjAgEAAoIBAQC7\n'
	const closed = maskSecrets(`a\n-----BEGIN PRIVATE KEY-----\n${body}-----END PRIVATE KEY-----\nb`)
	assert.ok(!closed.text.includes('MIIEvQ') && !closed.text.includes('END PRIVATE'))
	assert.ok(closed.text.startsWith('a\n') && closed.text.endsWith('\nb'))
	const open = maskSecrets(`a\n-----BEGIN OPENSSH PRIVATE KEY-----\n${body}and the rest`)
	assert.ok(!open.text.includes('MIIEvQ') && !open.text.includes('and the rest'))
	assert.ok(open.text.startsWith('a\n'))
})

test('name-value pairs, headers and URL credentials are masked', () => {
	const cases = [
		['FOO_SECRET=hunter2hunter2', 'hunter2hunter2'],
		['export API_KEY="abc 123 def"', 'abc 123 def'],
		['PASSWORD: s3cr3t', 's3cr3t'],
		['{"password": "s3cr3t"}', 's3cr3t'],
		['Authorization: Bearer x1y2z3', 'x1y2z3'],
		['Authorization: Bearer x', ': Bearer x'],
		['curl -H "Authorization: Basic dXNlcjpwYXNz"', 'dXNlcjpwYXNz'],
		['GET /cb?access_token=abc123def456&x=1', 'abc123def456'],
		['API_KEY="unclosed value', 'unclosed value'],
	]
	for (const [input, gone] of cases) {
		const out = maskSecrets(input)
		assert.ok(!out.text.includes(gone), `${input} -> ${out.text}`)
		assert.ok(out.hits.length > 0)
	}
	const url = maskSecrets('DATABASE_URL=postgres://u:p4ss@h.example/db')
	assert.ok(url.text.includes('postgres://u:') && url.text.includes('@h.example/db') && !url.text.includes('p4ss'))
	const redis = maskSecrets('redis://:p4ss@cache:6379')
	assert.ok(!redis.text.includes('p4ss') && redis.text.includes('@cache:6379'))
	const env = ['# app', 'NODE_ENV=production', 'SUPABASE_URL=https://x.example', 'DB_PASSWORD=abcd1234', 'STRIPE_SECRET=zzzz9999', 'AUTH_TOKEN=tok_12345678', 'PORT=3000'].join('\n')
	const out = maskSecrets(env).text
	for (const v of ['abcd1234', 'zzzz9999', 'tok_12345678']) assert.ok(!out.includes(v))
	assert.ok(out.includes('NODE_ENV=production') && out.includes('PORT=3000') && out.includes('DB_PASSWORD='))
})

test('code that only reads a secret, plain prose, a commit id and Marathi are left alone', () => {
	const same = [
		'password: process.env.X',
		'git commit -m "fix token refresh"',
		'commit 3f786850e387550fdab836ed7e6dc881de23001b',
		'API_KEY=${API_KEY}',
		'आज टोकन आणि पासवर्ड बदलला, काम पूर्ण झाले',
		'nothing to see here',
		'',
	]
	for (const s of same) {
		const out = maskSecrets(s)
		assert.equal(out.text, s)
		assert.deepEqual(out.hits, [])
	}
})

test('masking twice gives the same text', () => {
	const t = `a ${SAMPLES.JWT}\nPASSWORD: s3cr3t\nAuthorization: Bearer abcdef123456\npostgres://u:p@h/db\nTOKEN="a b"\n-----BEGIN PRIVATE KEY-----\nabc`
	const once = maskSecrets(t).text
	assert.equal(maskSecrets(once).text, once)
})

test('a 2.3 MB line of near-matches is masked in under 2 s', (t) => {
	const pieces = ['sk-' + 'aaaaaaaaaaaaaaaaaaa ', 'eyJ' + 'aaaaaaaaaaaaa-', 'sbp' + '_aaaaaaaaaa ', '-----BEGIN PRIVATE KEY- ', 'token=', 're_' + 'aaaa', 'ab://b:c', 'AGE-SECRET-KEY-1AAAA ', 'github_pat_aaaa', 'Authorization: ', 'sk-', 'nvapi-', 'xoxb-aaaa-', 'eyJaaaaaaaaaaaaa.', 'AIza', 're_re_', 'eyJaaaaaaaaaaaaa-.', 'ab://u:' + 'p'.repeat(400), 'password = ', 'secret: |\n  a\n', 'password:\n', 'SG.aaaaaaaaaaaaaaaa-', 'glpat-', '--password ', 'Cookie: ', '?key=', '-----END PRIVATE KEY-----\n', 'MIIE' + 'a'.repeat(60) + '\n']
	for (const piece of pieces) {
		const line = piece.repeat(Math.ceil(2_300_000 / piece.length))
		const t0 = Date.now()
		maskSecrets(line)
		withinBudget(t, Date.now() - t0, 2000, JSON.stringify(piece))
	}
	const mixed = pieces.join('').repeat(Math.ceil(2_300_000 / pieces.join('').length))
	const t0 = Date.now()
	maskSecrets(mixed)
	withinBudget(t, Date.now() - t0, 2000, 'the mixed line')
})

// One regression per bypass found in review (values are the marker V; token-shaped ones are built from SAMPLES).
const V = 'ZQSECRETVALQZ'
const G = SAMPLES['GitHub token']
const A = SAMPLES['AWS key']
const BODY = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCPEMBODY\nKcwggSjAgEAAoIBAQC7PEMBODY\n'
const BYPASSES = {
	'C1 escaped JSON password': [`{\\"password\\":\\"${V}\\"}`, V],
	'C1 escaped JSON api_key spaced': [`{\\"api_key\\": \\"${V}\\"}`, V],
	'C1 escaped Authorization, short value': [`\\"Authorization\\": \\"Bearer ${V}\\"`, V],
	'C2 comma in bare': [`PASSWORD=abc,${V}`, V],
	'C2 semicolon in bare': [`TOKEN=abc;${V}`, V],
	'C2 backtick in bare': ['SECRET=abc`' + V, V],
	'C2 double quote in bare': [`PASSWORD=ab"${V}`, V],
	'C2 apostrophe in bare': [`PASSWORD=ab'${V}`, V],
	'C2 escaped quote in quoted': [`{"password": "ab\\"${V}"}`, V],
	'C2 multi-line quoted value': [`SECRET_VAL="line1\n${V}\nline3"`, V],
	'C2 unquoted value with spaces': [`PASSWORD: correct ${V} staple`, V],
	'C2 bare value over 4000': [`TOKEN=${'a'.repeat(4000)}${V}`, V],
	'C2 quoted value over 4000': [`TOKEN="${'a'.repeat(4000)}${V}"`, V],
	'C3 =>': [`password => "${V}"`, V],
	'C3 :=': [`password := "${V}"`, V],
	'C3 ==': [`if password == "${V}":`, V],
	'C4 DB_PASS': [`DB_PASS=${V}`, V],
	'C4 SMTP_PASS': [`SMTP_PASS=${V}`, V],
	'C4 PASSPHRASE': [`PASSPHRASE=${V}`, V],
	'C4 OPENAI_KEY': [`OPENAI_KEY=${V}`, V],
	'C4 ENCRYPTION_KEY': [`ENCRYPTION_KEY=${V}`, V],
	'C4 JWT_SIGNING_KEY': [`JWT_SIGNING_KEY=${V}`, V],
	'C4 SUPABASE_SERVICE_ROLE_KEY': [`SUPABASE_SERVICE_ROLE_KEY=${V}`, V],
	'C4 AUTH_SALT': [`AUTH_SALT=${V}`, V],
	'C4 BASIC_AUTH': [`BASIC_AUTH=user:${V}`, V],
	'C5 URL password with a slash': [`postgres://u:ab/${V}@h/db`, V],
	'C5 URL password with an @': [`postgres://u:ab@${V}@h/db`, V],
	'C5 token in the user position': [`https://${V}@github.example/o/r.git`, V],
	'C5 DSN': [`SENTRY_DSN=https://${V}@o1.ingest.example/1`, V],
	'C5 scheme over 21 characters': [`${'a'.repeat(23)}://u:${V}@h`, V],
	'C6 token after underscore in a path': [`/tmp/backup_${G}.txt`, G],
	'C6 token after a letter': [`/tmp/x${G}.txt`, G],
	'C6 percent-encoded path': [`%2Ftmp%2F${G}%2Fx`, G],
	'C6 sbp_ after underscore': [`/tmp/key_${SAMPLES['Supabase token']}`, SAMPLES['Supabase token']],
	'C6 sk- after underscore': [`/tmp/key_${SAMPLES['API key']}`, SAMPLES['API key']],
	'C6 AKIA after underscore': [`/tmp/key_${A}`, A],
	'C6 AKIA before underscore': [`/tmp/${A}_old`, A],
	'C6 AKIA after a digit': [`/tmp/1${A}`, A],
	'C7 shell default': [`POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:-${V}}`, V],
	'C7 literal after a template': [`PASSWORD=\${X}${V}`, V],
	'C7 literal after process.env-': [`PASSWORD=process.env-${V}`, V],
	'C7 getenv inside quotes': [`password: "getenv ${V}"`, V],
	'C7 unclosed mask': [`PASSWORD=[masked:${V}`, V],
	'C7 || fallback': [`password: process.env.X || "${V}"`, V],
	'C7 ?? fallback': [`const token = process.env.T ?? '${V}'`, V],
	'C8 END line and the body above it': [`${BODY}-----END PRIVATE KEY-----\nrest`, 'PEMBODY'],
	'C8 bare body': [BODY, 'PEMBODY'],
	'C8 lowercase header': [`-----begin private key-----\n${BODY}`, 'PEMBODY'],
	'C8 four dashes': [`----BEGIN PRIVATE KEY----\n${BODY}`, 'PEMBODY'],
	'C8 double spaces': [`-----BEGIN  PRIVATE  KEY-----\n${BODY}`, 'PEMBODY'],
	'C8 label of 41 capitals': [`-----BEGIN ${'A'.repeat(41)} PRIVATE KEY-----\n${BODY}`, 'PEMBODY'],
	'C8 JSON-escaped newlines': ['{"private_key":"-----BEGIN PRIVATE KEY-----\\nMIIEPEMBODY\\n-----END PRIVATE KEY-----\\n"}', 'PEMBODY'],
	'I1 Authorization Custom': [`Authorization: Custom ${V}`, V],
	'I1 Authorization Bot': [`Authorization: Bot ${V}`, V],
	'I1 Authorization NTLM': [`Authorization: NTLM ${V}`, V],
	'I1 Authorization Digest': [`Authorization: Digest username="bob", response="${V}"`, V],
	'I1 Authorization AWS4': [`Authorization: AWS4-HMAC-SHA256 Credential=x, SignedHeaders=host, Signature=${V}`, V],
	'I2 --password value': [`mysql --password ${V}`, V],
	'I2 --token value': [`tool --token ${V}`, V],
	'I2 --api-key value': [`tool --api-key ${V}`, V],
	'I2 mysql -p attached': [`mysql -uroot -p${V}`, V],
	'I2 sshpass -p': [`sshpass -p ${V} ssh h`, V],
	'I2 curl -u': [`curl -u me:${V} https://x.example`, V],
	'I3 Cookie': [`Cookie: session=${V}`, V],
	'I3 Set-Cookie': [`Set-Cookie: sid=${V}; Path=/`, V],
	'I3 X-Auth': [`X-Auth: ${V}`, V],
	'I3 ?key=': [`https://x.example/a?key=${V}`, V],
	'I3 &sig=': [`https://x.blob.example/c?sv=1&sig=${V}`, V],
	'I3 X-Amz-Signature': [`https://s3.example/o?X-Amz-Signature=${V}`, V],
	'I3 &pass=': [`https://x.example/a?user=u&pass=${V}`, V],
	'I4 five-part token': [`${SAMPLES.JWT}.${V}.tagtagtagtag`, V],
	'I4 short signature': [`ey${'JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc'}`, 'eyJzdWI'],
	'I4 empty signature': [`ey${'JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.'}`, 'eyJzdWI'],
	'M2 Devanagari keyword': [`पासवर्ड: ${V}`, V],
}

test('each bypass found in review is masked, and masking the result changes nothing', () => {
	for (const [name, [input, gone]] of Object.entries(BYPASSES)) {
		const out = maskSecrets(input)
		assert.ok(!out.text.includes(gone), `${name}: still in the text: ${out.text.slice(0, 120)}`)
		assert.ok(out.hits.length > 0, `${name}: no hit`)
		assert.equal(maskSecrets(out.text).text, out.text, `${name}: not idempotent`)
	}
})

test('what the fixes must not touch: references, user names, plural tokens, task- is not sk-', () => {
	const same = [
		'max_tokens: 4096',
		'input_tokens=12',
		'password: process.env.X',
		'const token = process.env.T',
		'POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}',
		'git clone ssh://git@github.example/o/r.git',
		'see https://a.example:8080/x?y=z@w',
		'https://a.example/o/r',
		'/tmp/task-' + 'a'.repeat(30),
		'primary_key: id',
	]
	for (const t of same) assert.equal(maskSecrets(t).text, t, t)
	assert.ok(!maskSecrets('token: 4096').text.includes('4096'), 'a bare number after a singular token is masked')
	assert.ok(!maskSecrets('password: 12345678').text.includes('12345678'))
	assert.equal(maskSecrets('postgres://u:p4ss@h/db').text, 'postgres://u:[masked:URL password]@h/db')
})

// Fix round 2: YAML bodies, vendor tokens, plural tokens.
const VENDOR_SAMPLES = {
	'GitLab token': 'gl' + 'pat-abcdefghij0123456789',
	'npm token': 'np' + 'm_abcdefghij0123456789abcdefghij012345',
	'Hugging Face token': 'h' + 'f_abcdefghij0123456789abcdefghij',
	'SendGrid key': 'S' + 'G.abcdefghij0123456789.abcdefghij0123456789',
	'Webhook secret': 'wh' + 'sec_abcdefghij0123456789',
	'Stripe restricted key': 'r' + 'k_live_abcdefghij0123456789',
	'Slack app token': 'xa' + 'pp-1-abcdefghij0123456789',
	'AWS session key': 'AS' + 'IAABCDEFGHIJKLMNOP',
	'Groq key': 'gs' + 'k_abcdefghij0123456789abcdefghij',
	'Supabase secret key': 'sb' + '_secret_abcdefghij0123456789',
	'DigitalOcean refresh token': 'do' + 'r_v1_0123456789abcdef0123456789',
	'PyPI token': 'py' + 'pi-abcdefghij0123456789abcdef',
}

test('every vendor shape has a sample; it is masked alone, in a path and after a letter-less boundary', async () => {
	const { VENDOR_SHAPES } = await import('./memory-mask.mjs')
	for (const [name] of VENDOR_SHAPES) assert.ok(VENDOR_SAMPLES[name], `no sample for "${name}"`)
	for (const [name, sample] of Object.entries(VENDOR_SAMPLES)) {
		for (const t of [sample, `x=${sample};`, `/tmp/k_${sample}.txt`]) {
			const out = maskSecrets(t)
			assert.ok(!out.text.includes(sample.slice(5)), `${name}: ${out.text}`)
		}
	}
	const publishable = 'sb' + '_publishable_abcdefghij0123456789'
	assert.equal(maskSecrets(`key ${publishable}`).text, `key ${publishable}`)
})

test('YAML block scalars and a value on the next lines are masked; the lines around them are not', () => {
	const cases = [
		[`private_key: |\n  ${V}\n  more${V}\nnext: 1`, 'private_key: |\n[masked:Named secret]\nnext: 1'],
		[`api_key: >\n    ${V}\nnext: 1`, 'api_key: >\n[masked:Named secret]\nnext: 1'],
		[`password:\n  ${V}\nuser: me`, 'password:\n[masked:Named secret]\nuser: me'],
		[`  - token: |-\n      ${V}\n  - other: 1`, '  - token: |-\n[masked:Named secret]\n  - other: 1'],
		[`secret: |\n  ${V}`, 'secret: |\n[masked:Named secret]'],
	]
	for (const [input, want] of cases) {
		const out = maskSecrets(input)
		assert.ok(!out.text.includes(V))
		assert.equal(out.text, want)
		assert.equal(maskSecrets(out.text).text, out.text)
	}
	assert.equal(maskSecrets('password:\nuser: me').text, 'password:\nuser: me')
})

test('a plural tokens keeps a following number; a singular token does not', () => {
	for (const t of ['max_tokens: 4096, temp: 1', '"max_tokens": 4096,', 'tokens: 12 used', 'input_tokens=12', 'f(max_tokens=100)']) assert.equal(maskSecrets(t).text, t, t)
	for (const t of ['token: 4096', 'TOKEN=12', 'tokens: abc12345']) assert.ok(!/4096|=12|abc12345/.test(maskSecrets(t).text), t)
})

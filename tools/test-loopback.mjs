// Full data-path test: drives the host half against the loopback test double so
// the whole chain (encode -> send -> log -> incremental read -> decode) runs
// without serial hardware. Exercises only this package's own code; the OS-level
// System.IO.Ports read is covered by lib/serial-helper.ps1's own protocol test.
import http from 'node:http'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

// Point the host half at the hardware-free bridge before importing it.
process.env.DSH_SERIAL_HELPER = join(here, 'fake-serial-bridge.ps1')

const { apply, name } = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)

const disposers = []
const routes = []
const webCtx = {
	effect: (fn) => { disposers.push(fn()) },
	webServer: { register: (route) => { routes.push(route); return () => {} } },
}
apply({ effect: (fn) => { disposers.push(fn()) }, inject: (deps, cb) => cb(webCtx) })

const server = http.createServer((req, res) => {
	const route = routes.find((r) => req.url.startsWith(r.path))
	if (!route) { res.writeHead(404); res.end(); return }
	Promise.resolve(route.handler(req, res)).catch(() => { res.writeHead(500); res.end() })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/dsh-serial-debugger`

const results = []
function check(label, ok, detail) {
	results.push({ label, ok })
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`)
}
const call = async (path, init) => (await fetch(base + path, init)).json()
const post = (path, body) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
const bytesOf = (b64) => Buffer.from(b64, 'base64')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** Poll the tail until `predicate(lines)` holds, so event arrival latency is not a race. */
async function waitForLines(predicate, timeoutMs = 5000) {
	const started = Date.now()
	let last = []
	while (Date.now() - started < timeoutMs) {
		const frame = await call('/state?since=-1')
		last = frame.lines
		if (predicate(last)) return frame
		await wait(60)
	}
	return { lines: last, next: -1, timedOut: true }
}

let r = await call('/ports')
const portNames = Array.isArray(r.ports) ? r.ports.map((p) => (typeof p === 'string' ? p : p && p.name)) : null
check('test double enumerates synthetic ports', r.ok && portNames !== null && portNames.join(',') === 'COMFAKE1,COMFAKE2', JSON.stringify(r.ports))
check('ports carry a device description', r.ok && r.ports[0] !== undefined && r.ports[0].description === 'Loopback A', JSON.stringify(r.ports[0]))

r = await post('/open', { port: 'COMFAKE1', baudRate: 9600, dataBits: 8, parity: 'None', stopBits: 'One', handshake: 'None' })
check('open succeeds against the double', r.ok === true && r.status.connected === true, JSON.stringify(r.config))
check('negotiated settings are echoed back', r.config && r.config.baudRate === 9600 && r.config.port === 'COMFAKE1', JSON.stringify(r.config))

// The double greets with a fixed banner; the host must surface it as rx lines.
r = await waitForLines((lines) => lines.filter((l) => l.kind === 'rx').length >= 2)
const rx = r.lines.filter((l) => l.kind === 'rx')
check('banner arrives as receive lines', rx.length === 2, `rx=${rx.length}`)
check('first banner chunk round-trips byte-exactly', rx[0] && bytesOf(rx[0].b64).toString('hex') === 'aa550102', rx[0] && bytesOf(rx[0].b64).toString('hex'))
check('second banner chunk decodes as text', rx[1] && bytesOf(rx[1].b64).toString('utf8') === 'Hello\n', rx[1] && JSON.stringify(bytesOf(rx[1].b64).toString('utf8')))
check('log cursor advances past the banner', typeof r.next === 'number' && r.next >= 3, String(r.next))

// Incremental read: nothing new since the reported cursor.
const cursor = r.next
r = await call(`/state?since=${cursor}`)
check('no new lines right after the cursor', r.lines.length === 0, `lines=${r.lines.length}`)

// Send a payload; the loopback double must echo it back as RX.
r = await post('/send', { base64: Buffer.from('PING').toString('base64'), label: 'PING' })
check('send is accepted', r.ok === true, JSON.stringify(r))

r = await waitForLines((lines) => lines.some((l) => l.kind === 'rx' && bytesOf(l.b64).toString('utf8') === 'PING'))
const tx = r.lines.filter((l) => l.kind === 'tx')
const echoed = r.lines.filter((l) => l.kind === 'rx' && bytesOf(l.b64).toString('utf8') === 'PING')
check('transmit is recorded in the log', tx.length === 1 && bytesOf(tx[0].b64).toString('utf8') === 'PING', JSON.stringify(tx.map((l) => bytesOf(l.b64).toString())))
check('loopback echo returns as receive data', echoed.length === 1, JSON.stringify(echoed.map((l) => bytesOf(l.b64).toString())))
check('transmit precedes its echo in arrival order', r.lines.findIndex((l) => l.kind === 'tx') < r.lines.findIndex((l) => l.kind === 'rx' && bytesOf(l.b64).toString('utf8') === 'PING'), r.lines.map((l) => l.kind).join(','))

// Binary-safe round trip through hex-mode encoding.
const binary = Buffer.from([0x00, 0xff, 0x0a, 0x0d, 0x80]).toString('base64')
await post('/send', { base64: binary, label: '00 FF 0A 0D 80' })
r = await waitForLines((lines) => lines.some((l) => l.kind === 'rx' && l.b64 === binary))
const last = r.lines[r.lines.length - 1]
check('arbitrary bytes survive the round trip', last.kind === 'rx' && Buffer.from(last.b64, 'base64').equals(Buffer.from(binary, 'base64')), last && Buffer.from(last.b64, 'base64').toString('hex'))

r = await post('/close')
check('close succeeds', r.ok === true && r.status.connected === false, JSON.stringify(r.status))

r = await post('/send', { base64: 'AQID' })
check('send after close is refused', r.ok === false && /not open/i.test(r.error), r.error)

r = await post('/clear')
r = await call('/state?since=-1')
check('clear empties the log', r.lines.length === 0, `lines=${r.lines.length}`)
check('host still reports the plugin name', name === 'serial-debugger', name)

for (const fn of disposers) { try { await fn() } catch { /* best effort */ } }
await new Promise((resolve) => server.close(resolve))
await new Promise((resolve) => setTimeout(resolve, 1200))

const failed = results.filter((x) => !x.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)

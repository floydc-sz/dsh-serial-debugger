// Protocol test for the POSIX bridge (lib/serial-helper.mjs).
//
// Drives the real bridge process with DSH_SERIAL_MODULE pointed at
// tools/fake-serialport.mjs, so the whole command/event surface is exercised
// with no hardware, no native build, and on any operating system — including
// Windows, which is the only place this suite gets run day to day.
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const HELPER = join(here, '..', 'lib', 'serial-helper.mjs')
const FAKE = join(here, 'fake-serialport.mjs')

const results = []
function check(label, ok, detail) {
	results.push({ label, ok })
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ' — ' + detail}`)
}

/** One bridge process plus a queue of the events it has emitted. */
function startBridge(modulePath = FAKE) {
	const child = spawn(process.execPath, [HELPER], {
		env: { ...process.env, DSH_SERIAL_MODULE: modulePath },
		stdio: ['pipe', 'pipe', 'pipe'],
	})
	const events = []
	const waiters = []
	let carry = ''
	let stderr = ''

	child.stdout.setEncoding('utf8')
	child.stdout.on('data', (chunk) => {
		carry += chunk
		for (;;) {
			const index = carry.indexOf('\n')
			if (index < 0) break
			const line = carry.slice(0, index).trim()
			carry = carry.slice(index + 1)
			if (line === '') continue
			let event
			try {
				event = JSON.parse(line)
			} catch {
				event = { type: '__unparsable', line }
			}
			events.push(event)
			for (const waiter of [...waiters]) waiter(event)
		}
	})
	child.stderr.setEncoding('utf8')
	child.stderr.on('data', (chunk) => {
		stderr += chunk
	})

	const api = {
		child,
		events,
		get stderr() {
			return stderr
		},
		send(command) {
			child.stdin.write(JSON.stringify(command) + '\n')
		},
		/** Wait for the next event matching the predicate, looking at what already arrived first. */
		waitFor(predicate, timeoutMs = 4000) {
			const existing = events.find(predicate)
			if (existing !== undefined) return Promise.resolve(existing)
			return new Promise((resolvePromise) => {
				const timer = setTimeout(() => {
					const index = waiters.indexOf(waiter)
					if (index >= 0) waiters.splice(index, 1)
					resolvePromise({ type: '__timeout' })
				}, timeoutMs)
				const waiter = (event) => {
					if (!predicate(event)) return
					clearTimeout(timer)
					const index = waiters.indexOf(waiter)
					if (index >= 0) waiters.splice(index, 1)
					resolvePromise(event)
				}
				waiters.push(waiter)
			})
		},
		exited() {
			return new Promise((resolvePromise) => {
				child.once('exit', (code) => resolvePromise(code))
			})
		},
		kill() {
			try {
				child.kill()
			} catch {
				// Already gone.
			}
		},
	}
	return api
}

const byType = (type) => (event) => event.type === type

// ── startup ────────────────────────────────────────────────────────────────
{
	const bridge = startBridge()
	const ready = await bridge.waitFor(byType('ready'))
	check('bridge announces ready with its pid', ready.type === 'ready' && typeof ready.pid === 'number', `pid=${ready.pid}`)
	const ports = Array.isArray(ready.ports) ? ready.ports : []
	check('ready carries the enumerated ports', ports.length === 2, JSON.stringify(ports))
	check(
		'manufacturer becomes the description',
		ports[0]?.name === '/dev/ttyACM0' && ports[0]?.description === '2341:0043',
		JSON.stringify(ports[0]),
	)
	check(
		'usb adapter keeps its manufacturer name',
		ports[1]?.name === '/dev/ttyUSB0' && ports[1]?.description === 'FTDI',
		JSON.stringify(ports[1]),
	)
	check(
		'legacy /dev/ttyS* ports are filtered out',
		ports.every((port) => !/^\/dev\/ttyS\d+$/.test(port.name)),
		ports.map((port) => port.name).join(','),
	)

	bridge.send({ op: 'ping' })
	const pong = await bridge.waitFor(byType('pong'))
	check('ping answers with pong', pong.type === 'pong')

	bridge.send({ op: 'list' })
	const listed = await bridge.waitFor(byType('ports'))
	check('list re-enumerates', Array.isArray(listed.ports) && listed.ports.length === 2, `${listed.ports?.length}`)

	// ── open / negotiated settings ──────────────────────────────────────────
	bridge.send({ op: 'open', port: '/dev/ttyUSB0', baudRate: 9600, dataBits: 8, parity: 'None', stopBits: 'One', handshake: 'None' })
	const opened = await bridge.waitFor(byType('opened'))
	check('open reports the negotiated port', opened.type === 'opened' && opened.port === '/dev/ttyUSB0', JSON.stringify(opened))
	check('opened echoes the host spelling of the enum values', opened.parity === 'None' && opened.stopBits === 'One' && opened.handshake === 'None', `${opened.parity}/${opened.stopBits}/${opened.handshake}`)
	check('opened echoes baud rate and data bits', opened.baudRate === 9600 && opened.dataBits === 8, `${opened.baudRate}/${opened.dataBits}`)

	// ── write → written → loopback data ─────────────────────────────────────
	bridge.send({ op: 'write', base64: Buffer.from('PING').toString('base64') })
	const written = await bridge.waitFor(byType('written'))
	check('write reports the byte count', written.type === 'written' && written.count === 4, `count=${written.count}`)
	const data = await bridge.waitFor(byType('data'))
	const bytes = typeof data.base64 === 'string' ? Buffer.from(data.base64, 'base64') : Buffer.alloc(0)
	check('loopback echoes the payload', bytes.toString('utf8') === 'PING', bytes.toString('utf8'))
	check('data events carry an arrival time', typeof data.at === 'number' && data.at > 0, `${data.at}`)

	// ── binary payloads survive ─────────────────────────────────────────────
	const binary = Buffer.from([0x00, 0xff, 0x0a, 0x0d, 0x80])
	bridge.send({ op: 'write', base64: binary.toString('base64') })
	const echo = await bridge.waitFor((event) => event.type === 'data' && event.base64 === binary.toString('base64'))
	check('arbitrary bytes round-trip', echo.type === 'data', echo.base64)

	// ── close ───────────────────────────────────────────────────────────────
	bridge.send({ op: 'close' })
	const closed = await bridge.waitFor(byType('closed'))
	check('close reports closed', closed.type === 'closed')
	bridge.send({ op: 'write', base64: 'AQID' })
	const refused = await bridge.waitFor((event) => event.type === 'error' && event.op === 'write')
	check('write after close is refused', /not open/i.test(refused.message), refused.message)

	bridge.send({ op: 'shutdown' })
	const exitCode = await bridge.exited()
	const bye = bridge.events.filter(byType('bye')).length
	check('shutdown emits bye and exits cleanly', bye === 1 && exitCode === 0, `bye=${bye} exit=${exitCode}`)
}

// ── parameter mapping and rejections ───────────────────────────────────────
{
	const bridge = startBridge()
	await bridge.waitFor(byType('ready'))

	for (const [parity, expected] of [['Odd', 'Odd'], ['Even', 'Even'], ['Mark', 'Mark'], ['Space', 'Space']]) {
		bridge.send({ op: 'open', port: '/dev/ttyUSB0', parity })
		const opened = await bridge.waitFor((event) => event.type === 'opened' && event.parity === expected)
		check(`parity ${parity} maps through to ${expected}`, opened.type === 'opened', opened.parity)
	}

	bridge.send({ op: 'open', port: '/dev/ttyUSB0', stopBits: 'Two' })
	const twoStop = await bridge.waitFor((event) => event.type === 'opened' && event.stopBits === 'Two')
	check('two stop bits are accepted', twoStop.type === 'opened', twoStop.stopBits)

	bridge.send({ op: 'open', port: '/dev/ttyUSB0', stopBits: 'OnePointFive' })
	const oneFive = await bridge.waitFor((event) => event.type === 'error' && event.op === 'open')
	check(
		'1.5 stop bits are rejected with a specific reason',
		/1\.5 stop bits is not supported/i.test(oneFive.message),
		oneFive.message,
	)

	bridge.send({ op: 'open', port: '/dev/ttyUSB0', handshake: 'RequestToSend' })
	const rts = await bridge.waitFor((event) => event.type === 'opened' && event.handshake === 'RequestToSend')
	check('RTS/CTS handshake is accepted', rts.type === 'opened', rts.handshake)

	bridge.kill()
}

// ── error reporting ────────────────────────────────────────────────────────
{
	const bridge = startBridge()
	await bridge.waitFor(byType('ready'))

	bridge.send({ op: 'open', port: '' })
	const noPort = await bridge.waitFor((event) => event.type === 'error' && event.op === 'open')
	check('an empty port name is refused', /no port name supplied/i.test(noPort.message), noPort.message)

	bridge.send({ op: 'open', port: '/dev/EACCES0' })
	const denied = await bridge.waitFor((event) => event.type === 'error' && /dialout/.test(event.message))
	check(
		'a permission failure names the group to join',
		/udisks|dialout/.test(denied.message) && /usermod/.test(denied.message),
		denied.message,
	)

	bridge.send({ op: 'open', port: '/dev/ENOENT1' })
	const missing = await bridge.waitFor((event) => event.type === 'error' && /does not exist/.test(event.message))
	check('a missing device says so', /does not exist/.test(missing.message), missing.message)

	bridge.send({ op: 'open', port: '/dev/EBUSY2' })
	const busy = await bridge.waitFor((event) => event.type === 'error' && /already in use/.test(event.message))
	check('a busy device points at the other program', /already in use/.test(busy.message), busy.message)

	bridge.send({ op: 'write', base64: '' })
	const noPayload = await bridge.waitFor((event) => event.type === 'error' && event.op === 'write')
	check('an empty payload is refused', /not open|no payload/i.test(noPayload.message), noPayload.message)

	bridge.send({ op: 'nonsense' })
	const unknown = await bridge.waitFor((event) => event.type === 'error' && event.op === 'nonsense')
	check('an unknown op is reported, not fatal', /unknown op/i.test(unknown.message), unknown.message)

	bridge.child.stdin.write('{not json}\n')
	const badJson = await bridge.waitFor((event) => event.type === 'error' && event.op === 'parse')
	check('malformed JSON is reported, not fatal', /invalid JSON/i.test(badJson.message), badJson.message)

	bridge.child.stdin.write('{"op":null}\n')
	const noOp = await bridge.waitFor((event) => event.type === 'error' && /has no "op" field/i.test(event.message))
	check('a command without op is reported', /has no "op" field/i.test(noOp.message), noOp.message)

	bridge.send({ op: 'shutdown' })
	await bridge.exited()
}

// ── a missing binding is reported once and does not hang the host ──────────
{
	const bridge = startBridge(join(here, 'no-such-serialport-module.mjs'))
	const ready = await bridge.waitFor(byType('ready'))
	check('ready still arrives when the binding is missing', ready.type === 'ready', JSON.stringify(ready))
	check('ready reports no ports in that case', Array.isArray(ready.ports) && ready.ports.length === 0, JSON.stringify(ready.ports))
	const moduleError = await bridge.waitFor((event) => event.type === 'error' && event.op === 'module')
	check(
		'the missing binding error explains how to install it',
		/serialport binding is unavailable/i.test(moduleError.message) && /npm install serialport/.test(moduleError.message),
		moduleError.message,
	)
	bridge.send({ op: 'ping' })
	const pong = await bridge.waitFor(byType('pong'))
	check('the bridge keeps serving after that error', pong.type === 'pong')
	bridge.send({ op: 'shutdown' })
	await bridge.exited()
}

// ── stdin closing (host death) releases the port and exits ─────────────────
{
	const bridge = startBridge()
	await bridge.waitFor(byType('ready'))
	bridge.send({ op: 'open', port: '/dev/ttyUSB0' })
	await bridge.waitFor(byType('opened'))
	bridge.child.stdin.end()
	const exitCode = await bridge.exited()
	const bye = bridge.events.filter(byType('bye')).length
	check('closing stdin emits bye and exits', bye === 1 && exitCode === 0, `bye=${bye} exit=${exitCode}`)
}

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)

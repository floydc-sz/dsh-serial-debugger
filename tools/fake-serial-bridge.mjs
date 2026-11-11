// Test double for the serial bridge, speaking the identical NDJSON protocol
// without hardware: two synthetic ports, a fixed banner on open, and a loopback
// wire that echoes every written payload back as received data.
//
// This is the Node twin of the PowerShell double that used to live here. One
// double for every platform keeps the host-side test identical on Windows and
// on Linux, and lets the suite run where PowerShell does not exist.
//
// Selected through DSH_SERIAL_HELPER; the host runs a `.mjs` path with Node
// regardless of platform.
import { createInterface } from 'node:readline'

/** Banner payloads are BASE64 because the wire field is `base64`, not hex. */
const BANNER = [
	'qlUBAg==', // AA 55 01 02
	'SGVsbG8K', // "Hello\n"
]

/** The shape the host expects: one `{name, description}` record per port. */
const PORTS = [
	{ name: 'COMFAKE1', description: 'Loopback A' },
	{ name: 'COMFAKE2', description: 'Loopback B' },
]

let open = false

function emit(payload) {
	process.stdout.write(JSON.stringify(payload) + '\n')
}

function emitData(base64) {
	emit({ type: 'data', base64, at: Date.now() })
}

function handle(line) {
	let command
	try {
		command = JSON.parse(line)
	} catch {
		emit({ type: 'error', op: 'parse', message: 'invalid JSON' })
		return true
	}
	switch (String(command.op)) {
		case 'list':
			emit({ type: 'ports', ports: PORTS })
			return true
		case 'ping':
			emit({ type: 'pong' })
			return true
		case 'open': {
			open = true
			emit({
				type: 'opened',
				port: String(command.port),
				baudRate: Number(command.baudRate),
				dataBits: Number(command.dataBits),
				parity: String(command.parity),
				stopBits: String(command.stopBits),
				handshake: String(command.handshake),
			})
			// Greet the newly opened port with the fixed banner, in two events to
			// mimic chunked arrival.
			for (const payload of BANNER) emitData(payload)
			return true
		}
		case 'write': {
			if (!open) {
				emit({ type: 'error', op: 'write', message: 'the port is not open' })
				return true
			}
			const bytes = Buffer.from(String(command.base64), 'base64')
			emit({ type: 'written', count: bytes.length })
			// Loopback device: what was written comes straight back as RX.
			emitData(String(command.base64))
			return true
		}
		case 'close':
			open = false
			emit({ type: 'closed' })
			return true
		case 'shutdown':
			return false
		default:
			emit({ type: 'error', op: String(command.op), message: 'unknown op' })
			return true
	}
}

emit({ type: 'ready', pid: process.pid, ports: PORTS })

const reader = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })
let stopping = false

function stop() {
	if (stopping) return
	stopping = true
	open = false
	emit({ type: 'bye' })
	reader.close()
	setTimeout(() => process.exit(0), 30).unref()
}

reader.on('line', (line) => {
	const trimmed = line.trim()
	if (trimmed === '' || stopping) return
	if (handle(trimmed) === false) stop()
})
reader.on('close', () => stop())
process.on('SIGTERM', stop)
process.on('SIGINT', stop)

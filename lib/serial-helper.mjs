// dsh-serial-debugger — POSIX serial bridge over stdio.
//
// The Windows bridge (serial-helper.ps1) leans on System.IO.Ports, which ships
// with the OS there. Linux and macOS have no equivalent in the box, so this
// bridge drives the `serialport` native binding instead. The price is one npm
// dependency, paid only on the platforms that need it.
//
// The wire protocol is identical to the PowerShell bridge's, so the host half
// does not know which one it is talking to:
//
//   stdin   commands: {"op":"open"|"close"|"write"|"list"|"ping"|"shutdown", ...}
//   stdout    events: {"type":"ready"|"ports"|"opened"|"closed"|"data"
//                            |"written"|"error"|"pong"|"bye", ...}
//
// Enum values travel in their .NET spelling ("None", "One", "RequestToSend")
// because that is what the host validates and what the client renders. This
// bridge maps them to serialport's spelling in one place and echoes the same
// .NET names back in `opened`.
//
// `DSH_SERIAL_MODULE` substitutes the serialport binding with a stand-in, which
// is how this file's own tests run without hardware or a native build.

import { createInterface } from 'node:readline'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Defaults mirror the PowerShell bridge, DTR/RTS asserted being the important one. */
const DEFAULTS = { baudRate: 115200, dataBits: 8, parity: 'None', stopBits: 'One', handshake: 'None' }

/** .NET enum name -> serialport option. */
const PARITY_TO_OPTION = { none: 'none', odd: 'odd', even: 'even', mark: 'mark', space: 'space' }
/** serialport option -> .NET enum name, for the `opened` echo. */
const PARITY_TO_NAME = { none: 'None', odd: 'Odd', even: 'Even', mark: 'Mark', space: 'Space' }
/** .NET stop-bit name -> serialport value. `OnePointFive` has no POSIX equivalent. */
const STOP_BITS_TO_OPTION = { one: 1, two: 2 }
const STOP_BITS_TO_NAME = { 1: 'One', 2: 'Two' }
/** .NET handshake name -> serialport flow-control flags. */
const HANDSHAKE_TO_FLAGS = {
  none: {},
  xonxoff: { xon: true, xoff: true },
  requesttosend: { rtscts: true },
  requesttosendxonxoff: { rtscts: true, xon: true, xoff: true },
}
const HANDSHAKE_TO_NAME = {
  none: 'None',
  xonxoff: 'XOnXOff',
  requesttosend: 'RequestToSend',
  requesttosendxonxoff: 'RequestToSendXOnXOff',
}

/** The single open port, or null. */
let current = null
/** Resolved serialport module, cached after the first successful import. */
let binding = null
/** Why the binding is unavailable, when it is. */
let bindingError = null

/** Write one NDJSON event to stdout. Never throws: a reporting failure must not kill the bridge. */
function emit(payload) {
  try {
    process.stdout.write(JSON.stringify(payload) + '\n')
  } catch {
    // Nothing useful to do if stdout is gone; the stdin handler will notice.
  }
}

/** Report a command failure the way the PowerShell bridge does. */
function fail(op, message) {
  emit({ type: 'error', op, message })
}

/** Lower-case a name that may arrive in either the .NET or the serialport spelling. */
function normalizeName(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed === '' ? fallback : trimmed.toLowerCase()
}

/**
 * Resolve the module specifier for `DSH_SERIAL_MODULE`.
 *
 * A bare specifier ("serialport") is imported as-is; anything that looks like a
 * path is resolved against the working directory and turned into a file URL, so
 * tests can point at a stand-in by path.
 */
function moduleSpecifier() {
  const raw = typeof process.env.DSH_SERIAL_MODULE === 'string' ? process.env.DSH_SERIAL_MODULE.trim() : ''
  if (raw === '') return 'serialport'
  if (raw.startsWith('file://')) return raw
  const looksLikePath = isAbsolute(raw) || raw.startsWith('.') || /[\\/]/.test(raw) || /\.(mjs|cjs|js)$/i.test(raw)
  if (!looksLikePath) return raw
  return pathToFileURL(isAbsolute(raw) ? raw : resolve(process.cwd(), raw)).href
}

/** Import the serialport binding once; throws with a useful message when it is missing. */
async function loadBinding() {
  if (binding !== null) return binding
  if (bindingError !== null) throw bindingError
  const specifier = moduleSpecifier()
  try {
    const loaded = await import(specifier)
    const SerialPort = loaded.SerialPort ?? loaded.default?.SerialPort
    if (typeof SerialPort !== 'function') {
      throw new Error(`module "${specifier}" does not export SerialPort`)
    }
    binding = SerialPort
    return binding
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    bindingError = new Error(
      `the serialport binding is unavailable (${reason}). Install it with "npm install serialport" in the profile that runs this plugin.`,
    )
    throw bindingError
  }
}

/** Human label for a listed port; the manufacturer name is what a reader recognises. */
function describePort(entry) {
  const manufacturer = typeof entry.manufacturer === 'string' ? entry.manufacturer.trim() : ''
  if (manufacturer !== '') return manufacturer
  const vendor = typeof entry.vendorId === 'string' ? entry.vendorId.trim() : ''
  const product = typeof entry.productId === 'string' ? entry.productId.trim() : ''
  if (vendor !== '' && product !== '') return `${vendor}:${product}`
  return ''
}

/** Enumerate serial ports as `{name, description}`, the shape the host consumes. */
async function listPorts() {
  const SerialPort = await loadBinding()
  const entries = (await SerialPort.list()) ?? []
  const ports = []
  for (const entry of entries) {
    const name = typeof entry.path === 'string' ? entry.path : ''
    if (name === '') continue
    // /dev/ttyS* are the legacy 8250 ports the kernel always reports; without a
    // vendor id they are almost never the device someone plugged in, and listing
    // all 32 buries the real ones.
    if (/^\/dev\/ttyS\d+$/.test(name) && entry.vendorId === undefined && entry.manufacturer === undefined) continue
    ports.push({ name, description: describePort(entry) })
  }
  ports.sort((a, b) => a.name.localeCompare(b.name))
  return ports
}

/** Emit a `ports` event, or an error explaining why enumeration failed. */
async function emitPorts(type, op) {
  try {
    emit({ type, ports: await listPorts() })
  } catch (error) {
    emit({ type, ports: [] })
    fail(op, error instanceof Error ? error.message : String(error))
  }
}

/**
 * Turn a low-level open failure into something a reader can act on.
 *
 * The dominant Linux failure is permissions, not wiring: /dev/ttyUSB0 belongs to
 * the dialout (or uucp) group, and a message that says only "EACCES" sends the
 * reader looking in the wrong place.
 */
function explainOpenFailure(error, path) {
  const code = error !== null && typeof error === 'object' ? String(error.code ?? '') : ''
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'EACCES' || /permission denied|access denied/i.test(message)) {
    return (
      `permission denied opening ${path}. Add your user to the serial group and log back in: ` +
      `sudo usermod -aG dialout $USER (Ubuntu/Debian/Fedora) or sudo usermod -aG uucp $USER (Arch).`
    )
  }
  if (code === 'ENOENT' || /no such file|not found/i.test(message)) {
    return `${path} does not exist. Check that the adapter is plugged in and listed under "Refresh".`
  }
  if (code === 'EBUSY' || /resource busy/i.test(message)) {
    return `${path} is already in use by another program. Close its serial monitor and try again.`
  }
  return message
}

/** Resolve `fn(cb)`-style serialport calls into promises. */
function promisify(port, method, argument) {
  return new Promise((resolvePromise, rejectPromise) => {
    const settle = (error) => (error ? rejectPromise(error) : resolvePromise())
    try {
      if (argument === undefined) port[method](settle)
      else port[method](argument, settle)
    } catch (error) {
      rejectPromise(error)
    }
  })
}

/** Close and forget the open port. Safe to call when nothing is open. */
async function closePort() {
  const port = current
  current = null
  if (port === null) return
  // Listeners go first: without this the port's own `close` event would emit a
  // second `closed` for a close the command already reports.
  port.removeAllListeners('data')
  port.removeAllListeners('close')
  port.removeAllListeners('error')
  try {
    await promisify(port, 'close')
  } catch {
    // Closing an already-closed port is not an error worth surfacing.
  }
}

/** Open a port with validated settings, echoing what was negotiated. */
async function openPort(command) {
  await closePort()

  const path = typeof command.port === 'string' ? command.port.trim() : ''
  if (path === '') {
    fail('open', 'no port name supplied')
    return
  }

  const baudRate = command.baudRate === undefined || command.baudRate === null ? DEFAULTS.baudRate : Number(command.baudRate)
  const dataBits = command.dataBits === undefined || command.dataBits === null ? DEFAULTS.dataBits : Number(command.dataBits)
  const parityKey = normalizeName(command.parity, DEFAULTS.parity.toLowerCase())
  const stopBitsKey = normalizeName(command.stopBits, DEFAULTS.stopBits.toLowerCase())
  const handshakeKey = normalizeName(command.handshake, DEFAULTS.handshake.toLowerCase())

  const parity = PARITY_TO_OPTION[parityKey]
  if (parity === undefined) {
    fail('open', `unsupported parity: ${String(command.parity)}`)
    return
  }
  const stopBits = STOP_BITS_TO_OPTION[stopBitsKey]
  if (stopBits === undefined) {
    // Only reachable for OnePointFive: termios has no 1.5 stop bit.
    fail('open', '1.5 stop bits is not supported on this platform; choose 1 or 2.')
    return
  }
  const flow = HANDSHAKE_TO_FLAGS[handshakeKey]
  if (flow === undefined) {
    fail('open', `unsupported handshake: ${String(command.handshake)}`)
    return
  }

  let SerialPort
  try {
    SerialPort = await loadBinding()
  } catch (error) {
    fail('open', error instanceof Error ? error.message : String(error))
    return
  }

  let port
  try {
    port = new SerialPort({
      path,
      baudRate,
      dataBits,
      stopBits,
      parity,
      autoOpen: false,
      ...flow,
    })
  } catch (error) {
    fail('open', explainOpenFailure(error, path))
    return
  }

  const teardown = () => {
    port.removeAllListeners('data')
    port.removeAllListeners('close')
    port.removeAllListeners('error')
  }

  port.on('data', (chunk) => {
    if (current !== port) return
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (buffer.length === 0) return
    emit({ type: 'data', base64: buffer.toString('base64'), at: Date.now() })
  })
  port.on('error', (error) => {
    if (current !== port) return
    fail('port', error instanceof Error ? error.message : String(error))
  })
  port.on('close', () => {
    // Unplugging the adapter closes the port underneath us; the host should hear
    // about it rather than keep showing a connected port that is gone.
    if (current !== port) return
    current = null
    teardown()
    emit({ type: 'closed' })
  })

  try {
    await promisify(port, 'open')
  } catch (error) {
    teardown()
    fail('open', explainOpenFailure(error, path))
    return
  }

  // Modem lines default to asserted, matching the PowerShell bridge: most
  // USB-UART bridges need DTR for the device side to come up.
  const dtr = command.dtr === undefined || command.dtr === null ? true : Boolean(command.dtr)
  const rts = command.rts === undefined || command.rts === null ? true : Boolean(command.rts)
  try {
    await promisify(port, 'set', { dtr, rts })
  } catch {
    // A driver that cannot drive DTR/RTS is still usable; do not fail the open.
  }

  current = port
  emit({
    type: 'opened',
    port: path,
    baudRate,
    dataBits,
    parity: PARITY_TO_NAME[parity],
    stopBits: STOP_BITS_TO_NAME[stopBits],
    handshake: HANDSHAKE_TO_NAME[handshakeKey],
  })
}

/** Write base64 payload bytes to the open port. */
async function writeBytes(command) {
  const port = current
  if (port === null || port.isOpen !== true) {
    fail('write', 'the port is not open')
    return
  }
  const payload = typeof command.base64 === 'string' ? command.base64 : ''
  if (payload === '') {
    fail('write', 'no payload supplied')
    return
  }
  let bytes
  try {
    bytes = Buffer.from(payload, 'base64')
  } catch (error) {
    fail('write', error instanceof Error ? error.message : String(error))
    return
  }
  try {
    await promisify(port, 'write', bytes)
    emit({ type: 'written', count: bytes.length })
  } catch (error) {
    fail('write', error instanceof Error ? error.message : String(error))
  }
}

/** Handle one stdin line. Returns false when the bridge should stop. */
async function handleLine(line) {
  let command
  try {
    command = JSON.parse(line)
  } catch (error) {
    fail('parse', `invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
    return true
  }
  if (command === null || typeof command !== 'object' || command.op === undefined || command.op === null) {
    fail('parse', 'command has no "op" field')
    return true
  }
  switch (String(command.op)) {
    case 'open':
      await openPort(command)
      return true
    case 'write':
      await writeBytes(command)
      return true
    case 'close':
      await closePort()
      emit({ type: 'closed' })
      return true
    case 'list':
      await emitPorts('ports', 'list')
      return true
    case 'ping':
      emit({ type: 'pong' })
      return true
    case 'shutdown':
      return false
    default:
      fail(String(command.op), `unknown op: ${String(command.op)}`)
      return true
  }
}

/** Announce readiness, then serve stdin until it closes. */
async function main() {
  process.stdout.on('error', () => {
    // The host went away mid-write; stdin's close handler will finish the job.
  })

  let ports = []
  try {
    ports = await listPorts()
  } catch (error) {
    bindingError = error instanceof Error ? error : new Error(String(error))
  }
  emit({ type: 'ready', pid: process.pid, ports })
  if (bindingError !== null) {
    fail('module', bindingError.message)
    // A missing binding makes every later command useless; say so once, up front.
    bindingError = bindingError instanceof Error ? bindingError : new Error(String(bindingError))
    binding = null
  }

  const reader = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })
  // Commands are handled strictly one after another: opening twice in parallel
  // would race on `current`.
  let queue = Promise.resolve()
  let stopping = false

  const stop = () => {
    if (stopping) return
    stopping = true
    queue = queue
      .then(() => closePort())
      .then(() => {
        emit({ type: 'bye' })
        reader.close()
        // Let the event loop drain so `bye` is not truncated by an early exit.
        setTimeout(() => process.exit(0), 50).unref()
      })
      .catch(() => {
        emit({ type: 'bye' })
        process.exit(0)
      })
  }

  reader.on('line', (line) => {
    const trimmed = line.trim()
    if (trimmed === '' || stopping) return
    queue = queue
      .then(() => handleLine(trimmed))
      .then((keepGoing) => {
        if (keepGoing === false) stop()
      })
      .catch((error) => fail('loop', error instanceof Error ? error.message : String(error)))
  })
  // stdin closing means the host is gone: release the port and exit.
  reader.on('close', () => stop())

  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

main().catch((error) => {
  fail('startup', error instanceof Error ? error.message : String(error))
  process.exit(1)
})

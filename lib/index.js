/**
 * dsh-serial-debugger — host half.
 *
 * Owns the serial port on behalf of the browser panel. Windows exposes no
 * in-box way to drive a COM port from Node without a native addon, so the port
 * is held by a persistent Windows PowerShell child (`lib/serial-helper.ps1`)
 * that ships with .NET's `System.IO.Ports`. This half speaks newline-delimited
 * JSON to that child, keeps a bounded receive/transmit log, and republishes it
 * to the client half over one HTTP route owned by this plugin.
 *
 * Deliberately depends on nothing but Node builtins: no `@deepseek-ai/*` import,
 * no native module, no build step. The only harness surfaces used are
 * `ctx.webServer.register` (a plain `node:http` route) and `ctx.effect`
 * (lifecycle cleanup).
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
/**
 * The serial bridge script. `DSH_SERIAL_HELPER` points at an alternative bridge
 * speaking the same NDJSON protocol, which is how deployments that cannot use
 * `System.IO.Ports` — and this package's own no-hardware tests — substitute one.
 */
const HELPER_PATH = (() => {
  const override = process.env.DSH_SERIAL_HELPER
  return typeof override === 'string' && override.trim() !== '' ? override.trim() : join(HERE, 'serial-helper.ps1')
})()

/** Route prefix owned by this plugin. */
const ROUTE = '/dsh-serial-debugger'
/** Entries retained in the receive/transmit log. */
const MAX_LINES = 4000
/** Total payload bytes retained before the oldest entries are dropped. */
const MAX_LOG_BYTES = 8 * 1024 * 1024
/** Entries returned when a client asks for the current tail. */
const TAIL_LINES = 500
/** Largest accepted request body. */
const MAX_BODY_BYTES = 1_000_000

/** Bounds applied to client-supplied port settings. */
const LIMITS = {
  baudRate: [50, 12_000_000],
  dataBits: [5, 8],
}

const PARITY_VALUES = ['None', 'Odd', 'Even', 'Mark', 'Space']
const STOP_BITS_VALUES = ['One', 'OnePointFive', 'Two']
const HANDSHAKE_VALUES = ['None', 'XOnXOff', 'RequestToSend', 'RequestToSendXOnXOff']

export const name = 'serial-debugger'

/** Resolve the PowerShell executable that carries the serial bridge. */
function resolveShell() {
  const override = process.env.DSH_SERIAL_POWERSHELL
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  const root = process.env.SystemRoot || 'C:\\Windows'
  // Windows PowerShell is present on every supported Windows install; pwsh 7
  // also works when a deployment points DSH_SERIAL_POWERSHELL at it.
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function clampInt(value, [min, max], fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

function pickEnum(value, allowed, fallback) {
  if (typeof value !== 'string') return fallback
  const match = allowed.find((item) => item.toLowerCase() === value.trim().toLowerCase())
  return match === undefined ? fallback : match
}

/** Bounded receive/transmit log with a monotonic sequence for incremental reads. */
class SerialLog {
  constructor() {
    this.entries = []
    this.bytes = 0
    this.seq = 0
  }

  push(entry) {
    this.seq += 1
    const record = { seq: this.seq, at: Date.now(), ...entry }
    this.entries.push(record)
    this.bytes += record.b64 === undefined ? 0 : record.b64.length
    while (this.entries.length > MAX_LINES || (this.bytes > MAX_LOG_BYTES && this.entries.length > 1)) {
      const dropped = this.entries.shift()
      this.bytes -= dropped.b64 === undefined ? 0 : dropped.b64.length
    }
    return record
  }

  /** Entries newer than `since`; a negative `since` returns the current tail. */
  since(since) {
    if (!Number.isFinite(since) || since < 0) return this.entries.slice(-TAIL_LINES)
    return this.entries.filter((entry) => entry.seq > since)
  }

  clear() {
    this.entries = []
    this.bytes = 0
  }
}

/**
 * One serial bridge: the PowerShell child, its negotiated port settings, and the
 * traffic log. The child starts lazily on first use because interpreter startup
 * costs roughly two seconds.
 */
class SerialBridge {
  constructor() {
    this.child = null
    this.startPromise = null
    this.ready = false
    this.ports = []
    this.config = null
    this.lastError = null
    this.log = new SerialLog()
    this.waiters = new Set()
    this.stdoutCarry = ''
    this.disposed = false
  }

  /** Notify every pending command waiter that an event arrived. */
  emit(event) {
    for (const waiter of [...this.waiters]) waiter(event)
  }

  /** Record a bridge-level notice in the log. */
  note(text, kind = 'sys') {
    this.log.push({ kind, text })
  }

  handleEvent(event) {
    switch (event.type) {
      case 'ready':
        this.ready = true
        this.ports = Array.isArray(event.ports) ? event.ports : []
        this.note(`serial bridge ready (pid ${event.pid})`)
        break
      case 'ports':
        this.ports = Array.isArray(event.ports) ? event.ports : []
        break
      case 'opened':
        this.config = {
          port: event.port,
          baudRate: event.baudRate,
          dataBits: event.dataBits,
          parity: event.parity,
          stopBits: event.stopBits,
          handshake: event.handshake,
        }
        this.lastError = null
        this.note(`opened ${event.port} @ ${event.baudRate} ${event.dataBits}${String(event.parity).charAt(0)}${event.stopBits}`)
        break
      case 'closed':
        this.config = null
        this.note('port closed')
        break
      case 'data':
        if (typeof event.base64 === 'string' && event.base64 !== '') {
          this.log.push({ kind: 'rx', b64: event.base64 })
        }
        break
      case 'written':
        break
      case 'error':
        this.lastError = event.message
        this.note(`error${event.op ? ` (${event.op})` : ''}: ${event.message}`, 'err')
        break
      case 'bye':
        this.ready = false
        break
      default:
        break
    }
    this.emit(event)
  }

  handleStdout(text) {
    this.stdoutCarry += text
    for (;;) {
      const index = this.stdoutCarry.indexOf('\n')
      if (index < 0) break
      const line = this.stdoutCarry.slice(0, index).trim()
      this.stdoutCarry = this.stdoutCarry.slice(index + 1)
      if (line === '') continue
      try {
        this.handleEvent(JSON.parse(line))
      } catch {
        this.note(`unparsed bridge output: ${line.slice(0, 200)}`)
      }
    }
  }

  /** Start the bridge child once; resolves when it reports ready. */
  start() {
    if (this.disposed) return Promise.reject(new Error('the serial bridge has been disposed'))
    if (this.startPromise !== null) return this.startPromise

    this.startPromise = new Promise((resolve, reject) => {
      const shell = resolveShell()
      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER_PATH]

      let child
      try {
        child = spawn(shell, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      } catch (error) {
        this.startPromise = null
        reject(new Error(`could not start ${shell}: ${error instanceof Error ? error.message : String(error)}`))
        return
      }

      this.child = child
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => this.handleStdout(chunk))
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        const text = String(chunk).trim()
        if (text !== '') this.note(`bridge stderr: ${text.slice(0, 400)}`, 'err')
      })
      child.on('error', (error) => {
        this.note(`bridge process error: ${error.message}`, 'err')
      })
      child.on('exit', (code, signal) => {
        this.ready = false
        this.child = null
        this.startPromise = null
        this.config = null
        if (!this.disposed) {
          this.note(`serial bridge exited (code ${code ?? 'null'}${signal ? `, ${signal}` : ''})`, code === 0 ? 'sys' : 'err')
        }
        this.emit({ type: 'exit', code, signal })
      })

      const deadline = Date.now() + 30_000
      const poll = () => {
        if (this.disposed) {
          reject(new Error('the serial bridge has been disposed'))
          return
        }
        if (this.ready) {
          resolve()
          return
        }
        if (this.child === null && Date.now() < deadline) {
          // The child has not been reaped yet but never became ready.
        }
        if (Date.now() > deadline) {
          reject(new Error('the serial bridge did not become ready within 30s'))
          return
        }
        setTimeout(poll, 100)
      }
      poll()
    })

    return this.startPromise
  }

  /** Send one command line to the child. */
  command(payload) {
    const child = this.child
    if (child === null || child.stdin === null || child.stdin.destroyed) {
      throw new Error('the serial bridge is not running')
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  /**
   * Run a command and resolve with the first event satisfying `done`.
   * @param payload - command written to the child.
   * @param done - predicate selecting the settling event.
   * @param timeoutMs - how long to wait before rejecting.
   */
  async request(payload, done, timeoutMs) {
    await this.start()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        reject(new Error(`the serial bridge did not answer "${payload.op}" within ${timeoutMs}ms`))
      }, timeoutMs)

      const waiter = (event) => {
        let settled = false
        try {
          settled = done(event)
        } catch {
          settled = false
        }
        if (!settled) return
        clearTimeout(timer)
        this.waiters.delete(waiter)
        if (event.type === 'error') reject(new Error(event.message))
        else resolve(event)
      }

      this.waiters.add(waiter)
      try {
        this.command(payload)
      } catch (error) {
        clearTimeout(timer)
        this.waiters.delete(waiter)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** Read the current port list from the operating system. */
  async listPorts() {
    await this.request({ op: 'list' }, (event) => event.type === 'ports', 20_000)
    return this.ports
  }

  /** Open a port with validated settings. */
  async open(raw) {
    const requested = typeof raw === 'object' && raw !== null ? raw : {}
    const portName = typeof requested.port === 'string' ? requested.port.trim() : ''
    if (portName === '') throw new Error('no port was selected')
    if (!/^[A-Za-z0-9._\\/-]{1,64}$/.test(portName)) throw new Error(`invalid port name: ${portName}`)

    const settings = {
      op: 'open',
      port: portName,
      baudRate: clampInt(requested.baudRate, LIMITS.baudRate, 115200),
      dataBits: clampInt(requested.dataBits, LIMITS.dataBits, 8),
      parity: pickEnum(requested.parity, PARITY_VALUES, 'None'),
      stopBits: pickEnum(requested.stopBits, STOP_BITS_VALUES, 'One'),
      handshake: pickEnum(requested.handshake, HANDSHAKE_VALUES, 'None'),
      dtr: requested.dtr === undefined ? true : Boolean(requested.dtr),
      rts: requested.rts === undefined ? true : Boolean(requested.rts),
    }

    if (this.config !== null) await this.close()
    await this.request(settings, (event) => event.type === 'opened' || event.type === 'error', 20_000)
    return this.config
  }

  /** Close the port if one is open. */
  async close() {
    if (this.child === null) {
      this.config = null
      return
    }
    try {
      await this.request({ op: 'close' }, (event) => event.type === 'closed', 10_000)
    } finally {
      this.config = null
    }
  }

  /** Transmit already-encoded bytes and record them in the log. */
  async send(b64, label) {
    if (this.config === null) throw new Error('the port is not open')
    if (typeof b64 !== 'string' || b64 === '') throw new Error('nothing to send')
    if (b64.length > 4_000_000) throw new Error('the payload is too large')
    this.log.push({ kind: 'tx', b64, text: label })
    await this.request({ op: 'write', base64: b64 }, (event) => event.type === 'written' || event.type === 'error', 15_000)
  }

  /** Snapshot for the client panel. */
  status() {
    return {
      ready: this.ready,
      connected: this.config !== null,
      config: this.config,
      ports: this.ports,
      lastError: this.lastError,
      pid: this.child === null ? null : this.child.pid ?? null,
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    const child = this.child
    this.child = null
    this.ready = false
    this.config = null
    if (child === null) return
    try {
      if (child.stdin !== null && !child.stdin.destroyed) {
        child.stdin.write(`${JSON.stringify({ op: 'shutdown' })}\n`)
        child.stdin.end()
      }
    } catch {
      // The child is already gone; fall through to the kill below.
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Already exited.
      }
    }, 3000)
    if (typeof timer.unref === 'function') timer.unref()
  }
}

function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    // The panel may be served from the loopback web carrier or, in a packaged
    // desktop shell, from a file:// document; both must be able to reach it.
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  })
  res.end(body)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Mount the serial bridge and its HTTP route.
 * @param ctx - the host plugin context.
 */
export function apply(ctx) {
  const bridge = new SerialBridge()
  ctx.effect(() => () => bridge.dispose(), 'serial-debugger: serial bridge')

  // Last diagnostics frame posted by the client half. The panel already reports
  // bridge problems itself; this carries what only the page can observe — which
  // slot entries it sees and whether its sidebar row actually rendered — so a
  // mount problem is diagnosable without a browser console.
  let report = null

  const handler = async (req, res) => {
    const method = req.method ?? 'GET'
    if (method === 'OPTIONS') {
      sendJson(res, 204, {})
      return
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const action = url.pathname.slice(ROUTE.length).replace(/^\/+/, '')

    try {
      if (action === 'state' || action === '') {
        const rawSince = Number(url.searchParams.get('since'))
        const since = url.searchParams.has('since') ? rawSince : -1
        sendJson(res, 200, {
          ok: true,
          status: bridge.status(),
          report,
          lines: bridge.log.since(since),
          next: bridge.log.seq,
        })
        return
      }

      if (action === 'ports') {
        const ports = await bridge.listPorts()
        sendJson(res, 200, { ok: true, ports, status: bridge.status() })
        return
      }

      if (method !== 'POST') {
        sendJson(res, 405, { ok: false, error: `${action} requires POST` })
        return
      }

      const body = await readJsonBody(req)

      if (action === 'open') {
        const config = await bridge.open(body)
        sendJson(res, 200, { ok: true, config, status: bridge.status() })
        return
      }

      if (action === 'close') {
        await bridge.close()
        sendJson(res, 200, { ok: true, status: bridge.status() })
        return
      }

      if (action === 'send') {
        await bridge.send(body.base64, typeof body.label === 'string' ? body.label : undefined)
        sendJson(res, 200, { ok: true, next: bridge.log.seq })
        return
      }

      if (action === 'report') {
        report = { at: Date.now(), payload: body }
        sendJson(res, 200, { ok: true })
        return
      }

      if (action === 'clear') {
        bridge.log.clear()
        sendJson(res, 200, { ok: true, next: bridge.log.seq })
        return
      }

      sendJson(res, 404, { ok: false, error: `unknown action: ${action}` })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 200, { ok: false, error: message, status: bridge.status() })
    }
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: ROUTE, handler }),
      'serial-debugger: http route',
    )
  })
}

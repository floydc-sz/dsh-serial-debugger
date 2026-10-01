// Standalone conformance test for lib/serial-helper.ps1 (no hardware required).
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const helper = join(here, '..', 'lib', 'serial-helper.ps1')
const shell = process.env.DSH_SERIAL_PS || 'C:\\windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})

const events = []
let carry = ''
child.stdout.on('data', (buf) => {
  carry += buf.toString('utf8')
  let i
  while ((i = carry.indexOf('\n')) >= 0) {
    const line = carry.slice(0, i).trim()
    carry = carry.slice(i + 1)
    if (!line) continue
    try {
      const ev = JSON.parse(line)
      events.push(ev)
      console.log('EVENT', JSON.stringify(ev))
    } catch (e) {
      console.log('NON-JSON STDOUT:', line)
    }
  }
})
child.stderr.on('data', (b) => console.log('STDERR:', b.toString('utf8').trim()))

const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** Resolve once an event matching `predicate` has arrived, or reject on timeout. */
async function waitFor(predicate, timeoutMs = 20000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const hit = events.find(predicate)
    if (hit) return hit
    await wait(50)
  }
  return undefined
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

const startedAt = Date.now()
const ready = await waitFor((e) => e.type === 'ready')
check('ready event on start', ready !== undefined, `after ${Date.now() - startedAt}ms, ports=${JSON.stringify(ready && ready.ports)}`)

send({ op: 'list' })
const portsEv = await waitFor((e) => e.type === 'ports')
check('list returns a JSON array of ports', portsEv !== undefined && Array.isArray(portsEv.ports), JSON.stringify(portsEv))

send({ op: 'ping' })
check('ping -> pong', (await waitFor((e) => e.type === 'pong')) !== undefined)

send({ op: 'write', base64: 'AQID' })
const writeErr = await waitFor((e) => e.type === 'error' && e.op === 'write')
check('write while closed reports error', writeErr !== undefined, writeErr && writeErr.message)

send({ op: 'open', port: 'COM99', baudRate: 9600 })
const openErr = await waitFor((e) => e.type === 'error' && e.op === 'open')
check('open of missing port reports error', openErr !== undefined, openErr && openErr.message)

// A structurally invalid command must not kill the bridge.
send({ op: 'not-a-real-op' })
check('unknown op reports error', (await waitFor((e) => e.type === 'error' && e.op === 'not-a-real-op')) !== undefined)

const beforeBadJson = events.length
child.stdin.write('this is not json\n')
send({ op: 'ping' })
check('malformed line is survivable', (await waitFor((e, i) => i >= beforeBadJson && e.type === 'pong')) !== undefined)

send({ op: 'close' })
check('close emits closed', (await waitFor((e) => e.type === 'closed')) !== undefined)

send({ op: 'shutdown' })
await wait(1200)
const exited = child.exitCode !== null
check('shutdown exits the process', exited, `exitCode=${child.exitCode}`)

if (!exited) child.kill()
await wait(200)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)

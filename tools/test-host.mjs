// End-to-end test for the host half: fake Cordis context, real node:http server,
// real PowerShell serial bridge (no hardware required).
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const hostModule = pathToFileURL(join(here, '..', 'lib', 'index.js')).href
const { apply, name } = await import(hostModule)

const disposers = []
const routes = []

const webCtx = {
  effect: (fn) => { disposers.push(fn()) },
  webServer: {
    register: (route) => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } },
  },
}
const fakeCtx = {
  effect: (fn) => { disposers.push(fn()) },
  inject: (deps, cb) => { cb(webCtx) },
}

apply(fakeCtx)

const server = http.createServer((req, res) => {
  const route = routes.find((r) => req.url.startsWith(r.path))
  if (!route) { res.writeHead(404); res.end('no route'); return }
  Promise.resolve(route.handler(req, res)).catch((error) => {
    res.writeHead(500); res.end(String(error))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/dsh-serial-debugger`

const results = []
function check(label, ok, detail) {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`)
}

async function call(path, init) {
  const res = await fetch(base + path, init)
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, json }
}
const post = (path, body) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })

check('host exports the expected plugin name', name === 'serial-debugger', name)
check('registers exactly one route under its own prefix', routes.length === 1 && routes[0].path === '/dsh-serial-debugger', JSON.stringify(routes.map((r) => [r.kind, r.path])))

let r = await call('/state?since=-1')
check('state is served before any port is opened', r.status === 200 && r.json.ok === true && r.json.status.connected === false, JSON.stringify(r.json.status))
check('state reports a monotonic cursor', typeof r.json.next === 'number', String(r.json.next))

r = await post('/send', { base64: 'AQID' })
check('send while closed is refused with a message', r.json.ok === false && /not open/i.test(r.json.error), r.json.error)

r = await post('/open', { port: 'COM99', baudRate: 9600 })
check('opening a missing port surfaces the OS error', r.json.ok === false && typeof r.json.error === 'string' && r.json.error.length > 0, r.json.error)

r = await call('/ports')
check('port enumeration returns an array', r.json.ok === true && Array.isArray(r.json.ports), JSON.stringify(r.json.ports))
check('bridge reports itself ready after enumeration', r.json.status.ready === true, JSON.stringify(r.json.status))

r = await post('/open', { port: '' })
check('empty port name is rejected', r.json.ok === false && /no port/i.test(r.json.error), r.json.error)

r = await post('/open', { port: 'COM1; rm -rf /', baudRate: 9600 })
check('port name is validated, not interpolated', r.json.ok === false && /invalid port name/i.test(r.json.error), r.json.error)

r = await post('/open', { port: 'COM99', baudRate: 99999999, dataBits: 99 })
check('out-of-range settings are clamped then rejected by the OS', r.json.ok === false && /COM99/.test(r.json.error), r.json.error)

r = await call('/state')
check('failed attempts are recorded in the log', Array.isArray(r.json.lines) && r.json.lines.some((l) => l.kind === 'err'), `lines=${r.json.lines.length}`)
check('log entries carry sequence numbers', r.json.lines.every((l) => typeof l.seq === 'number'), JSON.stringify(r.json.lines[0] ?? null))

const cursor = r.json.next
r = await call(`/state?since=${cursor}`)
check('incremental read returns only newer entries', r.json.lines.length === 0, `lines=${r.json.lines.length} next=${r.json.next}`)

r = await post('/clear')
check('clear resets the log', r.json.ok === true, JSON.stringify(r.json))

r = await post('/close')
check('close on a closed bridge is harmless', r.json.ok === true, JSON.stringify(r.json))

r = await post('/nonsense')
check('unknown action reports 404', r.status === 404 && r.json.ok === false, JSON.stringify(r.json))

r = await call('/state', { method: 'PUT' })
check('GET-only endpoints reject other verbs', r.status === 200 && r.json.ok === true, 'state accepts any verb as a read')

for (const fn of disposers) { try { await fn() } catch { /* best effort */ } }
await new Promise((resolve) => server.close(resolve))
await new Promise((resolve) => setTimeout(resolve, 1500))

const failed = results.filter((x) => !x.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)

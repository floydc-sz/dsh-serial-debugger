// Minimal Electron app.asar reader: list entries matching a regex, or cat a file.
// Usage:
//   node asar.js <asarPath> ls <regex>
//   node asar.js <asarPath> cat <entryPath>
import fs from 'node:fs'

const [, , asarPath, cmd, arg] = process.argv

const fd = fs.openSync(asarPath, 'r')
const head = Buffer.alloc(8)
fs.readSync(fd, head, 0, 8, 0)
const pickleSize = head.readUInt32LE(4)
const headerBuf = Buffer.alloc(pickleSize)
fs.readSync(fd, headerBuf, 0, pickleSize, 8)
// headerBuf layout: [payloadSize u32][jsonSize u32][json bytes...]
const jsonSize = headerBuf.readUInt32LE(4)
const header = JSON.parse(headerBuf.subarray(8, 8 + jsonSize).toString('utf8'))
const dataOffset = 8 + pickleSize

const entries = []
function walk(node, prefix) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const path = prefix ? `${prefix}/${name}` : name
    if (value.files) walk(value, path)
    else if (Number.isFinite(Number(value.offset))) entries.push({ path, size: value.size ?? 0, offset: Number(value.offset) })
    else entries.push({ path, size: value.size ?? 0, offset: null })
  }
}
walk(header, '')

if (cmd === 'ls') {
  const re = new RegExp(arg, 'i')
  const hits = entries.filter((e) => re.test(e.path))
  hits.sort((a, b) => a.path.localeCompare(b.path))
  for (const h of hits) console.log(`${String(h.size).padStart(9)}  ${h.path}`)
  console.log(`--- ${hits.length} match(es) of ${entries.length} total entries`)
} else if (cmd === 'grep') {
  const [patternStr, pathFilter, maxHitsStr] = arg.split('||')
  const re = new RegExp(patternStr)
  const pathRe = pathFilter ? new RegExp(pathFilter, 'i') : null
  const maxHits = Number(maxHitsStr || 60)
  let hits = 0
  const textExt = /\.(js|mjs|cjs|ts|tsx|json|md|yml|yaml)$/i
  for (const entry of entries) {
    if (hits >= maxHits) break
    if (!textExt.test(entry.path)) continue
    if (entry.offset === null) continue
    if (pathRe && !pathRe.test(entry.path)) continue
    if (entry.size > 4_000_000) continue
    const buf = Buffer.alloc(entry.size)
    fs.readSync(fd, buf, 0, entry.size, dataOffset + entry.offset)
    const text = buf.toString('utf8')
    const lines = text.split('\n')
    for (let i = 0; i < lines.length && hits < maxHits; i++) {
      if (re.test(lines[i])) {
        hits++
        console.log(`${entry.path}:${i + 1}: ${lines[i].trim().slice(0, 300)}`)
      }
    }
  }
  console.log(`--- ${hits} hit(s)`)
} else if (cmd === 'extract') {
  const [entryPath, outPath] = arg.split('||')
  const entry = entries.find((e) => e.path === entryPath)
  if (!entry) {
    console.error(`not found: ${entryPath}`)
    process.exit(1)
  }
  const buf = Buffer.alloc(entry.size)
  fs.readSync(fd, buf, 0, entry.size, dataOffset + Number(entry.offset))
  fs.writeFileSync(outPath, buf)
  console.log(`wrote ${entry.size} bytes -> ${outPath}`)
} else if (cmd === 'cat') {
  const entry = entries.find((e) => e.path === arg)
  if (!entry) {
    console.error(`not found: ${arg}`)
    process.exit(1)
  }
  const buf = Buffer.alloc(entry.size)
  fs.readSync(fd, buf, 0, entry.size, dataOffset + Number(entry.offset))
  process.stdout.write(buf)
} else {
  console.error('usage: asar.js <asar> ls <regex> | cat <path>')
  process.exit(2)
}
fs.closeSync(fd)

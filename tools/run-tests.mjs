// Run every dsh-serial-debugger test suite.
//
//   node tools/run-tests.mjs
//
// This is the real runner, written in Node so the same command works on Windows
// and on Linux. tools/run-tests.ps1 and tools/run-tests.sh are thin shims around
// it for people used to the old entry point.
//
// Suites marked with `platforms` are skipped, not failed, where they cannot run:
// the PowerShell bridge can only be exercised on Windows.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const SUITES = [
	{ name: 'serial bridge protocol (PowerShell)', file: 'test-helper.mjs', platforms: ['win32'] },
	{ name: 'serial bridge protocol (POSIX)', file: 'test-helper-posix.mjs' },
	{ name: 'host half + HTTP route', file: 'test-host.mjs' },
	{ name: 'client bundle + render', file: 'test-client.mjs' },
	{ name: 'full data path (loopback)', file: 'test-loopback.mjs' },
]

console.log(`node    : ${process.execPath}`)
console.log(`platform: ${process.platform}`)
console.log('')

const failed = []
const skipped = []

for (const suite of SUITES) {
	console.log(`--- ${suite.name} ---`)
	if (suite.platforms !== undefined && !suite.platforms.includes(process.platform)) {
		console.log(`SKIP  needs ${suite.platforms.join('/')}, this is ${process.platform}`)
		skipped.push(suite.name)
		console.log('')
		continue
	}
	const result = spawnSync(process.execPath, [join(here, suite.file)], { stdio: 'inherit' })
	if (result.status !== 0) failed.push(suite.name)
	console.log('')
}

if (failed.length > 0) {
	console.log(`FAILED: ${failed.join(', ')}`)
	process.exit(1)
}
if (skipped.length > 0) {
	console.log(`all suites passed (skipped: ${skipped.join(', ')})`)
} else {
	console.log('all suites passed')
}

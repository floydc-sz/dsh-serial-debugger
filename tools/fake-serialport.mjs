// Stand-in for the `serialport` binding, used by test-helper-posix.mjs.
//
// Implements exactly the surface lib/serial-helper.mjs touches — `list()`,
// `open`/`close`/`write`/`set`, the `data`/`close`/`error` events — with a
// loopback wire and failure paths reachable by naming them in the port path.
// This is what lets the POSIX bridge be tested on any OS, with no hardware and
// without compiling the native module.
import { EventEmitter } from 'node:events'

/** Ports `list()` reports. The bare /dev/ttyS0 is here to prove the bridge filters it. */
const PORTS = [
	{ path: '/dev/ttyUSB0', manufacturer: 'FTDI', vendorId: '0403', productId: '6001' },
	{ path: '/dev/ttyACM0', manufacturer: '', vendorId: '2341', productId: '0043' },
	{ path: '/dev/ttyS0' },
]

/** Map a path keyword onto the errno a real open would raise. */
function failureFor(path) {
	if (path.includes('EACCES')) {
		const error = new Error(`Error: Permission denied, cannot open ${path}`)
		error.code = 'EACCES'
		return error
	}
	if (path.includes('ENOENT')) {
		const error = new Error(`Error: No such file or directory, cannot open ${path}`)
		error.code = 'ENOENT'
		return error
	}
	if (path.includes('EBUSY')) {
		const error = new Error(`Error: Resource busy, cannot open ${path}`)
		error.code = 'EBUSY'
		return error
	}
	return null
}

export class SerialPort extends EventEmitter {
	static async list() {
		return PORTS.map((entry) => ({ ...entry }))
	}

	constructor(options) {
		super()
		this.options = options
		this.path = options.path
		this.isOpen = false
		this.modemLines = null
		this.written = []
	}

	open(callback) {
		setImmediate(() => {
			const failure = failureFor(this.path)
			if (failure !== null) {
				callback?.(failure)
				return
			}
			this.isOpen = true
			this.emit('open')
			callback?.()
		})
	}

	close(callback) {
		setImmediate(() => {
			if (!this.isOpen) {
				callback?.(new Error('Port is not open'))
				return
			}
			this.isOpen = false
			this.emit('close')
			callback?.()
		})
	}

	set(options, callback) {
		this.modemLines = options
		setImmediate(() => callback?.())
	}

	write(data, callback) {
		setImmediate(() => {
			if (!this.isOpen) {
				callback?.(new Error('Port is not open'))
				return
			}
			const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data)
			this.written.push(bytes)
			callback?.()
			// Loopback: echo what was written, one macrotask later, so the bridge's
			// `written` event is emitted before the echo arrives.
			setImmediate(() => {
				if (this.isOpen) this.emit('data', bytes)
			})
		})
	}

	/** Test hook: unplug the device, the way a yanked adapter does. */
	simulateUnplug() {
		this.isOpen = false
		this.emit('close')
	}
}

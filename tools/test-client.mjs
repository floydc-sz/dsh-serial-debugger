// Smoke test for the client bundle: loads it through a stubbed module loader and
// a minimal React runtime, then inspects the registered slots and the render tree.
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'lib', 'client.js')
const source = fs.readFileSync(bundlePath, 'utf8')

// ── minimal React runtime ───────────────────────────────────────────────────
let hookIndex = 0
const hookSlots = []
const React = {
	Fragment: Symbol('Fragment'),
	createElement(type, props, ...children) {
		return { type, props: props ?? {}, children, key: props && props.key }
	},
	useState(initial) {
		const slot = hookIndex++
		if (!(slot in hookSlots)) hookSlots[slot] = typeof initial === 'function' ? initial() : initial
		return [hookSlots[slot], (next) => { hookSlots[slot] = typeof next === 'function' ? next(hookSlots[slot]) : next }]
	},
	useRef(initial) {
		const slot = hookIndex++
		if (!(slot in hookSlots)) hookSlots[slot] = { current: initial }
		return hookSlots[slot]
	},
	useEffect() { hookIndex += 1 },
	useMemo(factory) { hookIndex += 1; return factory() },
	useCallback(fn) { hookIndex += 1; return fn },
}

// ── stubbed module loader ──────────────────────────────────────────────────
let registration = null
globalThis.window = {
	__ModuleLoader__: {
		load(def) { registration = def },
	},
}

const requireStub = (spec) => {
	if (spec === 'react') return React
	if (spec === 'react/jsx-runtime') return { jsx: (t, p) => React.createElement(t, p) }
	throw new Error(`the bundle requested an undeclared external: ${spec}`)
}

// eslint-disable-next-line no-new-func
new Function('window', `${source}`)(globalThis.window)

const results = []
function check(label, ok, detail) {
	results.push({ label, ok })
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`)
}

check('bundle registers exactly one module', registration !== null)
check('registered id is the package name', registration && registration.id === 'dsh-serial-debugger', registration && registration.id)
check('factory is a function', registration && typeof registration.factory === 'function')

const exports_ = registration.factory(requireStub)
check('exports apply()', typeof exports_.apply === 'function')
check('exports inject as a string array', Array.isArray(exports_.inject) && exports_.inject.includes('slots'), JSON.stringify(exports_.inject))
check('panel id is stable', exports_.PANEL_ID === 'serial-debugger', exports_.PANEL_ID)

// ── manifest contract for a UI plugin ──────────────────────────────────────
// The official decoration template requires platform + immediately + inject.
// Without `immediately` the bundle is not materialized during boot, and without
// `inject` the slot owners may activate after this plugin registers — in which
// case the sidebar has already synced its panel list and never shows the row.
const manifest = JSON.parse(fs.readFileSync(join(here, '..', 'package.json'), 'utf8'))
const clientDecl = manifest.dsh && manifest.dsh.client
check('manifest declares a web client half', clientDecl !== undefined && clientDecl.platform === 'web', JSON.stringify(clientDecl))
check('manifest requests immediate materialization', clientDecl !== undefined && clientDecl.immediately === true, String(clientDecl && clientDecl.immediately))
check('manifest injects the sidebar slot owner', Array.isArray(clientDecl && clientDecl.inject) && clientDecl.inject.includes('@deepseek-ai/dsh-client-ui-sidebar'), JSON.stringify(clientDecl && clientDecl.inject))
check('manifest declares no non-baseline externals', clientDecl !== undefined && clientDecl.external === undefined, JSON.stringify(clientDecl && clientDecl.external))
check('manifest points at the bundle patch', manifest.dsh.bundle && manifest.dsh.bundle.patch === './cordis.patch.yml', JSON.stringify(manifest.dsh.bundle))
check('manifest exports the client subpath', manifest.exports['./client'] !== undefined, JSON.stringify(manifest.exports['./client']))
check('published files exclude dev tooling', Array.isArray(manifest.files) && !manifest.files.includes('tools'), JSON.stringify(manifest.files))

// ── the catalog's own submission requirements ──────────────────────────────
// awesome-dsh-plugin's CI fetches package.json and rejects a submission whose
// manifest omits `dsh.bundle` (the most common rejection: shipping only
// `dsh.client`). The rest is what the market card and npm need.
const files = Array.isArray(manifest.files) ? manifest.files : []
check('catalog: dsh.bundle is declared, not just dsh.client', manifest.dsh.bundle !== undefined && typeof manifest.dsh.bundle.patch === 'string', JSON.stringify(manifest.dsh))
check('catalog: the bundle patch ships in the package', files.includes('cordis.patch.yml'))
check('catalog: version is the published 1.0.0', manifest.version === '1.0.0', String(manifest.version))
check('catalog: the package is publishable', manifest.private !== true)
check('catalog: keywords carry the dsh-plugin topic', Array.isArray(manifest.keywords) && manifest.keywords.includes('dsh-plugin'), JSON.stringify(manifest.keywords))
check('catalog: a license is declared and shipped', manifest.license === 'MIT' && files.includes('LICENSE'), `${manifest.license} / ${JSON.stringify(files)}`)
check('catalog: the LICENSE file exists', fs.existsSync(join(here, '..', 'LICENSE')))
check('catalog: no official package sits in dependencies', manifest.dependencies === undefined, JSON.stringify(manifest.dependencies))

// dshmarket reads the host requirement from `dsh.engines.dsh` (falling back to
// top-level `engines.dsh`) and refuses an install it can prove incompatible.
// The range MUST carry a prerelease tag on the matching tuple, or node-semver
// silently excludes every prerelease harness build.
const dshRange = (manifest.dsh.engines && manifest.dsh.engines.dsh) || (manifest.engines && manifest.engines.dsh)
check('catalog: the DSH host range is declared', typeof dshRange === 'string' && dshRange !== '', String(dshRange))
check('catalog: the host range reaches prerelease builds', typeof dshRange === 'string' && /0\.2\.0-[0-9A-Za-z.-]+/.test(dshRange), String(dshRange))
check('catalog: npm publish access is public', manifest.publishConfig !== undefined && manifest.publishConfig.access === 'public', JSON.stringify(manifest.publishConfig))
check('catalog: the plugin is declared Windows-only', Array.isArray(manifest.os) && manifest.os.includes('win32'), JSON.stringify(manifest.os))

// ── right sidebar tab registration ─────────────────────────────────────────
// The native seat declares `sidebar.right.pane.tab` BEFORE it provides
// `sidebarRightTabs`, so the tab must be registered from a SERVICE injection
// (`ctx.inject(['sidebarRightTabs'], ...)`), never from the slot declaration.
const definedTypes = []
const registered = []
const injectedSlots = []
const registeredSlots = []
const tabDisposers = []
const seatDisposers = []

const tabsService = {
	register(definition) {
		definedTypes.push(definition)
		const dispose = () => { tabDisposers.push(definition.id) }
		return dispose
	},
}

function makeCtx({ withService = true } = {}) {
	const ctx = {
		inject(deps, callback) {
			ctx.injectedDeps = deps
			callback({ get: (name) => (withService && name === 'sidebarRightTabs' ? tabsService : undefined) })
			return { dispose: () => { seatDisposers.push(true) } }
		},
		effect(fn) { seatDisposers.push(fn()) },
		slots: {
			inject(name, callback) {
				injectedSlots.push(name)
				const dispose = callback()
				return () => { if (typeof dispose === 'function') dispose() }
			},
			register(options, Component) {
				registeredSlots.push({ options, Component })
				const dispose = () => {}
				registered.push({ options, Component, dispose })
				return dispose
			},
		},
	}
	return ctx
}

const ctx = makeCtx()
exports_.apply(ctx)

check('waits on the sidebarRightTabs SERVICE, not the slot declaration', Array.isArray(ctx.injectedDeps) && ctx.injectedDeps.includes('sidebarRightTabs'), JSON.stringify(ctx.injectedDeps))
check('registers exactly one tab type', definedTypes.length === 1, `types=${definedTypes.length}`)

const type = definedTypes[0]
check('tab type carries an id and a kind', type !== undefined && typeof type.id === 'string' && typeof type.kind === 'string', JSON.stringify([type && type.id, type && type.kind]))
check('tab type title resolves to the plugin label', type !== undefined && type.title('') === '串口调试', type && type.title(''))
check('tab type declares a guide entry', type !== undefined && Array.isArray(type.guide) && type.guide.length === 1, JSON.stringify(type && type.guide && type.guide.length))
const guide = type !== undefined && type.guide ? type.guide[0] : undefined
check('guide entry has a unique id, order and title', guide !== undefined && typeof guide.id === 'string' && typeof guide.order === 'number' && guide.title() === '串口调试', JSON.stringify(guide && [guide.id, guide.order, guide.title()]))
check('guide entry supplies a description and icon', guide !== undefined && typeof guide.description === 'function' && typeof guide.icon === 'function', typeof (guide && guide.icon))
const guideIcon = guide.icon({ size: 20 })
check('guide icon renders a sized element', guideIcon.props.size === 20 && typeof guideIcon.type === 'function', JSON.stringify(guideIcon && guideIcon.props))

check('registers the tab body and chip title slots', injectedSlots.includes('sidebar.right.pane.tab') && injectedSlots.includes('sidebar.right.pane.tab.title'), JSON.stringify(injectedSlots))
const body = registeredSlots.find((r) => r.options.name === 'sidebar.right.pane.tab')
const chip = registeredSlots.find((r) => r.options.name === 'sidebar.right.pane.tab.title')
check('body and title are keyed by the tab type id', body !== undefined && body.options.key === type.id && chip !== undefined && chip.options.key === type.id, JSON.stringify([body && body.options.key, chip && chip.options.key]))
check('body renders the debugger page', body !== undefined && body.Component === exports_.SerialDebuggerPage)
check('title renders the plugin label', chip !== undefined && JSON.stringify(chip.Component({})).includes('串口调试'))
check('no left-sidebar panel surfaces remain', !injectedSlots.includes('sidebar.panellist') && !injectedSlots.includes('sidebar.footer.action') && !injectedSlots.includes('main'), JSON.stringify(injectedSlots))

// The Settings page is registered one macrotask later (past the activation cascade).
await new Promise((resolve) => setTimeout(resolve, 5))
const settingsSection = registeredSlots.find((r) => r.options.name === 'settings.section')
check('settings page is registered', settingsSection !== undefined && settingsSection.options.id === 'serial-debugger' && typeof settingsSection.options.label === 'string', JSON.stringify(settingsSection && settingsSection.options))
check('settings page renders the debugger page', settingsSection !== undefined && settingsSection.Component === exports_.SerialDebuggerPage)

// A deployment without the service must register nothing and must not throw.
definedTypes.length = 0
registeredSlots.length = 0
const bare = makeCtx({ withService: false })
exports_.apply(bare)
check('a missing sidebarRightTabs service is survived', definedTypes.length === 0, `types=${definedTypes.length}`)
check('the seat disposer is retained for teardown', seatDisposers.length > 0, `disposers=${seatDisposers.length}`)

// A disposer must cancel the deferred Settings registration before it lands.
const pending = []
const pendingRegistered = []
const cancelCtx = {
	inject() { return { dispose: () => {} } },
	effect(fn) { fn() },
	slots: {
		inject(name, callback) { pending.push(callback()) },
		register(options) { pendingRegistered.push(options); return () => {} },
	},
}
exports_.apply(cancelCtx)
for (const dispose of pending) dispose()
await new Promise((resolve) => setTimeout(resolve, 5))
check('a disposer cancels a deferred registration', pendingRegistered.length === 0, `registered=${pendingRegistered.length}`)

// ── pure encoder ───────────────────────────────────────────────────────────
const enc = exports_.encodeSend
const asText = (b64) => Buffer.from(b64, 'base64').toString('binary')
check('text payload is UTF-8 encoded', asText(enc('AB', 'text', 'none').base64) === 'AB', JSON.stringify(asText(enc('AB', 'text', 'none').base64)))
check('CRLF ending is appended', asText(enc('AB', 'text', 'crlf').base64) === 'AB\r\n', JSON.stringify(asText(enc('AB', 'text', 'crlf').base64)))
check('LF ending is appended', asText(enc('AB', 'text', 'lf').base64) === 'AB\n')
check('hex mode parses spaced bytes', asText(enc('AA 55 01', 'hex', 'none').base64) === '\xaa\x55\x01', JSON.stringify(asText(enc('AA 55 01', 'hex', 'none').base64)))
check('hex mode tolerates 0x prefixes and separators', asText(enc('0xAA,0x55', 'hex', 'none').base64) === '\xaa\x55')
check('hex mode honours the line ending', asText(enc('AA', 'hex', 'crlf').base64) === '\xaa\r\n')
check('non-ASCII text survives', asText(enc('中文', 'text', 'none').base64) === Buffer.from('中文', 'utf8').toString('binary'))

function throws(fn) { try { fn(); return false } catch { return true } }
check('empty text send is rejected', throws(() => enc('', 'text', 'none')))
check('odd-length hex is rejected', throws(() => enc('ABC', 'hex', 'none')))
check('non-hex characters are rejected', throws(() => enc('ZZ', 'hex', 'none')))
check('empty hex with no ending is rejected', throws(() => enc('', 'hex', 'none')))

// ── render tree ────────────────────────────────────────────────────────────
hookIndex = 0
hookSlots.length = 0
const tree = exports_.SerialDebuggerPage()

const texts = []
const tags = []
function walk(node) {
	if (node === null || node === undefined || node === false || node === true) return
	if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return }
	if (Array.isArray(node)) { node.forEach(walk); return }
	if (typeof node !== 'object') return
	if (typeof node.type === 'function') {
		const kids = node.children.length <= 1 ? node.children[0] : node.children
		walk(node.type({ ...node.props, children: kids }))
		return
	}
	if (node.type === React.Fragment) { node.children.forEach(walk); return }
	if (typeof node.type === 'string') tags.push(node.type)
	node.children.forEach(walk)
}
walk(tree)

const joined = texts.join(' | ')
check('renders without throwing', tree !== null && typeof tree === 'object')
// The settings column, in the reference assistant's top-to-bottom order.
check(
	'renders every parameter label',
	['串口选择', '波特率', '停止位', '数据位', '校验位', '串口操作'].every((label) => joined.includes(label)),
	joined.slice(0, 200),
)
check('does not render a flow-control control', !joined.includes('流控') && !joined.includes('XOnXOff'), joined.includes('流控') ? '流控 present' : 'absent')
check('renders the open-port control', joined.includes('打开串口'))
check('renders the window actions', joined.includes('保存窗口') && joined.includes('清除接收'))
check('renders the display checkboxes', ['16进制显示', 'DTR', 'RTS', '自动滚动', '时间戳'].every((label) => joined.includes(label)))
check('renders the send block tabs', joined.includes('单条发送') && joined.includes('帮助'))
check('renders the send and clear-send controls', joined.includes('发送') && joined.includes('清除发送'))
check('renders the timed-send row', joined.includes('定时发送') && joined.includes('周期:'))
check('renders the file controls', ['打开文件', '发送文件', '停止发送'].every((label) => joined.includes(label)))
check('renders the send-mode checkboxes', joined.includes('16进制发送') && joined.includes('发送新行'))
check('renders the progress readout', joined.includes('0%'))
check('renders an empty-state hint', joined.includes('等待数据') || joined.includes('开始接收数据'))
check('falls back to a text input when no port enumerates', tags.includes('input') && tags.filter((t) => t === 'select').length === 4, `selects=${tags.filter((t) => t === 'select').length}`)
check('renders the receive log container', tags.filter((t) => t === 'div').length > 5, `divs=${tags.filter((t) => t === 'div').length}`)
check('renders the composer textarea', tags.includes('textarea'))

// The three bands must appear in the requested order: parameters, receive, send.
const at = (needle) => texts.findIndex((text) => text.includes(needle))
check('parameters band precedes the receive band', at('串口选择') >= 0 && at('串口选择') < at('开始接收数据'), `parameters=${at('串口选择')} receive=${at('开始接收数据')}`)
check('receive band precedes the send band', at('开始接收数据') >= 0 && at('开始接收数据') < at('单条发送'), `receive=${at('开始接收数据')} send=${at('单条发送')}`)
check('send options follow the composer', at('单条发送') < at('16进制发送') && at('16进制发送') < at('发送新行'), `composer=${at('单条发送')} options=${at('16进制发送')}`)
check('串口操作 sits in the parameters band', at('串口操作') >= 0 && at('串口操作') < at('开始接收数据'), `op=${at('串口操作')}`)
check(
	'the four shared parameters are adjacent',
	at('波特率') < at('停止位') && at('停止位') < at('数据位') && at('数据位') < at('校验位') && at('校验位') < at('串口操作'),
	[at('波特率'), at('停止位'), at('数据位'), at('校验位'), at('串口操作')].join(','),
)

// Structural: the four parameters form TWO non-wrapping flex rows of two, so a
// pair stays together and shares the width instead of splitting on a narrow column.
/** Every string rendered under one node, with function components expanded. */
function textsUnder(node, acc) {
	if (node === null || node === undefined || node === false) return acc
	if (typeof node === 'string' || typeof node === 'number') { acc.push(String(node)); return acc }
	if (Array.isArray(node)) { node.forEach((child) => textsUnder(child, acc)); return acc }
	if (typeof node !== 'object') return acc
	if (typeof node.type === 'function') {
		const kids = node.children.length <= 1 ? node.children[0] : node.children
		return textsUnder(node.type({ ...node.props, children: kids }), acc)
	}
	node.children.forEach((child) => textsUnder(child, acc))
	return acc
}
const four = ['波特率', '停止位', '数据位', '校验位']
const sharedRows = []
function findSharedRow(node) {
	if (node === null || node === undefined || typeof node !== 'object') return
	if (Array.isArray(node)) { node.forEach(findSharedRow); return }
	if (typeof node.type === 'function') {
		const kids = node.children.length <= 1 ? node.children[0] : node.children
		findSharedRow(node.type({ ...node.props, children: kids }))
		return
	}
	if (typeof node.type === 'string') {
		const own = textsUnder(node, [])
		if (four.every((label) => own.includes(label))) sharedRows.push(node)
	}
	node.children.forEach(findSharedRow)
}
findSharedRow(tree)
// The surrounding band is a COLUMN holding all four (that is expected); what must
// not exist is a horizontal row holding all four.
const horizontalAllFour = sharedRows.filter((node) => node.props.style.display === 'flex' && node.props.style.flexDirection !== 'column')
check('no single horizontal row holds all four parameters', horizontalAllFour.length === 0, `horizontalRows=${horizontalAllFour.length}`)

/** The tightest flex element containing exactly `labels` and none of the others. */
function tightestRowFor(labels) {
	const others = four.filter((label) => !labels.includes(label))
	const found = []
	const visit = (node) => {
		if (node === null || node === undefined || typeof node !== 'object') return
		if (Array.isArray(node)) { node.forEach(visit); return }
		if (typeof node.type === 'function') {
			const kids = node.children.length <= 1 ? node.children[0] : node.children
			visit(node.type({ ...node.props, children: kids }))
			return
		}
		if (typeof node.type === 'string') {
			const own = textsUnder(node, [])
			if (labels.every((label) => own.includes(label)) && others.every((label) => !own.includes(label))) found.push(node)
		}
		node.children.forEach(visit)
	}
	visit(tree)
	return found[found.length - 1]
}

for (const pair of [['波特率', '停止位'], ['数据位', '校验位']]) {
	const row = tightestRowFor(pair)
	const name = pair.join(' + ')
	const cells = row === undefined ? [] : row.children
	// A cell is a component element; its style lives in what it renders.
	const cellStyle = (cell) => {
		if (cell === null || typeof cell !== 'object') return undefined
		if (typeof cell.type !== 'function') return cell.props ? cell.props.style : undefined
		const kids = cell.children.length <= 1 ? cell.children[0] : cell.children
		const rendered = cell.type({ ...cell.props, children: kids })
		return rendered !== null && rendered !== undefined && rendered.props ? rendered.props.style : undefined
	}
	check(`${name} share one flex row of two cells`, row !== undefined && row.props.style.display === 'flex' && cells.length === 2, row && `children=${cells.length}`)
	check(`${name} row cannot wrap`, row !== undefined && row.props.style.flexWrap === undefined, row && String(row.props.style.flexWrap))
	// The name and the control must share the line: a row-direction flex box with
	// its label first, never a column that stacks the label above the control.
	const inline = cells.every((cell) => {
		const style = cellStyle(cell)
		return style !== undefined && style.display === 'flex' && style.flexDirection !== 'column' && style.alignItems === 'center'
	})
	check(`${name} put each name beside its control`, cells.length === 2 && inline, JSON.stringify(cells.map((cell) => cellStyle(cell))))
	const cellsShareWidth = cells.every((cell) => cell !== null && cell.props && cell.props.flex === '1 1 0')
	check(`${name} cells share the row evenly`, cellsShareWidth, JSON.stringify(cells.map((cell) => cell && cell.props && cell.props.flex)))
}

// ── sidebar glyph ──────────────────────────────────────────────────────────
const icon = exports_.SerialDebuggerIcon({ size: 20 })
check('sidebar glyph is an svg sized by its prop', icon.type === 'svg' && icon.props.width === 20 && icon.props.height === 20)
const idle = exports_.SerialDebuggerIcon({ size: 16, active: false })
const lit = exports_.SerialDebuggerIcon({ size: 16, active: true })
check('glyph reflects the selected state', idle.props.strokeWidth !== lit.props.strokeWidth, `${idle.props.strokeWidth} vs ${lit.props.strokeWidth}`)
check('glyph defaults to a usable size', exports_.SerialDebuggerIcon({}).props.width === 16 && exports_.SerialDebuggerIcon(undefined).props.width === 16)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)

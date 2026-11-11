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
check('tab kind is stable', exports_.TAB_KIND === 'serial-debugger', exports_.TAB_KIND)

// ── i18n ───────────────────────────────────────────────────────────────────
// The header switch flips between two complete dictionaries, so a key present in
// one and missing in the other would surface as a raw key name in the panel.
const zhKeys = Object.keys(exports_.MESSAGES.zh).sort()
const enKeys = Object.keys(exports_.MESSAGES.en).sort()
check('both dictionaries carry the same keys', JSON.stringify(zhKeys) === JSON.stringify(enKeys), `zh=${zhKeys.length} en=${enKeys.length}`)
check('no dictionary value is empty', zhKeys.every((k) => exports_.MESSAGES.zh[k] !== '') && enKeys.every((k) => exports_.MESSAGES.en[k] !== ''))
check('dictionary size is plausible', zhKeys.length >= 50, `${zhKeys.length} keys`)
check('zh and en actually differ', exports_.MESSAGES.zh.port !== exports_.MESSAGES.en.port, `${exports_.MESSAGES.zh.port} / ${exports_.MESSAGES.en.port}`)

const tr = exports_.translate
check('translate resolves a zh key', tr('zh', 'port') === '串口选择', tr('zh', 'port'))
check('translate resolves an en key', tr('en', 'port') === 'Port', tr('en', 'port'))
check('translate interpolates numbers', tr('zh', 'rxBytes', { n: 42 }) === '接收 42 B', tr('zh', 'rxBytes', { n: 42 }))
check('translate interpolates onto en too', tr('en', 'entries', { n: 3 }) === '3 entries', tr('en', 'entries', { n: 3 }))
check('translate interpolates an error message', tr('en', 'cannotReachHost', { msg: 'boom' }) === 'Cannot reach the serial host: boom', tr('en', 'cannotReachHost', { msg: 'boom' }))
check('translate falls back to the key when missing', tr('en', 'no.such.key') === 'no.such.key', tr('en', 'no.such.key'))
check('translate falls back to zh for an unknown locale', tr('de', 'port') === '串口选择', tr('de', 'port'))
check('normalizeLocale maps zh tags to zh', exports_.normalizeLocale('zh-CN') === 'zh' && exports_.normalizeLocale('zh') === 'zh', exports_.normalizeLocale('zh-TW'))
check('normalizeLocale maps everything else to en', exports_.normalizeLocale('en-US') === 'en' && exports_.normalizeLocale('fr') === 'en', exports_.normalizeLocale('fr'))
check('tab label comes from the dictionary', JSON.stringify(exports_.SerialDebuggerTabTitle({})).includes('串口调试'))

// ── receive rows ───────────────────────────────────────────────────────────
// A serial port delivers whatever bytes the driver had, so one logical message
// can arrive as many chunks. Grouping is what stops an ordinary message from
// looking as if line breaks had been sprinkled into it.
const b64Of = (bytes) => Buffer.from(bytes).toString('base64')
const rxEntry = (bytes, seq) => ({ kind: 'rx', b64: b64Of(bytes), at: 1000 + seq, seq })
const txEntry = (bytes, seq) => ({ kind: 'tx', b64: b64Of(bytes), at: 1000 + seq, seq })

let rows = exports_.groupRows([rxEntry('Hel', 1), rxEntry('lo', 2)])
check('consecutive receive chunks collapse into one row', rows.length === 1 && rows[0].entries.length === 2, `rows=${rows.length}`)
check('a split payload reads as one message', exports_.formatRow(rows[0], false, false) === 'Hello', JSON.stringify(exports_.formatRow(rows[0], false, false)))

rows = exports_.groupRows([rxEntry('A', 1), txEntry('B', 2), rxEntry('C', 3)])
check('a transmit breaks the receive run', rows.map((r) => r.kind).join(',') === 'rx,tx,rx', rows.map((r) => r.kind).join(','))

// '中' is E4 B8 AD. Split it across two chunks: bytes must be joined before decoding.
const han = Buffer.from('中', 'utf8')
rows = exports_.groupRows([rxEntry(han.subarray(0, 1), 1), rxEntry(han.subarray(1), 2)])
check('a multi-byte character split across chunks decodes intact', exports_.formatRow(rows[0], false, false) === '中', JSON.stringify(exports_.formatRow(rows[0], false, false)))

rows = exports_.groupRows([rxEntry([0xaa, 0x55], 1), rxEntry([0x01, 0x02], 2)])
check('hex view joins the chunks into one dump', exports_.formatRow(rows[0], true, false) === 'aa 55 01 02', exports_.formatRow(rows[0], true, false))

rows = exports_.groupRows([rxEntry('line1\r\n', 1), rxEntry('line2', 2)])
check('a real newline in the payload still breaks the line', exports_.formatRow(rows[0], false, false).includes('\n'), JSON.stringify(exports_.formatRow(rows[0], false, false)))

rows = exports_.groupRows([rxEntry('A', 1), rxEntry('B', 2)])
check('timestamp mode still merges the arrivals into one line', exports_.formatRow(rows[0], false, true) === '08:00:01.001 AB', JSON.stringify(exports_.formatRow(rows[0], false, true)))

rows = exports_.groupRows([1, 2, 3, 4, 5].map((n) => rxEntry('x'.repeat(2000), n)))
check('an endless stream is split into bounded rows', rows.length > 1, `rows=${rows.length}`)

// Timestamps: the row still merges (so bytes join before decoding), but every
// text line inside it is stamped with the arrival that began it.
rows = exports_.groupRows([rxEntry('line one\n', 1), rxEntry('line two\n', 2)])
const twoLines = exports_.formatRow(rows[0], false, true).split('\n')
check('a merged row stamps every text line', twoLines.length === 2, JSON.stringify(twoLines))
check('each line carries the arrival that began it', twoLines[0].startsWith('08:00:01.001 ') && twoLines[1].startsWith('08:00:01.002 '), JSON.stringify(twoLines))
check('a trailing line break does not add an empty stamped line', !exports_.formatRow(rows[0], false, true).endsWith('\n'), JSON.stringify(exports_.formatRow(rows[0], false, true)))

// The merge is what keeps a split character intact, so it must hold with stamps on.
rows = exports_.groupRows([rxEntry(han.subarray(0, 1), 1), rxEntry(han.subarray(1), 2)])
check('timestamp mode still decodes a split character', exports_.formatRow(rows[0], false, true).endsWith('中'), JSON.stringify(exports_.formatRow(rows[0], false, true)))

rows = exports_.groupRows([rxEntry('no newline here', 1), rxEntry(' at all', 2)])
check('a single line gets a single stamp', (exports_.formatRow(rows[0], false, true).match(/\d{2}:\d{2}:\d{2}\.\d{3}/g) ?? []).length === 1, JSON.stringify(exports_.formatRow(rows[0], false, true)))

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
// Assert the SHAPE, not a literal version: a literal here has to be edited on
// every release and silently turns into a stale claim when someone forgets.
check(
	'catalog: version is a publishable semver',
	typeof manifest.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version) && manifest.version !== '0.0.0',
	String(manifest.version),
)
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
// The package now ships both bridges, so `os` must not exclude Linux. Leaving the
// field out entirely is the widest declaration; listing both is equally correct.
check(
	'catalog: the package installs on Windows and Linux',
	manifest.os === undefined || (manifest.os.includes('win32') && manifest.os.includes('linux')),
	JSON.stringify(manifest.os),
)
// Regression guard. Shipping the native binding as a dependency made every
// update fail with ERR_PNPM_IGNORED_BUILDS, because DSH blocks dependency build
// scripts by default: pnpm resolved @serialport/bindings-cpp, refused to run its
// install script, and aborted the whole update. Windows never loads the binding
// (its bridge is PowerShell) and Linux installs it explicitly, so it must not
// appear in either dependency field.
check(
	'catalog: the native binding is not a declared dependency',
	(manifest.dependencies?.serialport ?? manifest.optionalDependencies?.serialport) === undefined,
	JSON.stringify({ dependencies: manifest.dependencies, optionalDependencies: manifest.optionalDependencies }),
)
check(
	'catalog: the POSIX bridge script ships in the package',
	fs.existsSync(join(here, '..', 'lib', 'serial-helper.mjs')) && (files.includes('lib') || files.includes('serial-helper.mjs')),
	`files=${JSON.stringify(files)}`,
)

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
// The right-sidebar tab is the plugin's ONLY surface: no left-sidebar panel row,
// no footer control, and no Settings page duplicating the same instrument.
check('registers no left-sidebar or settings surface', !injectedSlots.includes('sidebar.panellist') && !injectedSlots.includes('sidebar.footer.action') && !injectedSlots.includes('main') && !injectedSlots.includes('settings.section'), JSON.stringify(injectedSlots))
check('registers exactly the two pane slots', injectedSlots.length === 2, JSON.stringify(injectedSlots))

// A deployment without the service must register nothing and must not throw.
definedTypes.length = 0
registeredSlots.length = 0
const bare = makeCtx({ withService: false })
exports_.apply(bare)
check('a missing sidebarRightTabs service is survived', definedTypes.length === 0, `types=${definedTypes.length}`)
check('the seat disposer is retained for teardown', seatDisposers.length > 0, `disposers=${seatDisposers.length}`)

// A deployment whose service never appears still registers no slot entries.
await new Promise((resolve) => setTimeout(resolve, 5))
check('a missing service registers no slot entries', registeredSlots.length === 0, `slots=${registeredSlots.length}`)

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
// The label is a row sibling rather than a fixed-width Field: a Field's unused
// width sat inside the box and made the first gap wider than the rest.
check('the port-action label shares the row, so every gap matches', !source.includes('label: t("portAction")') && (source.match(/t\("portAction"\)/g) ?? []).length === 1, `${(source.match(/t\("portAction"\)/g) ?? []).length} label`)
// Three action buttons draw at one width, so they read as a row of peers; 帮助 is
// narrower because it sits in the row above and its label is two characters.
check('the action buttons share one width and 帮助 is narrower', (source.match(/width: ACTION_BUTTON_WIDTH/g) ?? []).length === 3 && (source.match(/width: HELP_BUTTON_WIDTH/g) ?? []).length === 1, `${(source.match(/width: ACTION_BUTTON_WIDTH/g) ?? []).length} action + ${(source.match(/width: HELP_BUTTON_WIDTH/g) ?? []).length} help`)
check('renders the window actions', joined.includes('保存窗口') && joined.includes('清除接收'))
// Clearing the log is routine and reversible, so it wears the normal ink rather
// than the danger red reserved for closing a port and stopping a transfer.
check('清除接收 uses the normal ink', !source.includes('onClick: clearReceive, disabled: lines.length === 0, tone: "danger"'), 'no danger tone')
check('renders the display checkboxes', ['16进制显示', 'DTR', 'RTS', '自动滚动', '时间戳'].every((label) => joined.includes(label)))
// The send band lost its tab strip: 帮助 moved into the parameters action row and
// the composer is always the band, so "单条发送" must be gone for good.
check('the send tab strip is gone', !joined.includes('单条发送'), joined.includes('单条发送') ? '单条发送 still rendered' : 'absent')
check('renders the help toggle', joined.includes('帮助'))
check('renders the send and clear-send controls', joined.includes('发送') && joined.includes('清除发送'))
check('renders the timed-send row', joined.includes('定时发送') && joined.includes('周期:'))
check('renders the file controls', ['打开文件', '发送文件', '停止发送'].every((label) => joined.includes(label)))
check('renders the send-mode checkboxes', joined.includes('16进制发送') && joined.includes('发送新行'))
check('renders the progress readout', joined.includes('0%'))
check('renders an empty-state hint', joined.includes('等待数据') || joined.includes('开始接收数据'))
check('falls back to a text input when no port enumerates', tags.includes('input') && tags.filter((t) => t === 'select').length === 5, `selects=${tags.filter((t) => t === 'select').length} (4 parameters + the language switch)`)
check('renders the language switch with both options', joined.includes('语言') && joined.includes('中文') && joined.includes('English'), `language label present=${joined.includes('语言')}`)
// The port field is a third of the row and may shrink (`0 1`), because the row never
// wraps and also carries 帮助 — a rigid third would overflow a narrow sidebar.
check(
	'the port field takes a third and shares the row with the switch',
	!source.includes('h(Field, { label: t("port"), width: 214 }') && source.includes('h(Field, { label: t("port"), flex: "0 1 33%" }') && source.includes('flexWrap: "nowrap"'),
	'one-third shrinkable port field, non-wrapping row',
)
check('renders the receive log container', tags.filter((t) => t === 'div').length > 5, `divs=${tags.filter((t) => t === 'div').length}`)
check('renders the composer textarea', tags.includes('textarea'))
// The two text wells carry their own border token; at the section border they
// were nearly invisible against the panel. A silent revert here is a visual
// regression no behavioural check would catch.
const inputBorderUses = source.split('${COLORS.borderInput}').length - 1
check('both text wells use the stronger input border', inputBorderUses === 2 && source.includes('borderInput:'), `usages=${inputBorderUses}`)
// One type size shared by both wells, one step above the surrounding controls.
const textSizeUses = source.split('fontSize: TEXT_SIZE,').length - 1
check('both text wells share one type size', textSizeUses === 2, `usages=${textSizeUses}`)
check('the text size is larger than the control size', /const TEXT_SIZE = (\d+);/.test(source) && Number(source.match(/const TEXT_SIZE = (\d+);/)[1]) > 12, source.match(/const TEXT_SIZE = \d+;/)?.[0])
// Every button draws its label at one size, so 帮助 and 打开串口 cannot drift apart.
check('all buttons share one type size', source.split('fontSize: BUTTON_SIZE,').length - 1 === 1 && /const BUTTON_SIZE = (\d+);/.test(source), source.match(/const BUTTON_SIZE = \d+;/)?.[0])
// Help opens over the panel instead of taking the send band's place.
check('the help text stays out of the panel until opened', !joined.includes('接收与发送都按到达分块显示'), joined.includes('接收与发送都按到达分块显示') ? 'help text rendered inline' : 'absent')
check('the help overlay is positioned against the panel', source.includes('position: "relative"') && source.includes('position: "absolute"'), 'relative ancestor + absolute overlay')
// The help must actually explain the three switches a reader has to guess at.
// One entry per control, laid out in the order the controls appear.
check(
	'the help explains DTR, RTS and auto-scroll',
	['hDtr', 'hRts', 'hAutoScroll'].every((key) => exports_.HELP_KEYS.includes(key) && tr('zh', key).length > 10 && tr('en', key).length > 10),
	exports_.HELP_KEYS.length + ' entries',
)
check('each explanation names its own control', tr('zh', 'hDtr').includes('「DTR」') && tr('zh', 'hRts').includes('「RTS」') && tr('zh', 'hAutoScroll').includes('「自动滚动」'))
check('no help line merges two controls', exports_.HELP_KEYS.every((key) => (exports_.MESSAGES.zh[key].match(/「/g) ?? []).length <= 1), exports_.HELP_KEYS.filter((key) => (exports_.MESSAGES.zh[key].match(/「/g) ?? []).length > 1).join(','))
check('every control in the panel has an entry', exports_.HELP_KEYS.length === 25, `${exports_.HELP_KEYS.length} entries`)
// The receive area and the send box explain themselves on screen; listing them only
// made the reader scroll past the controls they were actually looking up.
check(
	'the receive area and send box are not listed',
	!exports_.HELP_KEYS.includes('hReceive') && !exports_.HELP_KEYS.includes('hComposer') && exports_.MESSAGES.zh.hReceive === undefined && exports_.MESSAGES.en.hComposer === undefined,
	exports_.HELP_KEYS.join(','),
)
// The help is a two-column table: the control in one cell, its explanation in the
// next. Every entry has to split in both languages, or a row loses its control name.
const zhBaud = exports_.helpContent(tr('zh', 'hBaud'))
check('a help line splits into its control and its explanation', zhBaud.term === '波特率' && zhBaud.text.startsWith('通信速率'), JSON.stringify(zhBaud))
const enBaud = exports_.helpContent(tr('en', 'hBaud'))
check('the English form splits the same way', enBaud.term === '波特率/Baud rate' && enBaud.text.length > 10, JSON.stringify(enBaud))
check('the control column carries no quotes', !/[「」"]/.test(zhBaud.term) && !/["「」]/.test(enBaud.term), `${zhBaud.term} / ${enBaud.term}`)
const unsplit = exports_.HELP_KEYS.filter((key) => ['zh', 'en'].some((locale) => exports_.helpContent(exports_.MESSAGES[locale][key]).term === ''))
check('every help entry splits in both languages', unsplit.length === 0, unsplit.join(',') || 'all split')
check('the help renders as a table with two columns', source.includes('"table"') && tr('zh', 'helpTerm') === '控件' && tr('en', 'helpText').length > 0, `${tr('zh', 'helpTerm')} / ${tr('en', 'helpText')}`)
// The header is a band: centred text on a tint that is one step deeper than the
// surface tokens offer. Only that row carries it — the popup itself stays plain.
// The control column below is centred too, so names line up under their header.
check(
	'the help table header is a centred, tinted band',
	(source.match(/textAlign: "center"/g) ?? []).length === 3 && (source.match(/color-mix\(in srgb, var\(--dsw-alias-bg-layer-2/g) ?? []).length === 1,
	`${(source.match(/textAlign: "center"/g) ?? []).length} centred cells (2 header + the control column), ${(source.match(/color-mix\(in srgb, var\(--dsw-alias-bg-layer-2/g) ?? []).length} tinted row`,
)

// The three bands must appear in the requested order: parameters, receive, send.
const at = (needle) => texts.findIndex((text) => text.includes(needle))
check('parameters band precedes the receive band', at('串口选择') >= 0 && at('串口选择') < at('开始接收数据'), `parameters=${at('串口选择')} receive=${at('开始接收数据')}`)
check('receive band precedes the send band', at('开始接收数据') >= 0 && at('开始接收数据') < at('清除发送'), `receive=${at('开始接收数据')} send=${at('清除发送')}`)
// The input-mode switches moved above the box they modify, so they precede the
// composer row rather than trailing the file controls.
check('the send-mode switches sit above the composer', at('开始接收数据') < at('16进制发送') && at('16进制发送') < at('发送新行') && at('发送新行') < at('清除发送'), `receive=${at('开始接收数据')} hexSend=${at('16进制发送')} newline=${at('发送新行')} composer=${at('清除发送')}`)
check('timed send and the period share that row', at('发送新行') < at('定时发送') && at('定时发送') < at('周期:') && at('周期:') < at('清除发送'), `newline=${at('发送新行')} timed=${at('定时发送')} period=${at('周期:')}`)
check('the file controls follow the composer', at('清除发送') < at('打开文件') && at('打开文件') < at('发送文件'), `composer=${at('清除发送')} open=${at('打开文件')}`)
// 帮助 belongs to the parameters band now, right after 清除接收 — not to the send band.
// 帮助 sits at the right end of the port row, after the language switch.
check('the help toggle follows the language switch in the first row', at('语言') >= 0 && at('语言') < at('帮助') && at('帮助') < at('波特率'), `language=${at('语言')} help=${at('帮助')} baud=${at('波特率')}`)
// The claimed order must be the real one: read it back off the rendered tree.
const LAYOUT_ORDER = ['串口选择', '刷新', '语言', '帮助', '波特率', '停止位', '数据位', '校验位', '串口操作', '保存窗口', '清除接收', '16进制显示', 'DTR', 'RTS', '自动滚动', '时间戳']
const layoutPositions = LAYOUT_ORDER.map((label) => at(label))
check('the controls really sit in that order', layoutPositions.every((pos, i) => pos >= 0 && (i === 0 || layoutPositions[i - 1] < pos)), layoutPositions.join(','))
check(
	'the help follows the on-screen order, top to bottom then left to right',
	exports_.HELP_KEYS.slice(0, LAYOUT_ORDER.length).join(',') === 'hPort,hRefresh,hLanguage,hHelp,hBaud,hStopBits,hDataBits,hParity,hPortAction,hSaveWindow,hClearReceive,hHexView,hDtr,hRts,hAutoScroll,hTimestamps',
	exports_.HELP_KEYS.slice(0, LAYOUT_ORDER.length).join(','),
)
check(
	'the help keeps that order through the send band',
	exports_.HELP_KEYS.slice(LAYOUT_ORDER.length).join(',') === 'hHexSend,hNewline,hTimedSend,hPeriod,hSend,hClearSend,hOpenFile,hSendFile,hStopSending',
	exports_.HELP_KEYS.slice(LAYOUT_ORDER.length).join(','),
)
check('the composer is taller than the old three rows', /rows: [4-9]\d*,/.test(source), source.match(/rows: \d+,/)?.[0])
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

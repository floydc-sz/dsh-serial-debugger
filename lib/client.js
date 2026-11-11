/**
 * dsh-serial-debugger — client half (browser bundle).
 *
 * Ships pre-built in the module-system's lazy-CJS factory form, so no bundler
 * runs for this package: executing the script only registers the factory below,
 * and the module body materializes on first use. `require("react")` resolves
 * against the shell's frozen platform table, so the package declares no
 * `dsh.client.external` entries and depends on no other client package.
 *
 * Registers two slots that together form one feature:
 *   main              — the keyed central panel holding the whole debugger
 *   sidebar.panellist — the sidebar row that selects that panel
 *
 * All serial work happens in the host half; this file only renders state and
 * issues requests against the host route.
 */
window.__ModuleLoader__.load({
	id: "dsh-serial-debugger",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;
		const { useCallback, useEffect, useMemo, useRef, useState } = React;

		/** Host route base. Overridable for non-loopback-HTTP page origins. */
		const BASE = (() => {
			const override = globalThis.__DSH_SERIAL_DEBUGGER_BASE__;
			return typeof override === "string" && override !== "" ? override : "/dsh-serial-debugger";
		})();

		/** Receive-log entries kept in the DOM (the host retains more). */
		const RENDER_LIMIT = 3000;

		const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
		const DATA_BITS = [5, 6, 7, 8];
		const PARITIES = ["None", "Odd", "Even", "Mark", "Space"];
		const STOP_BITS = ["One", "OnePointFive", "Two"];
		const LINE_ENDINGS = [
			{ id: "none", label: "无", text: "", bytes: [] },
			{ id: "crlf", label: "CRLF", text: "\r\n", bytes: [13, 10] },
			{ id: "lf", label: "LF", text: "\n", bytes: [10] },
			{ id: "cr", label: "CR", text: "\r", bytes: [13] },
		];

		const COLORS = {
			label: "var(--dsw-alias-label-primary, #1f2329)",
			labelSecondary: "var(--dsw-alias-label-secondary, #646a73)",
			border: "var(--dsw-alias-border-l1, #dee0e3)",
			borderStrong: "var(--dsw-alias-border-l2, #c9cdd4)",
			// The two text wells (receive log, send composer) are the surface a reader
			// stares at, and at `border-l1` their edge disappeared into the panel. The
			// theme publishes no third border step, so this mixes `border-l2` toward
			// the secondary label: darker on a light theme, and lighter on a dark one,
			// which is the direction that raises contrast in both.
			borderInput: "color-mix(in srgb, var(--dsw-alias-border-l2, #c9cdd4) 65%, var(--dsw-alias-label-secondary, #646a73))",
			bg: "var(--dsw-alias-bg-base, #ffffff)",
			bgLayer: "var(--dsw-alias-bg-layer-1, #f7f8fa)",
			bgLayer2: "var(--dsw-alias-bg-layer-2, #f2f3f5)",
			brand: "var(--dsw-alias-brand-primary, #3370ff)",
			success: "var(--dsw-alias-state-success-primary, #34c724)",
			error: "var(--dsw-alias-state-error-primary, #f54a45)",
			warn: "var(--dsw-alias-state-warn-primary, #ff8800)",
			idle: "var(--dsw-alias-state-idle-primary, #bbbfc4)",
		};

		const MONO = "var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)";

		/**
		 * Type size of the two text wells — the receive log and the send composer.
		 * Shared so the two never drift apart, and one step above the 12px the
		 * surrounding controls use, because this is the text a reader actually reads.
		 */
		const TEXT_SIZE = 13;
		const TEXT_LINE = "19px";

		/** Upper bound on the decoded bytes one received row may accumulate before it is split. */
		const ROW_MAX_BYTES = 8192;

		// ── byte/encoding helpers ────────────────────────────────────────────

		function b64ToBytes(b64) {
			const binary = atob(b64);
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
			return bytes;
		}

		function bytesToB64(bytes) {
			let binary = "";
			for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
			return btoa(binary);
		}

		function bytesToHex(bytes) {
			const parts = new Array(bytes.length);
			for (let i = 0; i < bytes.length; i += 1) parts[i] = bytes[i].toString(16).padStart(2, "0");
			return parts.join(" ");
		}

		const textDecoder = typeof TextDecoder === "undefined" ? null : new TextDecoder("utf-8", { fatal: false });

		function bytesToText(bytes) {
			if (textDecoder !== null) {
				try {
					return textDecoder.decode(bytes);
				} catch (error) {
					// Fall through to the byte-wise decoding below.
				}
			}
			let out = "";
			for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
			return out;
		}

		/** Encode the composer's content, honouring hex mode and the line ending. */
		function encodeSend(text, encoding, lineEndingId) {
			const ending = LINE_ENDINGS.find((item) => item.id === lineEndingId) ?? LINE_ENDINGS[0];
			if (encoding === "hex") {
				const cleaned = text.replace(/0x/gi, "").replace(/[\s,;:_-]+/g, "");
				if (cleaned === "" && ending.bytes.length === 0) throw new Error("请输入要发送的十六进制字节");
				if (!/^[0-9a-fA-F]*$/.test(cleaned)) throw new Error("十六进制内容包含非十六进制字符");
				if (cleaned.length % 2 !== 0) throw new Error("十六进制内容需要偶数个字符");
				const digits = cleaned + ending.bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
				const bytes = new Uint8Array(digits.length / 2);
				for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(digits.substr(i * 2, 2), 16);
				return { base64: bytesToB64(bytes), label: text };
			}
			const payload = text + ending.text;
			if (payload === "") throw new Error("请输入要发送的内容");
			return { base64: bytesToB64(new TextEncoder().encode(payload)), label: text };
		}

		// ── host API ─────────────────────────────────────────────────────────

		async function request(path, init, timeoutMs) {
			const controller = typeof AbortController === "undefined" ? null : new AbortController();
			const timer = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs ?? 20000);
			try {
				const response = await fetch(BASE + path, {
					...init,
					signal: controller === null ? undefined : controller.signal,
					headers: { "content-type": "application/json", ...(init && init.headers ? init.headers : {}) },
				});
				const data = await response.json();
				if (data && data.ok === false) throw new Error(data.error || "宿主拒绝了该请求");
				return data;
			} finally {
				if (timer !== null) clearTimeout(timer);
			}
		}

		const api = {
			state: (since) => request(`/state?since=${since}`, { method: "GET" }),
			ports: () => request("/ports", { method: "GET" }),
			open: (config) => request("/open", { method: "POST", body: JSON.stringify(config) }),
			close: () => request("/close", { method: "POST", body: "{}" }),
			send: (base64, label) => request("/send", { method: "POST", body: JSON.stringify({ base64, label }) }),
			clear: () => request("/clear", { method: "POST", body: "{}" }),
		};

		// ── i18n ─────────────────────────────────────────────────────────────

		/**
		 * UI copy for both languages.
		 *
		 * The panel is Chinese-first because the serial-assistant layout it follows is
		 * Chinese, but every user-visible string resolves through this table, so the
		 * header switch can flip the whole surface at runtime.
		 */
		const MESSAGES = {
			zh: {
				language: "语言",
				port: "串口选择",
				baud: "波特率",
				stopBits: "停止位",
				dataBits: "数据位",
				parity: "校验位",
				portAction: "串口操作",
				refresh: "刷新",
				refreshTitle: "刷新串口列表",
				openPort: "打开串口",
				closePort: "关闭串口",
				working: "处理中…",
				saveWindow: "保存窗口",
				clearReceive: "清除接收",
				hasError: "有错误",
				hexView: "16进制显示",
				autoScroll: "自动滚动",
				timestamps: "时间戳",
				portClosed: "未打开串口",
				rxBytes: "接收 {n} B",
				txBytes: "发送 {n} B",
				entries: "{n} 条",
				hostStarting: "串口宿主启动中…",
				waitingData: "等待数据…",
				emptyHint: "选择串口参数后点击「打开串口」开始接收数据。",
				tabHelp: "帮助",
				helpClose: "关闭",
				helpTerm: "控件",
				helpText: "说明",
				send: "发送",
				clearSend: "清除发送",
				timedSend: "定时发送",
				period: "周期:",
				openFile: "打开文件",
				sendFile: "发送文件",
				sending: "发送中…",
				stopSending: "停止发送",
				hexSend: "16进制发送",
				appendNewline: "发送新行",
				placeholderHex: "AA 55 01 02（空格可选）",
				placeholderText: "输入要发送的数据，Ctrl+Enter 发送",
				// One entry per control, in the order the controls sit on the surface:
				// top to bottom, left to right. Do not join two controls into one line.
				hPort: "· 「串口选择」：选择要打开的串口。",
				hRefresh: "· 「刷新」：重新枚举串口列表。",
				hLanguage: "· 「语言」：切换界面语言，选择会被记住。",
				hBaud: "· 「波特率」：通信速率，需与设备一致。",
				hStopBits: "· 「停止位」：停止位长度，通常为 1。",
				hDataBits: "· 「数据位」：数据位长度，通常为 8。",
				hParity: "· 「校验位」：校验方式，通常为 None。",
				hPortAction: "· 「串口操作」：打开或关闭串口，连接后参数锁定。",
				hSaveWindow: "· 「保存窗口」：导出接收内容为 .txt 文件。",
				hClearReceive: "· 「清除接收」：清空接收区。",
				hHelp: "· 「帮助」：显示这份说明。",
				hHexView: "· 「16进制显示」：以十六进制显示接收内容。",
				hDtr: "· 「DTR」：数据终端就绪（Data Terminal Ready），置为有效后多数 USB 转串口设备才能收发。",
				hRts: "· 「RTS」：请求发送（Request To Send），置为有效；RTS/CTS 硬件流控时由驱动控制。",
				hAutoScroll: "· 「自动滚动」：跟随最新数据，上滚即暂停。",
				hTimestamps: "· 「时间戳」：每行加到达时间。",
				hHexSend: "· 「16进制发送」：按十六进制解析发送内容。",
				hNewline: "· 「发送新行」：发送时追加 CRLF。",
				hTimedSend: "· 「定时发送」：按周期重复发送。",
				hPeriod: "· 「周期」：定时发送间隔，单位毫秒。",
				hSend: "· 「发送」：发送输入框的内容。",
				hClearSend: "· 「清除发送」：清空发送输入框。",
				hOpenFile: "· 「打开文件」：选择要发送的文件。",
				hSendFile: "· 「发送文件」：分块发送并显示进度。",
				hStopSending: "· 「停止发送」：中断文件发送或定时发送。",
				hHexSend: "· 「16进制发送」：把输入按十六进制字节解析，AA 55 01、0xAA,0x55 均可。",
				hNewline: "· 「发送新行」：发送时在末尾追加 CRLF。",
				cannotReachHost: "无法连接串口宿主: {msg}",
				portsFailed: "枚举串口失败: {msg}",
				saveFailed: "保存失败: {msg}",
				fileTooLarge: "文件过大：单次上限 4 MB",
				fileReadFailed: "读取文件失败: {msg}",
				chooseFileFirst: "请先用「打开文件」选择要发送的文件",
				openPortFirst: "请先打开串口",
				fileStopped: "文件发送已停止",
				fileDone: "文件发送完成：{n} 字节",
				fileFailed: "文件发送失败: {msg}",
				errHexEmpty: "请输入要发送的十六进制字节",
				errHexInvalid: "十六进制内容包含非十六进制字符",
				errHexOdd: "十六进制内容需要偶数个字符",
				errEmpty: "请输入要发送的内容",
				tabTitle: "串口调试",
				guideDescription: "串口参数、接收显示与数据发送",
			},
			en: {
				language: "Language",
				port: "Port",
				baud: "Baud rate",
				stopBits: "Stop bits",
				dataBits: "Data bits",
				parity: "Parity",
				portAction: "Port",
				refresh: "Refresh",
				refreshTitle: "Re-enumerate the serial ports",
				openPort: "Open port",
				closePort: "Close port",
				working: "Working…",
				saveWindow: "Save window",
				clearReceive: "Clear receive",
				hasError: "Error",
				hexView: "Hex display",
				autoScroll: "Auto-scroll",
				timestamps: "Timestamps",
				portClosed: "Port closed",
				rxBytes: "RX {n} B",
				txBytes: "TX {n} B",
				entries: "{n} entries",
				hostStarting: "Serial host starting…",
				waitingData: "Waiting for data…",
				emptyHint: "Choose the port settings, then click \"Open port\" to start receiving.",
				tabHelp: "Help",
				helpClose: "Close",
				helpTerm: "Control",
				helpText: "What it does",
				send: "Send",
				clearSend: "Clear send",
				timedSend: "Timed send",
				period: "Period:",
				openFile: "Open file",
				sendFile: "Send file",
				sending: "Sending…",
				stopSending: "Stop sending",
				hexSend: "Hex send",
				appendNewline: "Append newline",
				placeholderHex: "AA 55 01 02 (spaces optional)",
				placeholderText: "Type the data to send; Ctrl+Enter sends",
				// One entry per control, in the same order as the zh dictionary.
				hPort: "· \"串口选择/Port\": picks the port to open.",
				hRefresh: "· \"刷新/Refresh\": re-enumerates the ports.",
				hLanguage: "· \"语言/Language\": switches the interface language, remembered.",
				hBaud: "· \"波特率/Baud rate\": line speed, must match the device.",
				hStopBits: "· \"停止位/Stop bits\": usually 1.",
				hDataBits: "· \"数据位/Data bits\": usually 8.",
				hParity: "· \"校验位/Parity\": usually None.",
				hPortAction: "· \"串口操作/Port action\": opens or closes the port, parameters lock while connected.",
				hSaveWindow: "· \"保存窗口/Save window\": exports the receive area to .txt.",
				hClearReceive: "· \"清除接收/Clear receive\": empties the receive area.",
				hHelp: "· \"帮助/Help\": shows this table.",
				hHexView: "· \"16进制显示/Hex display\": shows received bytes as hex.",
				hDtr: "· \"DTR\": data terminal ready — asserted by default; most USB-serial adapters need it to talk.",
				hRts: "· \"RTS\": request to send — asserted by default; the driver controls it under RTS/CTS flow control.",
				hAutoScroll: "· \"自动滚动/Auto-scroll\": follows new data, scrolling up pauses it.",
				hTimestamps: "· \"时间戳/Timestamps\": adds each line's arrival time.",
				hHexSend: "· \"16进制发送/Hex send\": parses the input as hex bytes.",
				hNewline: "· \"发送新行/Append newline\": appends CRLF.",
				hTimedSend: "· \"定时发送/Timed send\": resends on the period.",
				hPeriod: "· \"周期/Period\": interval in milliseconds.",
				hSend: "· \"发送/Send\": transmits the send box.",
				hClearSend: "· \"清除发送/Clear send\": empties the send box.",
				hOpenFile: "· \"打开文件/Open file\": picks the file to send.",
				hSendFile: "· \"发送文件/Send file\": sends in chunks and shows progress.",
				hStopSending: "· \"停止发送/Stop sending\": interrupts a file or timed send.",
				hHexSend: "· \"16进制发送/Hex send\": parses the input as hex bytes; both AA 55 01 and 0xAA,0x55 work.",
				hNewline: "· \"发送新行/Append newline\": appends CRLF when sending.",
				cannotReachHost: "Cannot reach the serial host: {msg}",
				portsFailed: "Could not enumerate ports: {msg}",
				saveFailed: "Save failed: {msg}",
				fileTooLarge: "File too large: 4 MB per send",
				fileReadFailed: "Could not read the file: {msg}",
				chooseFileFirst: "Choose a file with \"Open file\" first",
				openPortFirst: "Open the port first",
				fileStopped: "File transfer stopped",
				fileDone: "File sent: {n} bytes",
				fileFailed: "File send failed: {msg}",
				errHexEmpty: "Enter the hex bytes to send",
				errHexInvalid: "Hex input contains a non-hex character",
				errHexOdd: "Hex input needs an even number of digits",
				errEmpty: "Enter something to send",
				tabTitle: "Serial debugger",
				guideDescription: "Port parameters, live receive display and data sending",
			},
		};

		/**
		 * The help panel's body: one entry per control, in the order the controls sit
		 * on the surface — top to bottom, left to right. Two controls are never joined
		 * into one line, so a reader can look up exactly the control they are wondering
		 * about without reading past its neighbour.
		 */
		const HELP_KEYS = [
			"hPort", "hRefresh", "hLanguage", "hHelp",
			"hBaud", "hStopBits", "hDataBits", "hParity",
			"hPortAction", "hSaveWindow", "hClearReceive",
			"hHexView", "hDtr", "hRts", "hAutoScroll", "hTimestamps",
			"hHexSend", "hNewline", "hTimedSend", "hPeriod",
			"hSend", "hClearSend",
			"hOpenFile", "hSendFile", "hStopSending",
		];

		/**
		 * Split one help line into the control it explains and the explanation.
		 *
		 * The dictionary keeps each entry as a single sentence so a translator edits
		 * one string rather than two fields, and the shape is enforced by a test over
		 * every key in both languages: a punctuation drift fails the build instead of
		 * silently rendering a one-column table.
		 * @param line - one translated help line, e.g. `· 「波特率」：…`.
		 * @returns the control name with its quotes stripped, and the text after the separator.
		 */
		function splitHelpLine(line) {
			const match = /^·\s*(「[^」]+」|"[^"]*")\s*[：:]\s*([\s\S]*)$/.exec(line);
			if (match === null) return { term: "", text: line };
			// The quotes only mark the control inside the sentence; in a table cell the
			// column itself says what the name is, so the marks are dropped.
			return { term: match[1].slice(1, -1), text: match[2] };
		}

		/** Where the header switch remembers the reader's choice. */
		const LOCALE_KEY = "dsh-serial-debugger:locale";

		/** Locale the host runs in; captured at activation, the panel's default. */
		let hostLocale = "zh";

		/** Locale the surface is drawn in right now; the tab label reads it too. */
		let activeLocale = "zh";

		/** Reduce any BCP 47 tag to one of the two dictionaries. */
		function normalizeLocale(id) {
			return typeof id === "string" && id.toLowerCase().startsWith("zh") ? "zh" : "en";
		}

		/** The reader's stored choice, or null when they never made one. */
		function storedLocale() {
			try {
				const value = localStorage.getItem(LOCALE_KEY);
				return value === "zh" || value === "en" ? value : null;
			} catch {
				return null;
			}
		}

		/** Look one key up and fill the {name} holes. */
		function translate(locale, key, vars) {
			const table = MESSAGES[locale] ?? MESSAGES.zh;
			let text = table[key] ?? MESSAGES.zh[key] ?? key;
			if (vars !== undefined) {
				for (const [name, value] of Object.entries(vars)) text = text.split("{" + name + "}").join(String(value));
			}
			return text;
		}

		/** Translate against the active locale — for code outside the component. */
		function tc(key, vars) {
			return translate(activeLocale, key, vars);
		}

		// ── controls ─────────────────────────────────────────────────────────

		/**
		 * Geometry of the reference serial assistant: dense 24px controls, arranged in
		 * three stacked bands — parameters, receive, send.
		 */
		const ROW_HEIGHT = 24;
		/** Type size of every button, so no call site can drift from the others. */
		const BUTTON_SIZE = 12;
		/**
		 * Width of the action-row buttons — 打开/关闭串口, 保存窗口, 清除接收.
		 * Fixed rather than content-sized so they read as one row of peers; 86px is what
		 * a three-quarter-width button in the port field measured before.
		 */
		const ACTION_BUTTON_WIDTH = 86;
		/**
		 * 帮助 draws narrower than the action buttons beside it: two thirds of the 86px
		 * they use, because its label is two characters and it belongs to the row above.
		 */
		const HELP_BUTTON_WIDTH = 57;

		/**
		 * One label + control pair on a single line — the parameter band's repeating
		 * unit. `width` pins it (串口选择), `flex` shares a row evenly (a parameter pair).
		 */
		function Field(props) {
			const { label, children, width, flex } = props;
			return h(
				"div",
				{
					style: {
						display: "flex",
						alignItems: "center",
						gap: 5,
						minWidth: 0,
						...(width === undefined ? {} : { width }),
						...(flex === undefined ? {} : { flex }),
					},
				},
				h("span", { style: { fontSize: 12, color: COLORS.label, whiteSpace: "nowrap", flex: "none" } }, label),
				h("div", { style: { flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 4 } }, children),
			);
		}

		/** A combo box sized by its Field. */
		function ComboBox(props) {
			const { value, onChange, options, disabled } = props;
			return h(
				"select",
				{
					value,
					disabled: Boolean(disabled),
					onChange: (event) => onChange(event.target.value),
					style: {
						width: "100%",
						height: ROW_HEIGHT,
						padding: "0 4px",
						fontSize: 12,
						fontFamily: "inherit",
						color: disabled ? COLORS.idle : COLORS.label,
						background: disabled ? COLORS.bgLayer2 : COLORS.bg,
						border: `1px solid ${COLORS.borderStrong}`,
						borderRadius: 3,
						outline: "none",
					},
				},
				options.map((option) => h("option", { key: String(option.value), value: option.value }, option.label)),
			);
		}

		/** A compact button in the reference's flat, square style. */
		function TinyButton(props) {
			const { children, onClick, disabled, title, active, tone, style } = props;
			const ink = disabled ? COLORS.idle : tone === "danger" ? COLORS.error : tone === "primary" ? COLORS.brand : COLORS.label;
			return h(
				"button",
				{
					type: "button",
					onClick,
					disabled: Boolean(disabled),
					title,
					style: {
						height: ROW_HEIGHT + 2,
						padding: "0 8px",
						fontSize: BUTTON_SIZE,
						fontFamily: "inherit",
						color: ink,
						background: active ? COLORS.bgLayer2 : COLORS.bg,
						border: `1px solid ${COLORS.borderStrong}`,
						borderRadius: 3,
						cursor: disabled ? "not-allowed" : "pointer",
						whiteSpace: "nowrap",
						...style,
					},
				},
				children,
			);
		}

		/** A checkbox and its label on one line. */
		function Check(props) {
			const { checked, onChange, label, disabled, style } = props;
			return h(
				"label",
				{
					style: {
						display: "inline-flex",
						alignItems: "center",
						gap: 4,
						fontSize: 12,
						color: disabled ? COLORS.idle : COLORS.label,
						cursor: disabled ? "not-allowed" : "pointer",
						whiteSpace: "nowrap",
						...style,
					},
				},
				h("input", {
					type: "checkbox",
					checked: Boolean(checked),
					disabled: Boolean(disabled),
					onChange: (event) => onChange(event.target.checked),
					style: { margin: 0, flex: "none" },
				}),
				label,
			);
		}

		// ── the debugger panel ───────────────────────────────────────────────

		/**
		 * Collapse runs of received chunks into display rows.
		 *
		 * The port hands the host whatever bytes the driver happened to have, so one
		 * logical message arrives as many small chunks. Drawing one `<div>` per chunk
		 * made an ordinary message look as though line breaks had been sprinkled into
		 * it — the bytes were fine, the presentation was not. Grouping them also lets
		 * a multi-byte character split across a chunk boundary decode correctly,
		 * because the bytes are joined before they are decoded.
		 *
		 * Merged rows are capped so a device that streams without ever pausing cannot
		 * grow a single row without bound; the cap is invisible next to a wrapped line.
		 * @param lines - host log entries in arrival order.
		 * @returns rows of one or more entries each.
		 */
		function groupRows(lines) {
			const rows = [];
			for (const line of lines) {
				const last = rows[rows.length - 1];
				const grows = last === undefined ? 0 : last.bytes + Math.floor((line.b64 === undefined ? "" : line.b64).length * 0.75);
				if (line.kind === "rx" && last !== undefined && last.kind === "rx" && grows <= ROW_MAX_BYTES) {
					last.entries.push(line);
					last.bytes = grows;
					continue;
				}
				rows.push({
					kind: line.kind,
					entries: [line],
					key: line.seq,
					bytes: line.b64 === undefined ? 0 : Math.floor(line.b64.length * 0.75),
				});
			}
			return rows;
		}

		/** Join byte chunks into one buffer. */
		function concatBytes(chunks) {
			if (chunks.length === 1) return chunks[0];
			let length = 0;
			for (const chunk of chunks) length += chunk.length;
			const bytes = new Uint8Array(length);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.length;
			}
			return bytes;
		}

		/** Arrival time of one entry, as the display prefixes it. */
		function timeStamp(at) {
			if (typeof at !== "number") return "";
			return new Date(at).toLocaleTimeString("zh-CN", { hour12: false }) + "." + String(at % 1000).padStart(3, "0") + " ";
		}

		/**
		 * Join a row's chunks into one buffer and one string, remembering the character
		 * offset at which each chunk began.
		 *
		 * Joining before decoding is what keeps a multi-byte character that straddles a
		 * chunk boundary intact; the offsets are what let every text line still name the
		 * arrival that began it.
		 * @param entries - the row's log entries, in arrival order.
		 * @returns the bytes, the decoded text, and one `{ at, index }` mark per chunk.
		 */
		function mergeChunks(entries) {
			const bytes = concatBytes(entries.map((entry) => b64ToBytes(entry.b64)));
			const decoder = typeof TextDecoder === "undefined" ? null : new TextDecoder("utf-8", { fatal: false });
			if (decoder === null) {
				// No streaming decoder: decode in one go and stamp every line with the first arrival.
				return { bytes, text: bytesToText(bytes), marks: [{ at: entries[0].at, index: 0 }] };
			}
			const marks = [];
			let text = "";
			for (const entry of entries) {
				marks.push({ at: entry.at, index: text.length });
				text += decoder.decode(b64ToBytes(entry.b64), { stream: true });
			}
			text += decoder.decode();
			return { bytes, text, marks };
		}

		/**
		 * Split text into display lines, each with the character offset it starts at.
		 *
		 * A payload ending in a line break has nothing after it, so that empty tail is
		 * not a line and must not be stamped.
		 * @param text - decoded payload.
		 * @returns one `{ start, body }` per line.
		 */
		function textLines(text) {
			const lines = [];
			const pattern = /\r\n|\r|\n/g;
			let start = 0;
			let match = pattern.exec(text);
			while (match !== null) {
				lines.push({ start, body: text.slice(start, match.index) });
				start = match.index + match[0].length;
				match = pattern.exec(text);
			}
			lines.push({ start, body: text.slice(start) });
			if (lines.length > 1 && lines[lines.length - 1].body === "") lines.pop();
			return lines;
		}

		/** The arrival time of the chunk that began the character at `index`. */
		function arrivalFor(marks, index) {
			let at = marks[0].at;
			for (const mark of marks) {
				if (mark.index > index) break;
				at = mark.at;
			}
			return at;
		}

		/**
		 * One display row as text, shared by the receive area and 保存窗口 so a saved
		 * log reads exactly like the screen.
		 *
		 * With timestamps on, the row is still merged — bytes must be joined before
		 * decoding, or a split character becomes two replacement characters — but every
		 * text line inside it is stamped with the arrival that began it. Stamping only
		 * the row would put a single time above a whole block of lines.
		 * @param row - a row produced by `groupRows`.
		 * @param hexView - render payloads as hex instead of text.
		 * @param showTime - prefix each text line with its arrival time.
		 * @returns the display string, possibly spanning several lines.
		 */
		function formatRow(row, hexView, showTime) {
			const first = row.entries[0];
			const prefix = first.kind === "tx" ? "→ " : "";
			if (first.b64 === undefined) {
				const stamp = showTime ? timeStamp(first.at) : "";
				return stamp + (first.kind === "err" ? "! " : "· ") + (first.text === undefined ? "" : first.text);
			}
			const merged = mergeChunks(row.entries);
			if (hexView) {
				// A hex dump is one continuous run of bytes; there are no text lines to stamp.
				const stamp = showTime ? timeStamp(first.at) : "";
				return stamp + prefix + bytesToHex(merged.bytes);
			}
			if (!showTime) return prefix + merged.text;
			if (merged.text === "") return "";
			return textLines(merged.text)
				.map((line, index) => timeStamp(arrivalFor(merged.marks, line.start)) + (index === 0 ? prefix : "") + line.body)
				.join("\n");
		}

		/**
		 * The serial debugger, in three stacked bands:
		 *
		 *   top    — 串口选择 / 波特率 / 停止位 / 数据位 / 校验位 / 串口操作
		 *            plus 保存窗口 / 清除接收 and the display toggles
		 *   middle — the receive area, taking every remaining pixel
		 *   bottom — 单条发送 / 帮助, the composer, and the send options
		 *
		 * Each band wraps its own contents, so the layout holds in the narrow right
		 * sidebar and in a wide panel without measuring the surface.
		 */
		function SerialDebuggerPage() {
			const [form, setForm] = useState({
				port: "",
				baudRate: 115200,
				dataBits: 8,
				parity: "None",
				stopBits: "One",
				dtr: true,
				rts: true,
			});
			const [status, setStatus] = useState({ ready: false, connected: false, config: null, ports: [], lastError: null });
			const [lines, setLines] = useState([]);
			const [hexView, setHexView] = useState(false);
			const [showTime, setShowTime] = useState(false);
			const [autoScroll, setAutoScroll] = useState(true);
			const [composer, setComposer] = useState("");
			const [hexSend, setHexSend] = useState(false);
			const [newline, setNewline] = useState(false);
			const [timedSend, setTimedSend] = useState(false);
			const [period, setPeriod] = useState(1000);
			const [helpOpen, setHelpOpen] = useState(false);
			const [busy, setBusy] = useState("");
			const [problem, setProblem] = useState(null);
			const [counts, setCounts] = useState({ rx: 0, tx: 0 });
			const [progress, setProgress] = useState(null);
			// The header switch remembers its own choice; until the reader makes one,
			// the surface follows the language the host itself runs in.
			const [locale, setLocale] = useState(() => activeLocale);

			/** Translate one key for this render. */
			const t = useCallback((key, vars) => translate(locale, key, vars), [locale]);

			/** Flip the surface language and remember it for the next visit. */
			const changeLocale = useCallback((next) => {
				if (next !== "zh" && next !== "en") return;
				activeLocale = next;
				setLocale(next);
				try {
					localStorage.setItem(LOCALE_KEY, next);
				} catch {
					// Private mode or a blocked store: the choice lasts this session only.
				}
			}, []);

			const cursor = useRef(-1);
			const logRef = useRef(null);
			const alive = useRef(true);
			const fileInput = useRef(null);
			const fileJob = useRef(null);
			const fileStop = useRef(false);

			/** Fold one server frame into local state. */
			const absorb = useCallback((frame) => {
				cursor.current = frame.next;
				if (Array.isArray(frame.lines) && frame.lines.length > 0) {
					setLines((previous) => {
						const merged = previous.concat(frame.lines);
						return merged.length > RENDER_LIMIT ? merged.slice(merged.length - RENDER_LIMIT) : merged;
					});
					setCounts((previous) => {
						let rx = previous.rx;
						let tx = previous.tx;
						for (const line of frame.lines) {
							if (line.b64 === undefined) continue;
							const size = Math.floor((line.b64.length * 3) / 4);
							if (line.kind === "rx") rx += size;
							if (line.kind === "tx") tx += size;
						}
						return { rx, tx };
					});
				}
				if (frame.status) setStatus(frame.status);
			}, []);

			// One self-rescheduling poll: the next request is only scheduled after the
			// previous settles, so a slow host never queues up work.
			useEffect(() => {
				alive.current = true;
				let timer = null;
				let failures = 0;
				const tick = async () => {
					if (!alive.current) return;
					try {
						const frame = await api.state(cursor.current);
						if (!alive.current) return;
						absorb(frame);
						failures = 0;
						setProblem(null);
					} catch (error) {
						if (!alive.current) return;
						failures += 1;
						if (failures <= 3) setProblem(t("cannotReachHost", { msg: error.message }));
					}
					if (!alive.current) return;
					timer = setTimeout(tick, failures === 0 ? 250 : Math.min(4000, 500 * failures));
				};
				tick();
				return () => {
					alive.current = false;
					if (timer !== null) clearTimeout(timer);
				};
			}, [absorb]);

			// Follow the tail unless the reader has scrolled away from it.
			useEffect(() => {
				const node = logRef.current;
				if (node === null || !autoScroll) return;
				node.scrollTop = node.scrollHeight;
			}, [lines, autoScroll]);

			/** Encode the composer, honouring the two send-mode checkboxes. */
			const payloadOf = useCallback(() => encodeSend(composer, hexSend ? "hex" : "text", newline ? "crlf" : "none"), [composer, hexSend, newline]);

			const refreshPorts = useCallback(async () => {
				setBusy("ports");
				try {
					const data = await api.ports();
					if (data.status) setStatus(data.status);
					const ports = Array.isArray(data.ports) ? data.ports : [];
					const first = ports.length === 0 ? "" : typeof ports[0] === "string" ? ports[0] : ports[0].name;
					setForm((previous) => (previous.port === "" && first !== "" ? { ...previous, port: first } : previous));
					setProblem(null);
				} catch (error) {
					setProblem(t("portsFailed", { msg: error.message }));
				} finally {
					setBusy("");
				}
			}, []);

			const togglePort = useCallback(async () => {
				setBusy("port");
				try {
					if (status.connected) await api.close();
					else await api.open(form);
					setProblem(null);
					absorb(await api.state(cursor.current));
				} catch (error) {
					setProblem(error.message);
				} finally {
					setBusy("");
				}
			}, [absorb, form, status.connected]);

			const doSend = useCallback(async () => {
				setBusy("send");
				try {
					const payload = payloadOf();
					await api.send(payload.base64, payload.label);
					setProblem(null);
					absorb(await api.state(cursor.current));
				} catch (error) {
					setProblem(error.message);
				} finally {
					setBusy("");
				}
			}, [absorb, payloadOf]);

			const clearReceive = useCallback(async () => {
				try {
					await api.clear();
					setLines([]);
					setCounts({ rx: 0, tx: 0 });
					cursor.current = -1;
				} catch (error) {
					setProblem(error.message);
				}
			}, []);

			const clearSend = useCallback(() => {
				setComposer("");
				setTimedSend(false);
				fileJob.current = null;
				setProgress(null);
			}, []);

			/** Download the receive area as a plain-text log. */
			const saveWindow = useCallback(() => {
				try {
					if (typeof document === "undefined") return;
					const text = groupRows(lines).map((row) => formatRow(row, hexView, showTime)).join("\n");
					const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
					const url = URL.createObjectURL(blob);
					const anchor = document.createElement("a");
					anchor.href = url;
					anchor.download = `serial-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
					anchor.click();
					setTimeout(() => URL.revokeObjectURL(url), 2000);
				} catch (error) {
					setProblem(t("saveFailed", { msg: error.message }));
				}
			}, [hexView, lines, showTime]);

			/** Stage a file for 发送文件 (read up front so the send loop stays simple). */
			const chooseFile = useCallback(async (event) => {
				const file = event.target.files && event.target.files[0];
				event.target.value = "";
				if (!file) return;
				if (file.size > 4 * 1024 * 1024) {
					setProblem(t("fileTooLarge"));
					return;
				}
				try {
					const buffer = await file.arrayBuffer();
					fileJob.current = { bytes: new Uint8Array(buffer), sent: 0, name: file.name };
					setProgress(0);
					setProblem(null);
				} catch (error) {
					setProblem(t("readFileFailed", { msg: error.message }));
				}
			}, []);

			const sendFile = useCallback(async () => {
				const job = fileJob.current;
				if (job === null || job === undefined) {
					setProblem(t("chooseFileFirst"));
					return;
				}
				if (!status.connected) {
					setProblem(t("openPortFirst"));
					return;
				}
				setBusy("file");
				fileStop.current = false;
				job.sent = 0;
				try {
					const chunk = 1024;
					while (job.sent < job.bytes.length && !fileStop.current) {
						const slice = job.bytes.subarray(job.sent, Math.min(job.sent + chunk, job.bytes.length));
						await api.send(bytesToB64(slice), undefined);
						job.sent += slice.length;
						setProgress(job.sent / job.bytes.length);
					}
					setProblem(fileStop.current ? t("fileStopped") : t("fileDone", { n: job.bytes.length }));
				} catch (error) {
					setProblem(t("fileFailed", { msg: error.message }));
				} finally {
					setBusy("");
				}
			}, [status.connected]);

			const stopSending = useCallback(() => {
				fileStop.current = true;
				setTimedSend(false);
			}, []);

			// 定时发送: one independent ticker while the checkbox is on. An empty or
			// invalid composer skips the tick instead of tearing the timer down.
			useEffect(() => {
				if (!timedSend || !status.connected) return undefined;
				const every = Math.max(20, Number(period) || 1000);
				const timer = setInterval(() => {
					try {
						const payload = encodeSend(composer, hexSend ? "hex" : "text", newline ? "crlf" : "none");
						api.send(payload.base64, payload.label).catch(() => {});
					} catch {
						// Nothing valid to send on this tick.
					}
				}, every);
				return () => clearInterval(timer);
			}, [composer, hexSend, newline, period, status.connected, timedSend]);

			/** Port choices, description-first like the reference's combo. */
			const portOptions = useMemo(() => {
				const raw = Array.isArray(status.ports) ? status.ports : [];
				const list = [];
				for (const item of raw) {
					const name = typeof item === "string" ? item : item && item.name ? item.name : "";
					if (name === "") continue;
					const description = typeof item === "string" ? "" : item && item.description ? item.description : "";
					list.push({ name, description });
				}
				if (form.port !== "" && !list.some((item) => item.name === form.port)) list.push({ name: form.port, description: "" });
				return list;
			}, [form.port, status.ports]);

			const connected = status.connected;
			const connectionLabel = connected && status.config
				? `${status.config.port} · ${status.config.baudRate} · ${status.config.dataBits}${String(status.config.parity).charAt(0)}${status.config.stopBits}`
				: t("portClosed");
			const percent = progress === null ? 0 : Math.round(progress * 100);
			const numberStyle = {
				height: ROW_HEIGHT,
				padding: "0 4px",
				fontSize: 12,
				fontFamily: "inherit",
				color: COLORS.label,
				background: COLORS.bg,
				border: `1px solid ${COLORS.borderStrong}`,
				borderRadius: 3,
				outline: "none",
			};

			// ── band 1: parameters ────────────────────────────────────────────
			const portControl = portOptions.length === 0
				? h("input", {
					value: form.port,
					placeholder: "COM3",
					disabled: connected,
					onChange: (event) => setForm({ ...form, port: event.target.value }),
					style: { ...numberStyle, width: "100%" },
				})
				: h(ComboBox, {
					value: form.port,
					disabled: connected,
					onChange: (value) => setForm({ ...form, port: value }),
					options: portOptions.map((item) => ({
						value: item.name,
						label: item.description === "" ? item.name : `${item.name}:${item.description}`,
					})),
				});

			const parameters = h(
				"div",
				{
					style: {
						flex: "none",
						border: `1px solid ${COLORS.border}`,
						borderRadius: 3,
						background: COLORS.bgLayer,
						padding: "8px 8px 6px",
						display: "flex",
						flexDirection: "column",
						gap: 7,
					},
				},
				h(
					"div",
					{ style: { display: "flex", flexWrap: "nowrap", columnGap: 10, alignItems: "center", minWidth: 0 } },
					// The port field takes a third of the row: enough to show a device name, with
					// the rest left for the language switch and 帮助 at the right. It may shrink,
					// because a non-wrapping row has to absorb whatever follows.
					h(Field, { label: t("port"), flex: "0 1 33%" },
						portControl,
						h(TinyButton, {
							onClick: refreshPorts,
							disabled: connected || busy !== "",
							title: t("refreshTitle"),
							style: { flex: "none", padding: "0 6px" },
						}, busy === "ports" ? "…" : t("refresh")),
					),
					h("span", { style: { flex: 1 } }),
					h("span", { style: { fontSize: 12, color: COLORS.label, whiteSpace: "nowrap", flex: "none" } }, t("language")),
					h(
						"select",
						{
							value: locale,
							"aria-label": t("language"),
							title: t("language"),
							onChange: (event) => changeLocale(event.target.value),
							style: {
								flex: "none",
								height: ROW_HEIGHT,
								padding: "0 4px",
								fontSize: 12,
								fontFamily: "inherit",
								color: COLORS.label,
								background: COLORS.bg,
								border: `1px solid ${COLORS.borderStrong}`,
								borderRadius: 3,
								outline: "none",
								cursor: "pointer",
							},
						},
						h("option", { value: "zh" }, "中文"),
						h("option", { value: "en" }, "English"),
					),
					h(TinyButton, { onClick: () => setHelpOpen((open) => !open), tone: helpOpen ? "primary" : undefined, style: { width: HELP_BUTTON_WIDTH } }, t("tabHelp")),
				),
				// Two rows of two, each pair sharing its line evenly. `flex: 1 1 0` plus a
				// row that cannot wrap keeps a pair together and aligns the two rows'
				// controls into one grid; every label sits beside its control.
				h(
					"div",
					{ style: { display: "flex", gap: 10, alignItems: "center" } },
					h(Field, { label: t("baud"), flex: "1 1 0" },
						h(ComboBox, {
							value: String(form.baudRate),
							disabled: connected,
							onChange: (value) => setForm({ ...form, baudRate: Number(value) }),
							options: (BAUD_RATES.includes(Number(form.baudRate)) ? BAUD_RATES : BAUD_RATES.concat([Number(form.baudRate)]))
								.filter((rate) => Number.isFinite(rate))
								.map((rate) => ({ value: String(rate), label: String(rate) })),
						}),
					),
					h(Field, { label: t("stopBits"), flex: "1 1 0" },
						h(ComboBox, {
							value: form.stopBits,
							disabled: connected,
							onChange: (value) => setForm({ ...form, stopBits: value }),
							options: STOP_BITS.map((item) => ({ value: item, label: item === "OnePointFive" ? "1.5" : item === "One" ? "1" : "2" })),
						}),
					),
				),
				h(
					"div",
					{ style: { display: "flex", gap: 10, alignItems: "center" } },
					h(Field, { label: t("dataBits"), flex: "1 1 0" },
						h(ComboBox, {
							value: String(form.dataBits),
							disabled: connected,
							onChange: (value) => setForm({ ...form, dataBits: Number(value) }),
							options: DATA_BITS.map((item) => ({ value: String(item), label: String(item) })),
						}),
					),
					h(Field, { label: t("parity"), flex: "1 1 0" },
						h(ComboBox, {
							value: form.parity,
							disabled: connected,
							onChange: (value) => setForm({ ...form, parity: value }),
							options: PARITIES.map((item) => ({ value: item, label: item })),
						}),
					),
				),
				h(
					"div",
					{ style: { display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" } },
					// The label is a plain sibling here, not a fixed-width Field: a wider Field
					// left its unused space inside the box, which pushed the first button away
					// from the three that follow. As siblings, the row's single gap applies to
					// all of them equally.
					h("span", { style: { fontSize: 12, color: COLORS.label, whiteSpace: "nowrap", flex: "none" } }, t("portAction")),
					h(TinyButton, {
						onClick: togglePort,
						disabled: busy === "port" || (!connected && form.port === ""),
						tone: connected ? "danger" : "primary",
						style: { width: ACTION_BUTTON_WIDTH },
					}, busy === "port" ? t("working") : connected ? t("closePort") : t("openPort")),
					h(TinyButton, { onClick: saveWindow, disabled: lines.length === 0, style: { width: ACTION_BUTTON_WIDTH } }, t("saveWindow")),
					h(TinyButton, { onClick: clearReceive, disabled: lines.length === 0, style: { width: ACTION_BUTTON_WIDTH } }, t("clearReceive")),
					status.lastError !== null && status.lastError !== undefined
						? h("span", {
							title: status.lastError,
							style: { fontSize: 11, color: COLORS.error, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140 },
						}, t("hasError"))
						: null,
				),
				h(
					"div",
					{ style: { display: "flex", flexWrap: "wrap", columnGap: 12, rowGap: 5, alignItems: "center" } },
					h(Check, { checked: hexView, onChange: setHexView, label: t("hexView") }),
					h(Check, { checked: form.dtr, onChange: (value) => setForm({ ...form, dtr: value }), disabled: connected, label: "DTR" }),
					h(Check, { checked: form.rts, onChange: (value) => setForm({ ...form, rts: value }), disabled: connected, label: "RTS" }),
					h(Check, { checked: autoScroll, onChange: setAutoScroll, label: t("autoScroll") }),
					h(Check, { checked: showTime, onChange: setShowTime, label: t("timestamps") }),
				),
			);

			// ── band 2: receive ───────────────────────────────────────────────
			// Grouped once: the area draws the rows and the status line counts them,
			// so "N 条" matches the number of lines the reader can actually see.
			const rows = groupRows(lines);
			const receive = h(
				"div",
				{
					ref: logRef,
					onScroll: (event) => {
						const node = event.target;
						const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
						if (atBottom !== autoScroll) setAutoScroll(atBottom);
					},
					style: {
						flex: 1,
						minHeight: 0,
						overflowY: "auto",
						padding: "6px 8px",
						fontFamily: MONO,
						fontSize: TEXT_SIZE,
						lineHeight: TEXT_LINE,
						background: COLORS.bg,
						border: `1px solid ${COLORS.borderInput}`,
						borderRadius: 3,
						whiteSpace: "pre-wrap",
						wordBreak: "break-all",
					},
				},
				lines.length === 0
					? h("span", { style: { color: COLORS.labelSecondary } }, connected ? t("waitingData") : t("emptyHint"))
					: rows.map((row, index) =>
						h(
							"div",
							{ key: row.key === undefined ? index : row.key, style: { color: row.kind === "err" ? COLORS.error : row.kind === "tx" ? COLORS.labelSecondary : COLORS.label } },
							formatRow(row, hexView, showTime),
						),
					),
			);

			const statusBar = h(
				"div",
				{
					style: {
						flex: "none",
						display: "flex",
						alignItems: "center",
						gap: 10,
						padding: "0 2px 2px",
						fontSize: 11,
						color: COLORS.labelSecondary,
						flexWrap: "wrap",
					},
				},
				h("span", { style: { display: "inline-flex", alignItems: "center", gap: 5, color: COLORS.label } },
					h("span", { style: { width: 7, height: 7, borderRadius: "50%", background: connected ? COLORS.success : COLORS.idle } }),
					connectionLabel,
				),
				h("span", null, t("rxBytes", { n: counts.rx })),
				h("span", null, t("txBytes", { n: counts.tx })),
				h("span", null, t("entries", { n: rows.length })),
				!status.ready ? h("span", { style: { color: COLORS.warn } }, t("hostStarting")) : null,
			);

			const receiveBand = h(
				"div",
				{ style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 4 } },
				receive,
				statusBar,
			);

			// ── band 3: send ──────────────────────────────────────────────────
			// Help opens over the surface instead of swapping into the send band: the
			// composer is what you are typing into, and pushing it off the panel to read
			// a hint is the wrong trade. Keys stay in the dictionary so both locales
			// carry the same text.
			const helpPanel = helpOpen
				? h(
					"div",
					{
						onClick: () => setHelpOpen(false),
						style: {
							position: "absolute",
							inset: 0,
							zIndex: 20,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							padding: 10,
							background: "rgba(0, 0, 0, 0.28)",
						},
					},
					h(
						"div",
						{
							onClick: (event) => event.stopPropagation(),
							style: {
								maxHeight: "100%",
								overflowY: "auto",
								display: "flex",
								flexDirection: "column",
								gap: 5,
								padding: "10px 12px",
								background: COLORS.bg,
								border: `1px solid ${COLORS.borderStrong}`,
								borderRadius: 4,
								boxShadow: "0 8px 28px rgba(0, 0, 0, 0.22)",
								fontSize: TEXT_SIZE - 1,
								lineHeight: "19px",
								color: COLORS.labelSecondary,
							},
						},
						h(
							"div",
							{ style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 2 } },
							h("span", { style: { fontSize: BUTTON_SIZE + 1, color: COLORS.label } }, t("tabHelp")),
							h("span", { style: { flex: 1 } }),
							h(TinyButton, { onClick: () => setHelpOpen(false), style: { flex: "none" } }, t("helpClose")),
						),
						h(
							"table",
							{ style: { borderCollapse: "collapse", width: "100%", fontSize: TEXT_SIZE - 1, lineHeight: "18px", color: COLORS.labelSecondary } },
							h("thead", null,
								// Only this row is tinted; the popup around it keeps the surface colour.
								// bg-layer-2 on its own is nearly invisible against a white panel, so it
								// is mixed one step toward the border to read as a distinct band.
								h("tr", { style: { background: "color-mix(in srgb, var(--dsw-alias-bg-layer-2, #f2f3f5) 80%, var(--dsw-alias-border-l2, #c9cdd4))" } },
									h("th", { style: { padding: "4px 8px 4px 0", textAlign: "center", fontWeight: 600, color: COLORS.label, whiteSpace: "nowrap" } }, t("helpTerm")),
									h("th", { style: { padding: "4px 0", textAlign: "center", fontWeight: 600, color: COLORS.label } }, t("helpText")),
								),
							),
							h("tbody", null,
								HELP_KEYS.map((key) => {
									const line = splitHelpLine(t(key));
									return h("tr", { key, style: { borderTop: `1px solid ${COLORS.border}` } },
										h("td", { style: { padding: "3px 8px 3px 0", verticalAlign: "top", whiteSpace: "nowrap", textAlign: "center", fontWeight: 600, color: COLORS.label } }, line.term),
										h("td", { style: { padding: "3px 0", verticalAlign: "top" } }, line.text),
									);
								}),
							),
						),
					),
				)
				: null;

			const sendBody = h(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: 6, paddingTop: 6 } },
				// Input-mode switches and the timed-send period sit directly above the box
				// they govern: "hex send" or "repeat every 1000 ms" next to a box far down
				// the panel does not read as belonging to it.
				h("div", { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } },
					h(Check, { checked: hexSend, onChange: setHexSend, label: t("hexSend") }),
					h(Check, { checked: newline, onChange: setNewline, label: t("appendNewline") }),
					h(Check, { checked: timedSend, onChange: setTimedSend, disabled: !connected, label: t("timedSend") }),
					h("span", { style: { fontSize: 12, color: COLORS.label } }, t("period")),
					h("input", {
						type: "number",
						min: 20,
						value: period,
						disabled: !connected,
						onChange: (event) => setPeriod(event.target.value === "" ? "" : Number(event.target.value)),
						style: { ...numberStyle, width: 74 },
					}),
					h("span", { style: { fontSize: 12, color: COLORS.label } }, "ms"),
				),
				h("div", { style: { display: "flex", gap: 6, alignItems: "stretch" } },
					h("textarea", {
						value: composer,
						placeholder: hexSend ? t("placeholderHex") : t("placeholderText"),
						onChange: (event) => setComposer(event.target.value),
						onKeyDown: (event) => {
							if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
								event.preventDefault();
								if (connected && busy === "") doSend();
							}
						},
						rows: 5,
						style: {
							flex: 1,
							minWidth: 0,
							resize: "vertical",
							padding: "5px 6px",
							fontSize: TEXT_SIZE,
							fontFamily: MONO,
							lineHeight: TEXT_LINE,
							color: COLORS.label,
							background: COLORS.bg,
							border: `1px solid ${COLORS.borderInput}`,
							borderRadius: 3,
							outline: "none",
						},
					}),
					h("div", { style: { display: "flex", flexDirection: "column", gap: 6, width: 84, flex: "none" } },
						h(TinyButton, { onClick: doSend, disabled: !connected || busy === "send" || composer === "", tone: "primary", style: { flex: 1 } }, busy === "send" ? "…" : t("send")),
						h(TinyButton, { onClick: clearSend, disabled: composer === "", tone: "danger", style: { flex: 1 } }, t("clearSend")),
					),
				),
				// File controls, their progress bar and the readout share one line: the bar
				// reports on the send it sits beside, and a row of its own separated them.
				// The row stays flush with the composer's left edge.
				h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
					h(TinyButton, { onClick: () => { const node = fileInput.current; if (node !== null && node !== undefined) node.click(); } }, t("openFile")),
					h(TinyButton, { onClick: sendFile, disabled: !connected || busy === "file" }, busy === "file" ? t("sending") : t("sendFile")),
					h(TinyButton, { onClick: stopSending, disabled: busy !== "file" && !timedSend, tone: "danger" }, t("stopSending")),
					h("div", { style: { flex: 1, minWidth: 90, height: 10, background: COLORS.bgLayer2, border: `1px solid ${COLORS.border}`, borderRadius: 2, overflow: "hidden" } },
						h("div", { style: { width: `${percent}%`, height: "100%", background: COLORS.brand } }),
					),
					h("span", { style: { fontSize: 11, color: COLORS.labelSecondary, width: 34, textAlign: "right" } }, `${percent}%`),
					h("input", { ref: fileInput, type: "file", onChange: chooseFile, style: { display: "none" } }),
				),
			);

			const sendBand = h(
				"div",
				{ style: { flex: "none", display: "flex", flexDirection: "column" } },
				sendBody,
			);

			return h(
				"div",
				{
					style: {
						flex: "1 1 auto",
						height: "100%",
						minHeight: 0,
						display: "flex",
						flexDirection: "column",
						padding: 8,
						boxSizing: "border-box",
						background: COLORS.bg,
						color: COLORS.label,
						gap: 8,
						// The help overlay is positioned against this surface, so it covers
						// the panel rather than the whole window.
						position: "relative",
					},
				},
				problem !== null
					? h("div", {
						style: {
							flex: "none",
							padding: "3px 6px",
							fontSize: 12,
							color: COLORS.error,
							background: COLORS.bgLayer2,
							border: `1px solid ${COLORS.border}`,
							borderRadius: 3,
							wordBreak: "break-all",
						},
					}, problem)
					: null,
				parameters,
				receiveBand,
				sendBand,
				helpPanel,
			);
		}

		// ── sidebar row glyph ────────────────────────────────────────────────

		/**
		 * A DB9-style connector glyph for the sidebar panel row.
		 * @param props - `SidebarPanelIconOwnerProps`: the requested edge `size` and
		 *   whether this panel is the `active` one in the main column.
		 */
		function SerialDebuggerIcon(props) {
			const size = (props && props.size) || 16;
			const active = Boolean(props && props.active);
			return h(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 16 16",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: active ? 1.7 : 1.4,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true",
				},
				h("rect", {
					x: 2.2,
					y: 5.2,
					width: 11.6,
					height: 5.8,
					rx: 1.7,
					fill: active ? "currentColor" : "none",
					fillOpacity: active ? 0.14 : 0,
				}),
				h("circle", { cx: 5.1, cy: 8.1, r: 0.6, fill: "currentColor", stroke: "none" }),
				h("circle", { cx: 8, cy: 8.1, r: 0.6, fill: "currentColor", stroke: "none" }),
				h("circle", { cx: 10.9, cy: 8.1, r: 0.6, fill: "currentColor", stroke: "none" }),
				h("path", { d: "M6.4 5.2V3.4h3.2v1.8" }),
			);
		}

		// ── the right sidebar tab ────────────────────────────────────────────

		/** Tab type id: the registry key, and the body/title slot key. */
		const TAB_TYPE_ID = "dsh-serial-debugger:panel";
		/** The kind a guide row opens and `openTab` addresses. */
		const TAB_KIND = "serial-debugger";

		/** Outcome of the tab-type registration, surfaced by the mount diagnostic. */
		const rightTabState = { registered: false, error: null };

		/**
		 * The tab's chip title in the right sidebar's strip.
		 * @returns the title node.
		 */
		function SerialDebuggerTabTitle() {
			return h("span", { style: { whiteSpace: "nowrap" } }, tc("tabTitle"));
		}

		/**
		 * Register the panel as a native right-sidebar tab type with a guide row.
		 *
		 * The guide is the right column's own empty state: one row per registered
		 * type, and clicking a row opens that type's tab.
		 *
		 * ORDERING IS THE WHOLE TRICK HERE. The native seat declares
		 * `sidebar.right.pane.tab` BEFORE it provides `sidebarRightTabs`, so a
		 * registration triggered by the slot DECLARATION reads the service as
		 * missing and installs nothing — permanently, because the declaration never
		 * collapses. Waiting on the SERVICE through `ctx.inject` is the lifecycle
		 * these registrations need: the body re-runs whenever the service appears or
		 * is replaced.
		 *
		 * @param ctx - client plugin context.
		 * @returns the injection handle whose `dispose()` releases every registration.
		 */
		function registerRightSidebarTab(ctx) {
			return ctx.inject(["sidebarRightTabs"], (scoped) => {
				const tabs = scoped.get("sidebarRightTabs");
				if (tabs === undefined) return undefined;

				// The type is in the registry the moment `register` returns, so a later
				// slot failure must release it here — otherwise the id stays taken for
				// the rest of the page's life and the kind renders a dead tab forever.
				const disposers = [];
				const release = () => {
					for (const dispose of disposers.reverse()) {
						try {
							dispose();
						} catch {
							// Already released.
						}
					}
				};

				try {
					disposers.push(
						tabs.register({
							id: TAB_TYPE_ID,
							kind: TAB_KIND,
							title: () => tc("tabTitle"),
							guide: [
								{
									id: TAB_KIND,
									order: 30,
									title: () => tc("tabTitle"),
									description: () => tc("guideDescription"),
									icon: (iconProps) => h(SerialDebuggerIcon, { size: (iconProps && iconProps.size) || 16 }),
								},
							],
						}),
					);
					disposers.push(
						ctx.slots.inject("sidebar.right.pane.tab", () =>
							ctx.slots.register({ name: "sidebar.right.pane.tab", key: TAB_TYPE_ID }, SerialDebuggerPage),
						),
					);
					disposers.push(
						ctx.slots.inject("sidebar.right.pane.tab.title", () =>
							ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: TAB_TYPE_ID }, SerialDebuggerTabTitle),
						),
					);
				} catch (error) {
					release();
					rightTabState.registered = false;
					rightTabState.error = String((error && error.message) || error);
					throw error;
				}
				rightTabState.registered = true;
				rightTabState.error = null;
				return release;
			});
		}

		// ── plugin ───────────────────────────────────────────────────────────

		/** Only the slot registry is required; both target slots are injected. */
		const inject = ["slots"];

		/**
		 * Best-effort mount diagnostic posted to the host route.
		 *
		 * The page is the only place that can see whether the right sidebar's tab type
		 * registered and whether its guide drew a row, and it has no other channel to
		 * say so — so this reports it through `GET /state`. Failures are swallowed: a
		 * diagnostic must never affect the plugin.
		 *
		 * @param ctx - client plugin context.
		 */
		function reportMount(ctx) {
			try {
				if (typeof document === "undefined") return;
				const payload = { at: Date.now(), href: String(location && location.href) };
				payload.rightTab = { registered: rightTabState.registered, error: rightTabState.error };
				try {
					const guide = document.querySelector("[data-sidebar-right-guide]");
					payload.rightGuide = guide === null
						? null
						: {
							rows: Array.from(guide.querySelectorAll("button")).map((row) => (row.textContent || "").trim().slice(0, 40)),
							hasMine: (guide.textContent || "").includes("串口调试"),
						};
				} catch (error) {
					payload.guideError = String((error && error.message) || error);
				}
				try {
					payload.settingsEntry = document.querySelector('[aria-label="串口调试"]') !== null;
				} catch (error) {
					payload.domError = String((error && error.message) || error);
				}
				fetch(BASE + "/report", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload),
				}).catch(() => {});
			} catch {
				// A diagnostic must never break the plugin.
			}
		}

		/**
		 * Mount the panel as a native right-sidebar tab type.
		 *
		 * The right column's guide lists the type and picking the row opens the
		 * debugger in the column. It is the plugin's only surface: a Settings page
		 * used to duplicate it, which put the same instrument in two places.
		 *
		 * @param ctx - client plugin context.
		 */
		function apply(ctx) {
			// The host's own language decides the default; the header switch overrides
			// it and persists its choice. Read the service through ctx.get because a
			// deployment without it must still mount the panel.
			const localeService = typeof ctx.get === "function" ? ctx.get("locale") : undefined;
			let hostActive = "zh";
			if (localeService !== undefined && typeof localeService.getLocale === "function") {
				try {
					hostActive = localeService.getLocale().active;
				} catch {
					// An unreadable snapshot keeps the Chinese default.
				}
			}
			hostLocale = normalizeLocale(hostActive);
			activeLocale = storedLocale() ?? hostLocale;

			const seat = registerRightSidebarTab(ctx);
			ctx.effect(() => () => {
				if (seat !== undefined && typeof seat.dispose === "function") seat.dispose();
			}, "serial-debugger: right sidebar tab type");

			// Sample a few times so the reported state is the settled one, not whatever
			// the first paint happened to catch.
			for (const delay of [2500, 6000, 12000, 20000]) setTimeout(() => reportMount(ctx), delay);
		}

		exports.TAB_TYPE_ID = TAB_TYPE_ID;
		exports.TAB_KIND = TAB_KIND;
		exports.MESSAGES = MESSAGES;
		exports.HELP_KEYS = HELP_KEYS;
		exports.helpContent = splitHelpLine;
		exports.translate = translate;
		exports.normalizeLocale = normalizeLocale;
		exports.groupRows = groupRows;
		exports.formatRow = formatRow;
		exports.SerialDebuggerPage = SerialDebuggerPage;
		exports.SerialDebuggerIcon = SerialDebuggerIcon;
		exports.SerialDebuggerTabTitle = SerialDebuggerTabTitle;
		exports.registerRightSidebarTab = registerRightSidebarTab;
		exports.encodeSend = encodeSend;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});

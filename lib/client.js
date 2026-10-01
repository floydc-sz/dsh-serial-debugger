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

		// ── controls ─────────────────────────────────────────────────────────

		/**
		 * Geometry of the reference serial assistant: dense 24px controls, arranged in
		 * three stacked bands — parameters, receive, send.
		 */
		const ROW_HEIGHT = 24;

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
						fontSize: 12,
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
		 * One retained log entry as display text, shared by the receive area and
		 * 保存窗口 so a saved log reads exactly like the screen.
		 * @param line - a host log entry.
		 * @param hexView - render payloads as hex instead of text.
		 * @param showTime - prefix each entry with its arrival time.
		 * @returns the display string.
		 */
		function formatLine(line, hexView, showTime) {
			const stamp = showTime
				? new Date(line.at).toLocaleTimeString("zh-CN", { hour12: false }) + "." + String(line.at % 1000).padStart(3, "0") + " "
				: "";
			if (line.b64 !== undefined) {
				const bytes = b64ToBytes(line.b64);
				const body = hexView ? bytesToHex(bytes) : bytesToText(bytes);
				return stamp + (line.kind === "tx" ? "→ " : "") + body;
			}
			return stamp + (line.kind === "err" ? "! " : "· ") + (line.text === undefined ? "" : line.text);
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
			const [tab, setTab] = useState("single");
			const [busy, setBusy] = useState("");
			const [problem, setProblem] = useState(null);
			const [counts, setCounts] = useState({ rx: 0, tx: 0 });
			const [progress, setProgress] = useState(null);

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
						if (failures <= 3) setProblem(`无法连接串口宿主: ${error.message}`);
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
					setProblem(`枚举串口失败: ${error.message}`);
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
					const text = lines.map((line) => formatLine(line, hexView, showTime)).join("\n");
					const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
					const url = URL.createObjectURL(blob);
					const anchor = document.createElement("a");
					anchor.href = url;
					anchor.download = `serial-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
					anchor.click();
					setTimeout(() => URL.revokeObjectURL(url), 2000);
				} catch (error) {
					setProblem(`保存失败: ${error.message}`);
				}
			}, [hexView, lines, showTime]);

			/** Stage a file for 发送文件 (read up front so the send loop stays simple). */
			const chooseFile = useCallback(async (event) => {
				const file = event.target.files && event.target.files[0];
				event.target.value = "";
				if (!file) return;
				if (file.size > 4 * 1024 * 1024) {
					setProblem("文件过大：单次上限 4 MB");
					return;
				}
				try {
					const buffer = await file.arrayBuffer();
					fileJob.current = { bytes: new Uint8Array(buffer), sent: 0, name: file.name };
					setProgress(0);
					setProblem(null);
				} catch (error) {
					setProblem(`读取文件失败: ${error.message}`);
				}
			}, []);

			const sendFile = useCallback(async () => {
				const job = fileJob.current;
				if (job === null || job === undefined) {
					setProblem("请先用「打开文件」选择要发送的文件");
					return;
				}
				if (!status.connected) {
					setProblem("请先打开串口");
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
					setProblem(fileStop.current ? "文件发送已停止" : `文件发送完成：${job.bytes.length} 字节`);
				} catch (error) {
					setProblem(`文件发送失败: ${error.message}`);
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
				: "未打开串口";
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
					{ style: { display: "flex", flexWrap: "wrap", columnGap: 10, rowGap: 7, alignItems: "center" } },
					h(Field, { label: "串口选择", width: 214 },
						portControl,
						h(TinyButton, {
							onClick: refreshPorts,
							disabled: connected || busy !== "",
							title: "刷新串口列表",
							style: { flex: "none", padding: "0 6px" },
						}, busy === "ports" ? "…" : "刷新"),
					),
				),
				// Two rows of two, each pair sharing its line evenly. `flex: 1 1 0` plus a
				// row that cannot wrap keeps a pair together and aligns the two rows'
				// controls into one grid; every label sits beside its control.
				h(
					"div",
					{ style: { display: "flex", gap: 10, alignItems: "center" } },
					h(Field, { label: "波特率", flex: "1 1 0" },
						h(ComboBox, {
							value: String(form.baudRate),
							disabled: connected,
							onChange: (value) => setForm({ ...form, baudRate: Number(value) }),
							options: (BAUD_RATES.includes(Number(form.baudRate)) ? BAUD_RATES : BAUD_RATES.concat([Number(form.baudRate)]))
								.filter((rate) => Number.isFinite(rate))
								.map((rate) => ({ value: String(rate), label: String(rate) })),
						}),
					),
					h(Field, { label: "停止位", flex: "1 1 0" },
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
					h(Field, { label: "数据位", flex: "1 1 0" },
						h(ComboBox, {
							value: String(form.dataBits),
							disabled: connected,
							onChange: (value) => setForm({ ...form, dataBits: Number(value) }),
							options: DATA_BITS.map((item) => ({ value: String(item), label: String(item) })),
						}),
					),
					h(Field, { label: "校验位", flex: "1 1 0" },
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
					h(Field, { label: "串口操作", width: 168 },
						h(TinyButton, {
							onClick: togglePort,
							disabled: busy === "port" || (!connected && form.port === ""),
							tone: connected ? "danger" : "primary",
							style: { width: "100%" },
						}, busy === "port" ? "处理中…" : connected ? "关闭串口" : "打开串口"),
					),
					h(TinyButton, { onClick: saveWindow, disabled: lines.length === 0 }, "保存窗口"),
					h(TinyButton, { onClick: clearReceive, disabled: lines.length === 0, tone: "danger" }, "清除接收"),
					status.lastError !== null && status.lastError !== undefined
						? h("span", {
							title: status.lastError,
							style: { fontSize: 11, color: COLORS.error, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140 },
						}, "有错误")
						: null,
				),
				h(
					"div",
					{ style: { display: "flex", flexWrap: "wrap", columnGap: 12, rowGap: 5, alignItems: "center" } },
					h(Check, { checked: hexView, onChange: setHexView, label: "16进制显示" }),
					h(Check, { checked: form.dtr, onChange: (value) => setForm({ ...form, dtr: value }), disabled: connected, label: "DTR" }),
					h(Check, { checked: form.rts, onChange: (value) => setForm({ ...form, rts: value }), disabled: connected, label: "RTS" }),
					h(Check, { checked: autoScroll, onChange: setAutoScroll, label: "自动滚动" }),
					h(Check, { checked: showTime, onChange: setShowTime, label: "时间戳" }),
				),
			);

			// ── band 2: receive ───────────────────────────────────────────────
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
						fontSize: 12,
						lineHeight: "17px",
						background: COLORS.bg,
						border: `1px solid ${COLORS.border}`,
						borderRadius: 3,
						whiteSpace: "pre-wrap",
						wordBreak: "break-all",
					},
				},
				lines.length === 0
					? h("span", { style: { color: COLORS.labelSecondary } }, connected ? "等待数据…" : "选择串口参数后点击「打开串口」开始接收数据。")
					: lines.map((line, index) =>
						h(
							"div",
							{ key: line.seq === undefined ? index : line.seq, style: { color: line.kind === "err" ? COLORS.error : line.kind === "tx" ? COLORS.labelSecondary : COLORS.label } },
							formatLine(line, hexView, showTime),
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
				h("span", null, `接收 ${counts.rx} B`),
				h("span", null, `发送 ${counts.tx} B`),
				h("span", null, `${lines.length} 条`),
				!status.ready ? h("span", { style: { color: COLORS.warn } }, "串口宿主启动中…") : null,
			);

			const receiveBand = h(
				"div",
				{ style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 4 } },
				receive,
				statusBar,
			);

			// ── band 3: send ──────────────────────────────────────────────────
			const tabButton = (id, label) => h(
				"button",
				{
					type: "button",
					onClick: () => setTab(id),
					style: {
						height: 24,
						padding: "0 10px",
						fontSize: 12,
						fontFamily: "inherit",
						color: COLORS.label,
						background: tab === id ? COLORS.bg : COLORS.bgLayer2,
						border: `1px solid ${COLORS.border}`,
						borderBottom: tab === id ? `1px solid ${COLORS.bg}` : `1px solid ${COLORS.border}`,
						borderRadius: "3px 3px 0 0",
						cursor: "pointer",
					},
				},
				label,
			);

			const tabStrip = h(
				"div",
				{ style: { display: "flex", gap: 2, alignItems: "flex-end", borderBottom: `1px solid ${COLORS.border}` } },
				tabButton("single", "单条发送"),
				tabButton("help", "帮助"),
			);

			const helpBody = h(
				"div",
				{
					style: {
						flex: "none",
						overflowY: "auto",
						padding: "8px 2px",
						fontSize: 12,
						lineHeight: "19px",
						color: COLORS.labelSecondary,
					},
				},
				h("div", null, "· 选择串口与参数后点「打开串口」；连接期间参数会锁定，避免热修改。"),
				h("div", null, "· 「16进制显示」把接收内容按字节显示；「时间戳」给每条数据加上到达时间。"),
				h("div", null, "· 「16进制发送」把输入解析为十六进制字节（AA 55 01 / 0xAA,0x55 均可）；「发送新行」在末尾追加 CRLF。"),
				h("div", null, "· 「定时发送」按下方周期重复发送当前内容；「发送文件」以 1 KB 分块发送，「停止发送」可中断。"),
				h("div", null, "· 「保存窗口」把接收区内容导出为 .txt。"),
				h("div", { style: { marginTop: 6, color: COLORS.warn } }, "· 接收与发送都按到达分块显示，不按行聚合。"),
			);

			const sendBody = h(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: 6, paddingTop: 6 } },
				h("div", { style: { display: "flex", gap: 6, alignItems: "stretch" } },
					h("textarea", {
						value: composer,
						placeholder: hexSend ? "AA 55 01 02（空格可选）" : "输入要发送的数据，Ctrl+Enter 发送",
						onChange: (event) => setComposer(event.target.value),
						onKeyDown: (event) => {
							if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
								event.preventDefault();
								if (connected && busy === "") doSend();
							}
						},
						rows: 3,
						style: {
							flex: 1,
							minWidth: 0,
							resize: "vertical",
							padding: "5px 6px",
							fontSize: 12,
							fontFamily: MONO,
							lineHeight: "17px",
							color: COLORS.label,
							background: COLORS.bg,
							border: `1px solid ${COLORS.border}`,
							borderRadius: 3,
							outline: "none",
						},
					}),
					h("div", { style: { display: "flex", flexDirection: "column", gap: 6, width: 84, flex: "none" } },
						h(TinyButton, { onClick: doSend, disabled: !connected || busy === "send" || composer === "", tone: "primary", style: { flex: 1 } }, busy === "send" ? "…" : "发送"),
						h(TinyButton, { onClick: clearSend, disabled: composer === "", tone: "danger", style: { flex: 1 } }, "清除发送"),
					),
				),
				h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
					h(Check, { checked: timedSend, onChange: setTimedSend, disabled: !connected, label: "定时发送" }),
					h("span", { style: { fontSize: 12, color: COLORS.label } }, "周期:"),
					h("input", {
						type: "number",
						min: 20,
						value: period,
						disabled: !connected,
						onChange: (event) => setPeriod(event.target.value === "" ? "" : Number(event.target.value)),
						style: { ...numberStyle, width: 74 },
					}),
					h("span", { style: { fontSize: 12, color: COLORS.label } }, "ms"),
					h("span", { style: { flex: 1 } }),
					h(TinyButton, { onClick: () => { const node = fileInput.current; if (node !== null && node !== undefined) node.click(); } }, "打开文件"),
					h(TinyButton, { onClick: sendFile, disabled: !connected || busy === "file" }, busy === "file" ? "发送中…" : "发送文件"),
					h(TinyButton, { onClick: stopSending, disabled: busy !== "file" && !timedSend, tone: "danger" }, "停止发送"),
				),
				h("div", { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } },
					h(Check, { checked: hexSend, onChange: setHexSend, label: "16进制发送" }),
					h(Check, { checked: newline, onChange: setNewline, label: "发送新行" }),
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
				tabStrip,
				tab === "single" ? sendBody : helpBody,
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
			return h("span", { style: { whiteSpace: "nowrap" } }, "串口调试");
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
							title: () => "串口调试",
							guide: [
								{
									id: TAB_KIND,
									order: 30,
									title: () => "串口调试",
									description: () => "串口参数、接收显示与数据发送",
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

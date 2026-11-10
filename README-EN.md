# dsh-serial-debugger

[中文](README.md) ｜ **English**

A serial-port debugger plugin for DeepSeek Harness. It puts a complete serial monitor/debug panel inside the DSH interface: **port parameter setup**, **live receive display**, and **data sending**.

- npm package: `dsh-serial-debugger`
- Repository: <https://github.com/floydc-sz/dsh-serial-debugger>
- Platform: **Windows only**

---

## Interface

The plugin's UI lives in the **Harness main window's right sidebar**, as a native tab.

1. Click **「打开侧边栏/Open sidebar」** in the title bar to open the right sidebar;
2. The right sidebar's guide page (its empty state) lists the tab types you can open, and one row is **「串口调试/Serial debugger」**;
3. Click that row and the serial debugger opens in the right column (the tab is labelled 「串口调试/Serial debugger」).

| Surface | Capability |
| --- | --- |
| Parameters | The **「串口选择/Port」** dropdown shows each device as `COM3:USB-SERIAL CH340`, including a **device description**, and **「刷新/Refresh」** re-enumerates; when nothing can be enumerated it falls back to a free-text field. **「波特率/Baud rate」**, **「停止位/Stop bits」**, **「数据位/Data bits」** and **「校验位/Parity」** dropdowns. **「串口操作/Port action」** opens and closes the port, and the parameters lock while connected. |
| Actions and switches | **「保存窗口/Save window」** exports the receive area to a .txt file; **「清除接收/Clear receive」**; **「16进制显示/Hex display」**, **「DTR」**, **「RTS」**, **「自动滚动/Auto-scroll」**, **「时间戳/Timestamps」**. |
| Receive area | Fills the remaining height and appends data live, in text or hex view, with optional timestamps and auto-scroll (which pauses itself when you scroll up by hand). Sent data is shown dimmed with a `→` prefix, and a status line along the bottom shows the connection indicator, the current parameters, the send/receive byte counts and the entry count. |
| Send area | **「单条发送/Single send」** / **「帮助/Help」** tabs; a send box (`Ctrl+Enter` sends) plus **「发送/Send」** and **「清除发送/Clear send」**. |
| Send options | **「定时发送/Timed send」** plus a period in milliseconds; **「打开文件/Open file」**, **「发送文件/Send file」** and **「停止发送/Stop sending」** — 1 KB chunks with a progress percentage; **「16进制发送/Hex send」** (which accepts both `AA 55 01` and `0xAA,0x55`); **「发送新行/Append newline」** (which adds CRLF). |
| Language | The switch on the **same row as 「串口选择/Port」** (top of the parameters band, at its right end) toggles the whole surface between **中文** and **English**; the choice is remembered, and with no choice made it follows the language DSH itself runs in. |

Colors and fonts come from DSH theme tokens, so the panel follows the host's light and dark themes.

## Installation

```powershell
dsh plugin --profile desktop add dsh-serial-debugger
```

You can also install from a local directory (`<path-to-this-package>` is this repository checked out on disk):

```powershell
dsh plugin --profile desktop add <path-to-this-package>
```

After installing, restart DSH or let HMR apply, then open the panel as described under **Interface** above.

### Requirements

- **Windows.** The serial bridge uses .NET's `System.IO.Ports`, provided by the **Windows PowerShell 5.1** that ships with Windows, so there is nothing extra to install (verified on 5.1).
- **DSH `^0.2.0-rc.1`** (see `dsh.engines.dsh` in `package.json`).
- No npm dependencies, no native compilation, no build step.

## Release Notes

### 1.0.4 · 2026-11-10

- Moved the language switch from its own row at the top of the surface onto the port row, sharing the line with **「串口选择/Port」** at its right end — one row of height saved.

### 1.0.3 · 2026-11-10

- New **language switch** at the top right of the surface: it toggles the whole surface between 中文 and English, and the choice is remembered. With no choice made it follows the language DSH itself runs in.
- The tab label and the right sidebar's guide entry follow the same switch.
- Every string in the panel (parameters, buttons, checkboxes, placeholders, status line, help page, error messages) now resolves through one dictionary.

### 1.0.2 · 2026-11-10

- Added [README-EN.md](README-EN.md); both READMEs gained a language link at the top.
- `README-EN.md` joined `files`, so it ships in the npm package.

### 1.0.1 · 2026-11-10

- Corrected the requirements: the serial bridge is provided by the **Windows PowerShell 5.1** that ships with Windows (the previous text also claimed PowerShell 7).
- Trimmed the README down to what a plugin user needs.
- The test's hard-coded version literal became a semver shape check, so releases no longer have to edit tests.

### 1.0.0 · 2026-11-10

- First release: port parameter setup, live text/hex receive display, and data sending (timed send and file send included).

## License

MIT, see [LICENSE](LICENSE).

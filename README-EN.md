# dsh-serial-debugger

[中文](README.md) ｜ **English**

A serial-port debugger plugin for DeepSeek Harness. It puts a complete serial monitor/debug panel inside the DSH interface: **port parameter setup**, **live receive display**, and **data sending**.

- npm package: `dsh-serial-debugger`
- Repository: <https://github.com/floydc-sz/dsh-serial-debugger>
- Platform: **Windows / Linux** (Ubuntu 20.04 and later)

---

## Interface

The plugin's UI lives in the **Harness main window's right sidebar**, as a native tab.

1. Click **「打开侧边栏/Open sidebar」** in the title bar to open the right sidebar;
2. The right sidebar's guide page (its empty state) lists the tab types you can open, and one row is **「串口调试/Serial debugger」**;
3. Click that row and the serial debugger opens in the right column (the tab is labelled 「串口调试/Serial debugger」).

| Surface | Capability |
| --- | --- |
| Parameters · first row | The **「串口选择/Port」** dropdown shows each device with its description (`COM3:USB-SERIAL CH340` on Windows, `/dev/ttyUSB0:FTDI` on Linux), and **「刷新/Refresh」** re-enumerates; when nothing enumerates it falls back to a free-text field. The right end of the same row holds **「语言/Language」** and **「帮助/Help」**. |
| Parameters · values | **「波特率/Baud rate」**, **「停止位/Stop bits」**, **「数据位/Data bits」** and **「校验位/Parity」**, in two rows of two, each name beside its control. |
| Parameters · actions | **「串口操作/Port action」** opens or closes the port and locks the parameters while connected; **「保存窗口/Save window」** exports the receive area to .txt; **「清除接收/Clear receive」** empties it. |
| Parameters · switches | **「16进制显示/Hex display」**, **「DTR」**, **「RTS」**, **「自动滚动/Auto-scroll」**, **「时间戳/Timestamps」**. |
| Receive area | Fills the remaining height; **data that arrives in pieces is merged into one line**, and only newlines in the data break lines. Sent data is shown dimmed with a `→` prefix, and a status line shows the connection, the parameters, the byte counts and the line count. |
| Send area · input | The composer is five rows tall at 13px, `Ctrl+Enter` sends, and **「发送/Send」** / **「清除发送/Clear send」** sit beside it. |
| Send area · switches | **Above** the composer: **「16进制发送/Hex send」** (accepts `AA 55 01` and `0xAA,0x55`), **「发送新行/Append newline」**, **「定时发送/Timed send」** and its **「周期/Period」** in milliseconds. |
| Send area · files | **「打开文件/Open file」**, **「发送文件/Send file」** and **「停止发送/Stop sending」**, left-aligned, with the transfer progress bar and percentage on the same line. |
| Help | Opens a two-column table (control / what it does) with one entry per control, in the same order as the surface; close it with 「关闭/Close」 or by clicking the backdrop. |
| Language | The **「语言/Language」** dropdown switches the whole surface between 中文 and English; the choice is remembered, and with no choice made it follows the language DSH runs in. |

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
- **Linux (Ubuntu 20.04+).** There is no `System.IO.Ports` in the box, so the bridge drives the [`serialport`](https://www.npmjs.com/package/serialport) native binding. It is **not a dependency of this package and is not installed automatically**: a native module needs to run a build script, DSH blocks those by default, and declaring it makes every update fail. Install it once:

  ```bash
  dsh plugin --profile <your profile> add serialport
  ```

  If pnpm reports `ERR_PNPM_IGNORED_BUILDS`, allow the build script of `@serialport/bindings-cpp` and reinstall — DSH's notice offers exactly that. **Windows needs none of this and is unaffected**, because its bridge is PowerShell.
- **Prebuilt or compiled.** `serialport` ships prebuilt binaries; where none exists it compiles locally and needs `build-essential` and `python3`.
- **Custom binding.** `DSH_SERIAL_MODULE` can point at another implementation of the same `SerialPort` surface, for offline deployments or a replacement.
- **Serial permissions.** A regular user cannot open `/dev/ttyUSB*` or `/dev/ttyACM*` by default. Add yourself to the serial group and **log back in**:

  ```bash
  sudo usermod -aG dialout $USER    # Ubuntu / Debian / Fedora
  sudo usermod -aG uucp    $USER    # Arch
  ```

  Without that, opening the port reports exactly this rather than a bare `EACCES`.
- **DSH `^0.2.0-rc.1`** (see `dsh.engines.dsh` in `package.json`).
- No build step: the client half is a prebuilt artifact and both bridge scripts ship in the package.

## Release Notes

### 1.1.2 · 2026-11-11

- Receive area: **chunks that arrive in pieces are merged into one line**, and only newlines in the data break lines (each chunk used to get its own line, which read as random line breaks). Multi-byte characters split across chunks no longer break into replacement characters.
- Timestamps: with the switch on, **every line** carries the time it started arriving instead of the block carrying one time, and the bytes are still joined before decoding so CJK stays intact.
- Both text wells: a stronger border, 12 → 13px type, and the composer grows from three rows to five.
- Send band: 「16进制发送」, 「发送新行」, 「定时发送」 and 「周期」 moved **above** the composer; the file buttons and the progress bar now share one left-aligned line.
- Parameters: the language switch shares the port row, 「帮助」 moved to the right of it, the port selector takes a third of the row, and the action buttons are a fixed 86px with 帮助 at 57px.
- Help is an overlay holding a two-column table (control / what it does), one entry per control, in on-screen order, with a centred tinted header.

### 1.1.1 · 2026-11-11

- **Fixed: 1.1.0 could not be updated to on Windows.** `serialport` had been declared as a dependency, and it carries a native build script. DSH blocks dependency build scripts by default (`ERR_PNPM_IGNORED_BUILDS`), so pnpm aborted the whole update — even though Windows uses the PowerShell bridge and never loads that package. The dependency is **no longer declared**.
- Linux users install the binding themselves once (see Requirements), allowing the `@serialport/bindings-cpp` build script where pnpm asks.
- The missing-binding message now names the exact command: `dsh plugin --profile <profile> add serialport`.

### 1.1.0 · 2026-11-11

- **Linux support** (Ubuntu 20.04 and later). Linux has no `System.IO.Ports`, so a Node bridge — `lib/serial-helper.mjs` — drives the `serialport` native binding instead. **Windows keeps the original PowerShell bridge; nothing changes there.**
- The backend is chosen by platform: a `DSH_SERIAL_HELPER` pointing at `.mjs`/`.js` runs on the current Node, anything else goes to PowerShell on Windows. That makes the backend swappable, and means the test double no longer has to be PowerShell.
- Linux specifics: `/dev/ttyS*` legacy ports are filtered out, `EACCES` becomes an actionable "join the `dialout`/`uucp` group" message, and 1.5 stop bits is refused with a reason (termios has no such setting).
- The `os` field no longer restricts to Windows; `serialport` is an `optionalDependencies` entry and reports how to install itself if it is missing, instead of crashing.
- The test runner is now `tools/run-tests.mjs` (cross-platform); `run-tests.ps1` and `run-tests.sh` are thin shims.

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
